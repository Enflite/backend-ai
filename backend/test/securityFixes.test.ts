import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  // Mirror withTenantTx: run the callback with (session, db, tenantId)
  const withTenantTxMock = vi.fn(async (tenantId: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) =>
    callback({}, await getDbMock(), tenantId));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock, withTenantTx: withTenantTxMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/documents/queue.js', () => ({ enqueueIngestion }));

const testAuth = vi.hoisted(() => ({
  current: {
    userId: 'owner-1',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'owner@example.test',
    displayName: 'Owner',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['document:read', 'document:classify'],
  } as Record<string, unknown>,
}));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = testAuth.current;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { documentRoutes } from '../src/documents/routes.js';
import { AppError } from '../src/errors.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

const DOC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT = '22222222-2222-4222-8222-222222222222';

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'deleteOne', 'deleteMany']) {
      coll[m].mockReset();
      if (m === 'findOne') coll[m].mockResolvedValue(null);
      else if (m === 'findOneAndUpdate') coll[m].mockResolvedValue(null);
      else if (m === 'updateOne' || m === 'updateMany') coll[m].mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
      else if (m === 'insertOne') coll[m].mockResolvedValue({ acknowledged: true });
      else if (m === 'deleteOne' || m === 'deleteMany') coll[m].mockResolvedValue({ deletedCount: 1 });
    }
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  withTenantTxMock.mockClear();
  withTenantTxMock.mockImplementation(async (tenantId: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) =>
    callback({}, await getDbMock(), tenantId));
}

function mkDoc(overrides: any = {}) {
  return {
    _id: DOC_ID,
    tenantId: TENANT,
    ownerId: 'owner-1',
    classification: 'CONFIDENTIAL',
    status: 'READY',
    deletedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function mockDocLookup(classification: string, ownerId: string, hasGrant = false) {
  const docsColl = getMockCollection('documents');
  const permsColl = getMockCollection('document_permissions');

  // Current document lookup
  docsColl.findOne.mockImplementation(async (filter: any) => {
    if (filter._id === DOC_ID) {
      return mkDoc({ classification, ownerId });
    }
    return null;
  });

  // Grant check: return a grant document if hasGrant is true
  permsColl.findOne.mockImplementation(async (filter: any) => {
    if (filter.documentId === DOC_ID && hasGrant) {
      return { _id: 'grant-1', tenantId: TENANT, documentId: DOC_ID };
    }
    return null;
  });

  // principalOrConditions: department_memberships and security_group_memberships return empty
  getMockCollection('department_memberships').find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue([]),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));
  getMockCollection('security_group_memberships').find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue([]),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    skip: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));

  // Update returns the updated document
  docsColl.findOneAndUpdate.mockImplementation(async (filter: any, update: any) => {
    return mkDoc({ classification: update.$set.classification, ownerId, status: 'PENDING' });
  });
}

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  vi.clearAllMocks();
  resetMocks();
  testAuth.current = {
    userId: 'owner-1',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'owner@example.test',
    displayName: 'Owner',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['document:read', 'document:classify'],
  };
  enqueueIngestion.mockResolvedValue('job-1');
  app = Fastify();
  // Mirror server.ts's AppError mapping so code assertions match production.
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await app.register(documentRoutes);
});

describe('PATCH /documents/:id/classification authorization', () => {
  it('rejects reclassification by a non-owner without tenant:manage', async () => {
    mockDocLookup('CONFIDENTIAL', 'someone-else');
    testAuth.current.userId = 'intruder-1';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('DOCUMENT_RECLASSIFY_FORBIDDEN');
  });

  it('allows reclassification by a non-owner holding an explicit document grant', async () => {
    mockDocLookup('INTERNAL', 'someone-else', true);
    testAuth.current.userId = 'collaborator-1';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
  });

  it('sends the caller identity into the grant check like the document GET route', async () => {
    mockDocLookup('INTERNAL', 'someone-else');
    testAuth.current.userId = 'collaborator-1';
    await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    const permsColl = getMockCollection('document_permissions');
    const lookup = permsColl.findOne.mock.calls.find(([filter]: any[]) =>
      filter.documentId === DOC_ID);
    expect(lookup).toBeDefined();
    // The grant check includes tenantId and the principal $or conditions
    // containing the caller's userId.
    const [filter] = lookup!;
    expect(filter.tenantId).toBe(TENANT);
    expect(filter.documentId).toBe(DOC_ID);
    expect(filter.canRead).toBe(true);
    expect(JSON.stringify(filter.$or)).toContain('collaborator-1');
  });

  it('allows reclassification by a tenant manager who is not the owner', async () => {
    mockDocLookup('INTERNAL', 'someone-else');
    testAuth.current.userId = 'manager-1';
    testAuth.current.permissions = ['document:read', 'document:classify', 'tenant:manage'];
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
  });

  it('rejects when the caller cannot read the current classification', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    testAuth.current.clearance = 'INTERNAL';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'INTERNAL', confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CLASSIFICATION_DENIED');
  });

  it('requires explicit confirmation for downgrades', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('records the previous classification in the audit event', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DOCUMENT_CLASSIFICATION_CHANGED',
        classification: 'PUBLIC',
        metadata: { previousClassification: 'CONFIDENTIAL' },
      })
    );
  });
});

describe('list pagination', () => {
  it('passes bounded limit/offset to the documents query', async () => {
    const docsColl = getMockCollection('documents');
    docsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    // grantedDocumentIds needs these
    getMockCollection('document_permissions').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    getMockCollection('department_memberships').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    getMockCollection('security_group_memberships').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));

    const response = await app.inject({ method: 'GET', url: '/documents?limit=10&offset=20' });
    expect(response.statusCode).toBe(200);
    const chain = docsColl.find.mock.results[0]!.value;
    expect(chain.skip).toHaveBeenCalledWith(20);
    expect(chain.limit).toHaveBeenCalledWith(10);
    expect(response.json().pagination).toEqual({ limit: 10, offset: 20 });
  });

  it('rejects limit above the server maximum', async () => {
    const response = await app.inject({ method: 'GET', url: '/documents?limit=500' });
    expect(response.statusCode).toBe(400);
  });
});
