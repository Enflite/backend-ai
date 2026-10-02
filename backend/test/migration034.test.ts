/**
 * migration034.test.ts — grant every permission to every role.
 *
 * - grants the full cross product of (role, permission) pairs
 * - skips pairs that already exist (no duplicates)
 * - idempotent: safe to re-run
 * - no-op when there are no roles or no permissions
 *
 * Uses in-memory stand-ins for the collections; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE. VALIDATED IN CI.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration034 } from '../src/db/migrations/034_all_permissions_all_roles.js';

function fakeDb(roleNames: string[], permNames: string[], pregrants: Array<[string, string]> = []) {
  const roles = roleNames.map((name, i) => ({ _id: `role-${i}`, name }));
  const permissions = permNames.map((name, i) => ({ _id: `perm-${i}`, name }));
  const rolePermissions = pregrants.map(([rn, pn], i) => {
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
        insertMany: vi.fn(async (docs: Array<Record<string, any>>) => {
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
  };
}

const ROLES = ['Admin', 'AI Admin', 'Developer', 'User'];
const PERMS = ['chat:use', 'syteline:ui', 'syteline:forms', 'flows:manage'];

describe('migration 034 (all permissions to all roles)', () => {
  it('grants every permission to every role', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS);
    await migration034.up(db);
    expect(rolePermissions).toHaveLength(ROLES.length * PERMS.length);
  });

  it('skips pairs that already exist', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS, [['Admin', 'chat:use']]);
    await migration034.up(db);
    expect(rolePermissions).toHaveLength(ROLES.length * PERMS.length);
    const adminChat = rolePermissions.filter(
      (g) => g.roleId === 'role-0' && g.permissionId === 'perm-0'
    );
    expect(adminChat).toHaveLength(1);
  });

  it('is idempotent: re-running changes nothing', async () => {
    const { db, rolePermissions } = fakeDb(ROLES, PERMS);
    await migration034.up(db);
    const afterFirst = rolePermissions.length;
    await expect(migration034.up(db)).resolves.toBeUndefined();
    expect(rolePermissions).toHaveLength(afterFirst);
  });

  it('is a no-op with no roles or no permissions', async () => {
    const { db: db1, rolePermissions: rp1 } = fakeDb([], PERMS);
    await migration034.up(db1);
    expect(rp1).toHaveLength(0);

    const { db: db2, rolePermissions: rp2 } = fakeDb(ROLES, []);
    await migration034.up(db2);
    expect(rp2).toHaveLength(0);
  });
});
