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
const { signToken, verifyToken } = vi.hoisted(() => ({ signToken: vi.fn(), verifyToken: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/jwt.js', () => ({ signToken, verifyToken }));

import { authRoutes } from '../src/auth/routes.js';
import { InvalidRefreshSessionError, rotateRefreshToken } from '../src/auth/sessions.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const cookieHeader = `enflite_refresh=${TENANT}.secrettoken`;

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
        project: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset().mockResolvedValue(null);
    coll.findOneAndUpdate.mockReset().mockResolvedValue(null);
    coll.updateOne.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.insertOne.mockReset().mockResolvedValue({ acknowledged: true });
    coll.deleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
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

// The live session doc returned by the refresh session lookup.
const sessionDoc = {
  _id: 'sess-1',
  userId: USER,
  tenantId: TENANT,
  refreshTokenHash: 'hashed-old',
  revokedAt: null,
  expiresAt: new Date(Date.now() + 3600000),
};

const userDoc = {
  _id: USER,
  email: 'user@example.test',
  passwordHash: 'x',
  displayName: 'User',
  isActive: true,
  clearance: 'INTERNAL',
};

/** Default happy-path mocks: session lookup succeeds, rotation wins the race. */
function mockHappyPath() {
  const sessions = getMockCollection('sessions');
  const users = getMockCollection('users');
  const memberships = getMockCollection('memberships');
  const tenants = getMockCollection('tenants');
  const roles = getMockCollection('roles');
  const rolePermissions = getMockCollection('role_permissions');
  const permissions = getMockCollection('permissions');

  sessions.findOne.mockImplementation(async (filter: any) => {
    // Refresh session lookup: by current refreshTokenHash.
    if (filter.refreshTokenHash) return sessionDoc;
    // Reuse detection: history query — return null (no reuse evidence).
    return null;
  });
  users.findOne.mockResolvedValue(userDoc);
  memberships.find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue([{ _id: 'm1', userId: USER, tenantId: TENANT, roleId: 'r1' }]),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));
  tenants.findOne.mockResolvedValue({ _id: TENANT, name: 'T' });
  roles.findOne.mockResolvedValue({ _id: 'r1', name: 'User' });
  rolePermissions.find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue([{ _id: 'rp1', roleId: 'r1', permissionId: 'p1' }]),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));
  permissions.find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue([{ _id: 'p1', name: 'chat:create' }]),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));
  // Rotation UPDATE succeeds by default (wins the race).
  sessions.findOneAndUpdate.mockResolvedValue({ ...sessionDoc, refreshTokenHash: 'hashed-new' });
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
  signToken.mockResolvedValue('signed-access-token');
  mockHappyPath();
});

describe('rotateRefreshToken error classification', () => {
  it('throws InvalidRefreshSessionError when the conditional UPDATE loses the race', async () => {
    const sessions = getMockCollection('sessions');
    // The conditional findOneAndUpdate matches zero rows: the winner already rotated.
    sessions.findOneAndUpdate.mockResolvedValue(null);
    await expect(
      rotateRefreshToken(`${TENANT}.old`, { userId: USER, tenantId: TENANT } as any, 'sess-1')
    ).rejects.toBeInstanceOf(InvalidRefreshSessionError);
  });

  it('lost rotation without reuse evidence returns 401 INVALID_REFRESH_TOKEN, not reuse', async () => {
    const sessions = getMockCollection('sessions');
    // Session lookup succeeds, but the rotation loses the race; the history
    // query finds nothing (no reuse evidence).
    sessions.findOneAndUpdate.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
    await fastify.close();
  });

  it('a signing failure is NOT treated as token reuse (500, no revocation, no reuse audit)', async () => {
    signToken.mockRejectedValue(new Error('signing boom'));
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL');
    const sessions = getMockCollection('sessions');
    // No revocation: updateMany (revokeAllUserSessions) was never called.
    expect(sessions.updateMany).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SECURITY_REFRESH_TOKEN_REUSED' })
    );
    await fastify.close();
  });

  it('caller cancellation (AbortError) is never treated as rotation failure', async () => {
    signToken.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(500);
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SECURITY_REFRESH_TOKEN_REUSED' })
    );
    await fastify.close();
  });

  it('a successful rotation still returns fresh tokens', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBe('signed-access-token');
    await fastify.close();
  });
});
