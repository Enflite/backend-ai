/**
 * migration036.test.ts — repair migration re-granting every permission to
 * every role on databases where 034 recorded itself applied but granted
 * nothing (e.g. 034 ran while `permissions` was empty).
 *
 * - grants the full cross product of (role, permission) pairs as
 *   { _id, roleId, permissionId } docs — the shape the auth read path uses
 * - skips pairs that already exist (no duplicates)
 * - idempotent: safe to re-run
 * - repairs the 034-no-op scenario: 034 runs against an empty `permissions`
 *   collection (grants nothing), permissions are seeded later, 036 grants all
 * - no-op when there are no roles or no permissions
 *
 * Uses in-memory stand-ins for the collections; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE. VALIDATED IN CI.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration034 } from '../src/db/migrations/034_all_permissions_all_roles.js';
import { migration036 } from '../src/db/migrations/036_all_permissions_repair.js';

/** Grant document shape, mirroring the migration's grant objects. */
type GrantDoc = { _id: string; roleId: string; permissionId: string };

function fakeDb(roleNames: string[], permNames: string[], pregrants: Array<[string, string]> = []) {
  const roles = roleNames.map((name, i) => ({ _id: `role-${i}`, name }));
  // Mutable so the repair scenario can seed permissions after 034 no-ops.
  const permissions = permNames.map((name, i) => ({ _id: `perm-${i}`, name }));
  const rolePermissions: GrantDoc[] = pregrants.map(([rn, pn], i) => {
    const r = roles.find((x) => x.name === rn)!;
    const p = permissions.find((x) => x.name === pn)!;
    return { _id: `grant-${i}`, roleId: r._id, permissionId: p._id };
  });

  const findCursor = (docs: Array<Record<string, any>>) => ({
    toArray: vi.fn(async () => docs.map((d) => ({ ...d }))),
  });

  const collection = (name: string) => {
    if (name === 'permissions') {
      return { find: vi.fn((_f: unknown, _o: unknown) => findCursor(permissions)) };
    }
    if (name === 'roles') {
      return { find: vi.fn((_f: unknown, _o: unknown) => findCursor(roles)) };
    }
    if (name === 'role_permissions') {
      return {
        find: vi.fn((_f: unknown, _o: unknown) => findCursor(rolePermissions)),
        insertMany: vi.fn(async (docs: GrantDoc[]) => {
          for (const doc of docs) {
            if (rolePermissions.some((g) => g.roleId === doc.roleId && g.permissionId === doc.permissionId)) {
              const err = new Error('duplicate key') as Error & { code: number };
              err.code = 11000;
              throw err;
            }
            rolePermissions.push({ ...doc });
          }
          return { insertedCount: docs.length };
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return {
    db: { collection: vi.fn((name: string) => collection(name)) } as any,
    rolePermissions,
    permissions,
  };
}

const ROLES = ['Admin', 'AI Admin', 'Developer', 'User'];
const PERMS = ['chat:use', 'syteline:ui', 'syteline:forms', 'flows:manage'];

describe('migration 036 (all-permissions repair)', () => {
  it('grants every permission to every role as { roleId, permissionId } docs', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS);
    await migration036.up(db);
    expect(rolePermissions).toHaveLength(ROLES.length * PERMS.length);
    for (const g of rolePermissions) {
      expect(Object.keys(g).sort()).toEqual(['_id', 'permissionId', 'roleId']);
      expect(g.roleId).toMatch(/^role-\d$/);
      expect(g.permissionId).toMatch(/^perm-\d$/);
    }
  });

  it('skips pairs that already exist', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS, [['Admin', 'chat:use']]);
    await migration036.up(db);
    expect(rolePermissions).toHaveLength(ROLES.length * PERMS.length);
    const adminChat = rolePermissions.filter(
      (g) => g.roleId === 'role-0' && g.permissionId === 'perm-0'
    );
    expect(adminChat).toHaveLength(1);
  });

  it('is idempotent: re-running changes nothing', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS);
    await migration036.up(db);
    const afterFirst = rolePermissions.length;
    await expect(migration036.up(db)).resolves.toBeUndefined();
    expect(rolePermissions).toHaveLength(afterFirst);
  });

  it('repairs a database where 034 applied but granted nothing', async () => {
    // Jake's scenario: 034 runs while `permissions` is empty -> no-op,
    // but schema_migrations would record it applied. Permissions get
    // seeded later (e.g. by the permission migrations).
    const { db, rolePermissions, permissions } = fakeDb(ROLES, []);
    await migration034.up(db);
    expect(rolePermissions).toHaveLength(0);

    PERMS.forEach((name, i) => permissions.push({ _id: `perm-${i}`, name }));

    await migration036.up(db);
    expect(rolePermissions).toHaveLength(ROLES.length * PERMS.length);
  });

  it('is a no-op with no roles or no permissions', async () => {
    const { db: db1, rolePermissions: rp1 } = fakeDb([], PERMS);
    await migration036.up(db1);
    expect(rp1).toHaveLength(0);

    const { db: db2, rolePermissions: rp2 } = fakeDb(ROLES, []);
    await migration036.up(db2);
    expect(rp2).toHaveLength(0);
  });
});
