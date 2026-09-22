import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
const { testAuth } = vi.hoisted(() => ({
  testAuth: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'user@example.test',
    displayName: 'User',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['chat:create'],
  },
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/identityProvider.js', () => ({ identityProvider: { authenticate } }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = testAuth;
    done();
  },
}));

import { authRoutes } from '../src/auth/routes.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    const findChain = () => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    });
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => findChain()),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'deleteMany']) {
      coll[m].mockReset();
      if (m === 'findOne') coll[m].mockResolvedValue(null);
      else if (m === 'findOneAndUpdate') coll[m].mockResolvedValue(null);
      else if (m === 'updateOne' || m === 'updateMany') coll[m].mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
      else if (m === 'insertOne') coll[m].mockResolvedValue({ acknowledged: true });
      else if (m === 'deleteMany') coll[m].mockResolvedValue({ deletedCount: 0 });
    }
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

// Helper: check if a filter queries the refresh-token history (via $or)
function isHistoryQuery(filter: any): boolean {
  if (!filter || typeof filter !== 'object') return false;
  if (filter.previousRefreshTokenHashes !== undefined) return true;
  if (Array.isArray(filter.$or)) {
    return filter.$or.some((clause: any) => clause.previousRefreshTokenHashes !== undefined);
  }
  return false;
}

async function app() {
  const fastify = Fastify();
  await fastify.register(cookie);
  fastify.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL', message: error.message });
  });
  await fastify.register(authRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  recordAudit.mockResolvedValue(undefined);
  authenticate.mockResolvedValue(null);
});

describe('login lockout', () => {
  it('returns generic 401 for a locked account (no account-enumeration signal)', async () => {
    const usersColl = getMockCollection('users');
    usersColl.findOne.mockResolvedValue({
      _id: USER,
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 60000),
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
    // The lock is still recorded server-side for operators.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'AUTHENTICATION_FAILURE',
      success: false,
      reason: 'ACCOUNT_LOCKED',
      userId: USER,
    }));
    await fastify.close();
  });

  it('increments failures with a single atomic findOneAndUpdate on bad password', async () => {
    const usersColl = getMockCollection('users');
    // Lock state check: not locked, 4 prior failures
    usersColl.findOne.mockResolvedValue({
      _id: USER,
      failedLoginAttempts: 4,
      lockedUntil: null,
    });
    // Atomic increment returns the updated doc with 5 attempts
    usersColl.findOneAndUpdate.mockResolvedValue({
      _id: USER,
      failedLoginAttempts: 5,
      lockedUntil: new Date(Date.now() + 300000),
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    // Read-modify-write happens inside the database via aggregation pipeline, not in Node.
    expect(usersColl.findOneAndUpdate).toHaveBeenCalledTimes(1);
    const [filter, update, options] = usersColl.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ _id: USER });
    // Pipeline update with $add/$ifNull for atomic increment
    expect(JSON.stringify(update)).toContain('$add');
    expect(JSON.stringify(update)).toContain('failedLoginAttempts');
    expect(options.returnDocument).toBe('after');
    // The 5th failure escalates to a lockout audit.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ACCOUNT_LOCKED',
      metadata: { failedAttempts: 5 },
    }));
    await fastify.close();
  });

  it('gives unknown emails the same 401 without lockout bookkeeping', async () => {
    const usersColl = getMockCollection('users');
    usersColl.findOne.mockResolvedValue(null); // No lock state = unknown email
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
    expect(usersColl.findOneAndUpdate).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe('refresh-token reuse', () => {
  const cookieHeader = `enflite_refresh=${TENANT}.secrettoken`;

  it('revokes all sessions and audits when a superseded token is presented', async () => {
    const sessionsColl = getMockCollection('sessions');
    // Rotation fails (token not current) -> reuse detection finds it in history
    sessionsColl.findOneAndUpdate.mockResolvedValue(null); // Rotation lost
    sessionsColl.findOne.mockImplementation(async (filter: any) => {
      // Reuse detection: query via $or with previousRefreshTokenHashes array containment
      if (isHistoryQuery(filter)) {
        return { _id: 'sess-old', userId: USER, tenantId: TENANT };
      }
      return null;
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('REFRESH_TOKEN_REUSED');
    // All user sessions revoked
    expect(sessionsColl.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, tenantId: TENANT }),
      expect.objectContaining({ $set: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SECURITY_REFRESH_TOKEN_REUSED',
      userId: USER,
    }));
    await fastify.close();
  });

  it('routes a lost rotation race through reuse detection instead of a 500', async () => {
    const sessionsColl = getMockCollection('sessions');
    // Simulate losing the concurrent-rotation race: findOneAndUpdate returns
    // null because the winner already rotated (conditional on old hash).
    sessionsColl.findOneAndUpdate.mockResolvedValue(null);
    sessionsColl.findOne.mockImplementation(async (filter: any) => {
      if (isHistoryQuery(filter)) {
        return { _id: 'sess-1', userId: USER, tenantId: TENANT };
      }
      // Session lookup for the refresh attempt
      if (filter._id === 'sess-1' || filter.refreshTokenHash) {
        return {
          _id: 'sess-1', userId: USER, tenantId: TENANT,
          refreshTokenHash: 'oldhash', revokedAt: null,
          expiresAt: new Date(Date.now() + 3600000),
        };
      }
      return null;
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('REFRESH_TOKEN_REUSED');
    await fastify.close();
  });

  it('returns 401 INVALID_REFRESH_TOKEN for an unknown token', async () => {
    const sessionsColl = getMockCollection('sessions');
    sessionsColl.findOneAndUpdate.mockResolvedValue(null);
    sessionsColl.findOne.mockResolvedValue(null); // Not in history either
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
    await fastify.close();
  });

  it('queries the token history with array containment (multikey-indexed)', async () => {
    const sessionsColl = getMockCollection('sessions');
    const seenFilters: any[] = [];
    sessionsColl.findOne.mockImplementation(async (filter: any) => {
      seenFilters.push(filter);
      return null;
    });
    sessionsColl.findOneAndUpdate.mockResolvedValue(null);
    const fastify = await app();
    await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    const historyQuery = seenFilters.find((f) => isHistoryQuery(f));
    expect(historyQuery).toBeDefined();
    // MongoDB array containment via $or with equality on the array field; the
    // previousRefreshTokenHashes field has a multikey index (migration 005).
    // No SQL operators — the filter is a plain document with $or.
    expect(historyQuery.$or).toBeDefined();
    const historyClause = historyQuery.$or.find((c: any) => c.previousRefreshTokenHashes !== undefined);
    expect(historyClause).toBeDefined();
    expect(typeof historyClause.previousRefreshTokenHashes).toBe('string');
    await fastify.close();
  });
});

describe('session inventory', () => {
  it('lists sessions via GET /auth/sessions', async () => {
    const sessionsColl = getMockCollection('sessions');
    const sessionDoc = {
      _id: '33333333-3333-4333-8333-333333333333',
      userId: USER,
      tenantId: TENANT,
      revokedAt: null,
      createdAt: new Date(),
      lastUsedAt: new Date(),
      expiresAt: new Date(Date.now() + 3600000),
    };
    sessionsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([sessionDoc]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/auth/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions[0]).toMatchObject({ current: true });
    await fastify.close();
  });

  it('revokes every session via POST /auth/logout/all', async () => {
    const sessionsColl = getMockCollection('sessions');
    sessionsColl.updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 3 });
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/logout/all' });
    expect(res.statusCode).toBe(200);
    expect(sessionsColl.updateMany).toHaveBeenCalledWith(
      { tenantId: TENANT, userId: USER, revokedAt: null },
      expect.objectContaining({ $set: expect.objectContaining({ revokedAt: expect.any(Date) }) })
    );
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGOUT_ALL' }));
    await fastify.close();
  });
});
