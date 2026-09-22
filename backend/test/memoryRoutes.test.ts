/**
 * memoryRoutes.test.ts — /api/v1/memory CRUD routes.
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - Unauthenticated requests get 401 (requireAuth enforced).
 *  - Requests without the memory:* permission get 403 (real
 *    requirePermission, not a pass-through).
 *  - Every store call carries the caller's tenantId/userId: a caller in
 *    tenant A produces queries that can only touch tenant A documents.
 *  - CRUD happy paths, validation rejections, and MEMORY_NOT_FOUND
 *    handling; security-relevant actions are audited.
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL MONGODB ATLAS:
 *  - Live enforcement of the mandatory tenantId filter on every query.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: { value: null as any },
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: (err?: Error) => void) => {
    if (!currentAuth.value) {
      done(Errors.unauthorized('MISSING_TOKEN', 'Authorization header with Bearer <redacted> required'));
      return;
    }
    req.auth = currentAuth.value;
    done();
  },
}));
// Real permission enforcement: 403s are exercised for real.
vi.mock('../src/authz/middleware.js', async (importOriginal) => importOriginal());

import { memoryRoutes } from '../src/memory/routes.js';
import { AppError, Errors } from '../src/errors.js';
import type { AuthContext } from '../src/authz/permissions.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';

function authFor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: USER_A1,
    tenantId: TENANT_A,
    sessionId: 'a1000000-0000-4000-8000-000000000000',
    roleId: 'aa000000-0000-4000-8000-000000000000',
    email: 'a1@example.test',
    displayName: 'User A1',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['memory:read', 'memory:write'],
    ...overrides,
  };
}

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
}

function mkDoc(overrides: any = {}) {
  return {
    _id: 'm1',
    tenantId: TENANT_A,
    userId: USER_A1,
    fact: 'prefers tea',
    category: 'preference',
    classification: 'INTERNAL',
    source: 'user-stated',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

async function app() {
  const fastify = Fastify();
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(memoryRoutes, { prefix: '/api/v1' });
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  recordAudit.mockResolvedValue(undefined);
  currentAuth.value = authFor();
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    currentAuth.value = null;
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects callers without memory:read with 403', async () => {
    currentAuth.value = authFor({ permissions: [] });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });

  it('rejects callers without memory:write on POST with 403', async () => {
    currentAuth.value = authFor({ permissions: ['memory:read'] });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /memory', () => {
  it('creates a fact, scopes it to the caller, and audits it', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'prefers tea', category: 'preference' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().memory.fact).toBe('prefers tea');
    const coll = getMockCollection('memory_facts');
    const doc = coll.insertOne.mock.calls[0]![0];
    expect(doc.tenantId).toBe(TENANT_A);
    expect(doc.userId).toBe(USER_A1);
    expect(doc.fact).toBe('prefers tea');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_CREATE', tenantId: TENANT_A, userId: USER_A1 })
    );
    // resourceId is the generated _id
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: expect.any(String) })
    );
  });

  it('rejects empty or over-long facts with 400', async () => {
    const fastify = await app();
    const empty = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: '  ' } });
    expect(empty.statusCode).toBe(400);
    const long = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: 'x'.repeat(2001) } });
    expect(long.statusCode).toBe(400);
    const badCategory = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: 'x', category: 'nope' } });
    expect(badCategory.statusCode).toBe(400);
    expect(getMockCollection('memory_facts').insertOne).not.toHaveBeenCalled();
  });

  it('rejects classification above the caller clearance with 403', async () => {
    currentAuth.value = authFor({ clearance: 'PUBLIC' });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'x', classification: 'CONFIDENTIAL' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLASSIFICATION_DENIED');
  });

  it('rejects malformed ids with 400', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /memory', () => {
  it('lists only the caller’s facts (tenant+user scoped)', async () => {
    const coll = getMockCollection('memory_facts');
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([mkDoc()]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory?category=preference&limit=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json().memories).toHaveLength(1);
    const [filter] = coll.find.mock.calls[0]!;
    expect(filter).toEqual({ tenantId: TENANT_A, userId: USER_A1, category: 'preference' });
  });

  it('a tenant-B id is invisible: MEMORY_NOT_FOUND when document is null', async () => {
    const coll = getMockCollection('memory_facts');
    coll.findOne.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/memory/b2222222-2222-4222-8222-222222222222',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEMORY_NOT_FOUND');
    // The filter the module issued was still scoped to tenant A — the id
    // alone can never reach another tenant's document.
    const [filter] = coll.findOne.mock.calls[0]!;
    expect(filter.tenantId).toBe(TENANT_A);
    expect(filter.userId).toBe(USER_A1);
  });
});

describe('PATCH /memory/:id', () => {
  it('updates a fact and audits it', async () => {
    const coll = getMockCollection('memory_facts');
    coll.findOneAndUpdate.mockResolvedValue(mkDoc({ fact: 'prefers coffee' }));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
      payload: { fact: 'prefers coffee' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.fact).toBe('prefers coffee');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_UPDATE', resource: 'memory' })
    );
  });

  it('returns 404 for another user’s fact', async () => {
    const coll = getMockCollection('memory_facts');
    coll.findOneAndUpdate.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/v1/memory/b2222222-2222-4222-8222-222222222222',
      payload: { fact: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /memory/:id', () => {
  it('deletes a fact, returns 204, and audits it', async () => {
    const coll = getMockCollection('memory_facts');
    coll.deleteOne.mockResolvedValue({ deletedCount: 1 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(204);
    const [filter] = coll.deleteOne.mock.calls[0]!;
    expect(filter).toEqual({
      _id: 'a1111111-1111-4111-8111-111111111111',
      tenantId: TENANT_A,
      userId: USER_A1,
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_DELETE', resource: 'memory' })
    );
    // Audit must not carry the fact text itself.
    const auditInput = (recordAudit as any).mock.calls[0][0];
    expect(JSON.stringify(auditInput)).not.toContain('prefers');
  });

  it('rejects cross-tenant delete: caller tenant is bound, not the target’s', async () => {
    currentAuth.value = authFor({ tenantId: TENANT_B });
    const coll = getMockCollection('memory_facts');
    coll.deleteOne.mockResolvedValue({ deletedCount: 0 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(404);
    const [filter] = coll.deleteOne.mock.calls[0]!;
    expect(filter.tenantId).toBe(TENANT_B);
  });
});
