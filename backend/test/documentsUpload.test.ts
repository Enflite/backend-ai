import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { MongoServerError } from 'mongodb';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));
const { s3Storage } = vi.hoisted(() => ({
  s3Storage: { put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/documents/queue.js', () => ({ enqueueIngestion }));
vi.mock('../src/storage/storage.js', () => ({ s3Storage }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: 'uploader-1',
      tenantId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'uploader@example.test',
      displayName: 'Uploader',
      roleName: 'User',
      clearance: 'CONFIDENTIAL',
      permissions: ['document:upload', 'document:classify'],
    };
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { documentRoutes } from '../src/documents/routes.js';
import { AppError } from '../src/errors.js';

const BOUNDARY = '----testboundary';

function multipartFile(filename: string, content: string): Buffer {
  return Buffer.from(
    `--${BOUNDARY}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      'Content-Type: text/plain\r\n\r\n' +
      `${content}\r\n` +
      `--${BOUNDARY}--\r\n`
  );
}

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      insertMany: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'insertMany', 'deleteMany']) {
      coll[m].mockReset();
    }
    coll.find.mockReset();
    coll.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    coll.aggregate.mockReset();
    coll.aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    coll.findOne.mockResolvedValue(null);
    coll.findOneAndUpdate.mockResolvedValue(null);
    coll.insertOne.mockResolvedValue({ acknowledged: true });
    coll.insertMany.mockResolvedValue({ acknowledged: true });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

async function app() {
  const fastify = Fastify();
  await fastify.register(multipart, { limits: { files: 1, fileSize: 1024 * 1024, fields: 10 } });
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(documentRoutes);
  return fastify;
}

function duplicateKeyError(): MongoServerError {
  // MongoDB duplicate-key error on the UNIQUE (tenantId, checksumSha256) index.
  const error = new MongoServerError({ message: 'E11000 duplicate key error', code: 11000 } as any);
  (error as any).code = 11000;
  (error as any).keyPattern = { tenantId: 1, checksumSha256: 1 };
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  recordAudit.mockResolvedValue(undefined);
  enqueueIngestion.mockResolvedValue('job-1');
  s3Storage.put.mockResolvedValue(undefined);
  s3Storage.delete.mockResolvedValue(undefined);
});

describe('POST /documents duplicate checksum', () => {
  it('returns 409 DUPLICATE_DOCUMENT on duplicate (tenantId, checksumSha256) instead of 500', async () => {
    const documentsColl = getMockCollection('documents');
    documentsColl.insertOne.mockRejectedValue(duplicateKeyError());
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartFile('notes.txt', 'same content'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_DOCUMENT');
    // The orphaned object upload is cleaned up.
    expect(s3Storage.delete).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('returns 409 when the duplicate key is on checksumSha256 (any index name)', async () => {
    const documentsColl = getMockCollection('documents');
    const error = new MongoServerError({ message: 'E11000 duplicate key error', code: 11000 } as any);
    (error as any).code = 11000;
    (error as any).keyPattern = { checksumSha256: 1 };
    documentsColl.insertOne.mockRejectedValue(error);
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartFile('notes.txt', 'same content'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('DUPLICATE_DOCUMENT');
    await fastify.close();
  });

  it('still returns 201 for a genuinely new file', async () => {
    const documentsColl = getMockCollection('documents');
    documentsColl.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'doc-1' });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartFile('notes.txt', 'brand new content'),
    });
    expect(res.statusCode).toBe(201);
    // The route generates a UUID for the document ID; verify structure, not the exact value.
    expect(res.json().document.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(res.json().document.status).toBe('PENDING');
    // Verify the inserted document has the required MongoDB fields.
    const insertedDoc = documentsColl.insertOne.mock.calls[0][0];
    expect(insertedDoc.tenantId).toBe('22222222-2222-4222-8222-222222222222');
    expect(insertedDoc.checksumSha256).toBeDefined();
    expect(insertedDoc.status).toBe('PENDING');
    await fastify.close();
  });
});
