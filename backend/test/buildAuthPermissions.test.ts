/**
 * buildAuthPermissions.test.ts — the all-grant posture is enforced in code
 * at BOTH permission resolution points (login session + per-request).
 *
 * VALIDATED IN CI with mocks; no live infrastructure.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PERMISSIONS } from '../src/authz/permissions.js';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { verifyToken } = vi.hoisted(() => ({ verifyToken: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/identityProvider.js', () => ({ identityProvider: { authenticate: vi.fn() } }));
vi.mock('../src/auth/jwt.js', () => ({ verifyToken }));

import { buildAuth } from '../src/auth/routes.js';
import { requireAuth } from '../src/auth/middleware.js';
import { config } from '../src/config.js';

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
    };
  }
  return mockCollections[name];
}

const USER = {
  id: 'user-1',
  email: 'jsmith1@enflite.com',
  displayName: 'Jake Smith',
  clearance: 'internal',
};
const MEMBERSHIP = { tenantId: 'tenant-1', roleId: 'role-admin', roleName: 'Admin' };

describe('buildAuth permission resolution', () => {
  beforeEach(() => {
    // PERMISSIONS_ALL_GRANTED lives in the zod schema (config.ts), parsed
    // once at import — pin it via direct mutation; the 'false' tests below
    // override per-test.
    (config as Record<string, unknown>).PERMISSIONS_ALL_GRANTED = true;
    for (const c of Object.values(mockCollections)) {
      c.find.mockClear();
      c.findOne.mockClear();
    }
    getDbMock.mockReset().mockImplementation(async () => ({
      collection: (name: string) => getMockCollection(name),
    }));
  });

  it('grants the full registry at login by default (no DB permission lookup)', async () => {
    const auth = await buildAuth(USER as any, MEMBERSHIP as any);
    expect(auth.permissions).toEqual([...PERMISSIONS]);
    // role_permissions / permissions collections must not be consulted.
    const rpFind = getMockCollection('role_permissions').find;
    const pFind = getMockCollection('permissions').find;
    expect(rpFind).not.toHaveBeenCalled();
    expect(pFind).not.toHaveBeenCalled();
  });

  it('restores the DB-driven set when PERMISSIONS_ALL_GRANTED=false', async () => {
    (config as Record<string, unknown>).PERMISSIONS_ALL_GRANTED = false;
    const rp = getMockCollection('role_permissions');
    rp.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: 'rp1', permissionId: 'p1' }]),
    }));
    const p = getMockCollection('permissions');
    p.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: 'p1', name: 'chat:create' }]),
    }));
    const auth = await buildAuth(USER as any, MEMBERSHIP as any);
    expect(auth.permissions).toEqual(['chat:create']);
  });
});

describe('requireAuth per-request permission resolution', () => {
  beforeEach(() => {
    (config as Record<string, unknown>).PERMISSIONS_ALL_GRANTED = true;
    for (const c of Object.values(mockCollections)) {
      c.find.mockClear();
      c.findOne.mockClear();
    }
    verifyToken.mockReset().mockResolvedValue({ sessionId: 'sess-1', userId: 'user-1', tenantId: 'tenant-1' });
    const sessions = getMockCollection('sessions');
    sessions.findOne.mockResolvedValue({
      _id: 'sess-1', userId: 'user-1', tenantId: 'tenant-1',
      refreshTokenHash: 'x', expiresAt: new Date(Date.now() + 3600e3), revokedAt: null,
    });
    getMockCollection('users').findOne.mockResolvedValue({ _id: 'user-1', isActive: true });
    getMockCollection('memberships').findOne.mockResolvedValue({
      _id: 'm1', userId: 'user-1', tenantId: 'tenant-1', roleId: 'role-admin',
    });
    getMockCollection('roles').findOne.mockResolvedValue({ _id: 'role-admin', name: 'Admin' });
    getDbMock.mockReset().mockImplementation(async () => ({
      collection: (name: string) => getMockCollection(name),
    }));
  });

  it('resolves the full registry per request by default (sorted, no DB permission lookup)', async () => {
    const req: any = { headers: { authorization: 'Bearer token' }, requestId: 'r1', ip: '127.0.0.1' };
    await requireAuth(req, {} as any);
    expect(req.auth.permissions).toEqual([...PERMISSIONS].sort());
    expect(req.auth.roleName).toBe('Admin');
    expect(getMockCollection('role_permissions').find).not.toHaveBeenCalled();
    expect(getMockCollection('permissions').find).not.toHaveBeenCalled();
  });

  it('restores the DB-driven set per request when PERMISSIONS_ALL_GRANTED=false', async () => {
    (config as Record<string, unknown>).PERMISSIONS_ALL_GRANTED = false;
    const rp = getMockCollection('role_permissions');
    rp.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: 'rp1', permissionId: 'p1' }]),
    }));
    const p = getMockCollection('permissions');
    p.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([{ _id: 'p1', name: 'syteline:ui' }]),
    }));
    const req: any = { headers: { authorization: 'Bearer token' }, requestId: 'r1', ip: '127.0.0.1' };
    await requireAuth(req, {} as any);
    expect(req.auth.permissions).toEqual(['syteline:ui']);
  });
});
