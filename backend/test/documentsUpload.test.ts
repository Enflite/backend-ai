import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));
const { s3Storage } = vi.hoisted(() => ({
  s3Storage: { put: vi.fn(), delete: vi.fn() },
}));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
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

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
  enqueueIngestion.mockResolvedValue('job-1');
  s3Storage.put.mockResolvedValue(undefined);
  s3Storage.delete.mockResolvedValue(undefined);
});

describe('POST /documents duplicate checksum', () => {
  it('returns 409 DUPLICATE_DOCUMENT on UNIQUE(tenant_id, checksum_sha256) instead of 500', async () => {
    tenantQuery.mockRejectedValue(
      Object.assign(new Error('duplicate key value violates unique constraint "documents_tenant_id_checksum_sha256_key"'), {
        code: '23505',
        constraint: 'documents_tenant_id_checksum_sha256_key',
      })
    );
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

  it('returns 409 even when the constraint name only contains "checksum"', async () => {
    tenantQuery.mockRejectedValue(
      Object.assign(new Error('duplicate key'), { code: '23505', constraint: 'uq_documents_checksum' })
    );
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
    tenantQuery.mockResolvedValue({
      rows: [{ id: 'doc-1', classification: 'INTERNAL', status: 'PENDING' }],
      rowCount: 1,
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/documents',
      headers: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` },
      payload: multipartFile('notes.txt', 'brand new content'),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().document.id).toBe('doc-1');
    await fastify.close();
  });
});
