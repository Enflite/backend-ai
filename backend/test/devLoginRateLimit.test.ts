import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
// Enable the dev-login route for this test file only.
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config, DEV_AUTH_ENABLED: true } };
});

import { authRoutes } from '../src/auth/routes.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

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

async function app() {
  const fastify = Fastify();
  await fastify.register(cookie);
  // High global ceiling so only the per-route bucket (10/min) can trigger.
  await fastify.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  fastify.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL' });
  });
  await fastify.register(authRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  recordAudit.mockResolvedValue(undefined);
  // Dev-login flow: users.findOne({ email }) → membershipsFor → buildAuth → createSession.
  const users = getMockCollection('users');
  const memberships = getMockCollection('memberships');
  const tenants = getMockCollection('tenants');
  const roles = getMockCollection('roles');
  const rolePermissions = getMockCollection('role_permissions');
  const permissions = getMockCollection('permissions');

  users.findOne.mockResolvedValue({
    _id: USER,
    email: 'dev@example.test',
    passwordHash: 'x',
    displayName: 'Dev',
    isActive: true,
    clearance: 'INTERNAL',
  });
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
});

describe('POST /auth/dev-login rate limit', () => {
  it('allows 10 requests per minute, then returns 429 like /auth/login', async () => {
    const fastify = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/dev-login',
        payload: { email: 'dev@example.test' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(statuses[11]).toBe(429);
    await fastify.close();
  });
});
