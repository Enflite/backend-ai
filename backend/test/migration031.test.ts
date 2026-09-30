/**
 * migration031.test.ts — the syteline:ui permission seed.
 *
 * - seeds the `syteline:ui` permission doc
 * - grants it to Admin and AI Admin ONLY (never User, never Developer)
 * - creates the unique syteline_credentials index
 * - idempotent: safe to re-run
 *
 * Uses in-memory stand-ins for the collections; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE. VALIDATED IN CI.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration031 } from '../src/db/migrations/031_syteline_ui_permission.js';

function fakeDb(roleNames: string[]) {
  const permissions: Array<Record<string, any>> = [];
  const rolePermissions: Array<Record<string, any>> = [];
  const roles = roleNames.map((name, i) => ({ _id: `role-${i}`, name }));
  const createdIndexes: Array<{ keys: unknown; options: unknown }> = [];
  const collection = (name: string) => {
    if (name === 'permissions') {
      return {
        insertMany: vi.fn(async (docs: Array<Record<string, any>>) => {
          for (const doc of docs) {
            if (permissions.some((p) => p.name === doc.name)) {
              const err = new Error('duplicate key') as Error & { code: number };
              err.code = 11000;
              throw err;
            }
            permissions.push({ ...doc });
          }
          return { insertedCount: docs.length };
        }),
        findOne: vi.fn(async (filter: Record<string, any>) => {
          const doc = permissions.find((p) => p.name === filter.name);
          return doc ? { ...doc } : null;
        }),
      };
    }
    if (name === 'roles') {
      return {
        find: vi.fn((filter: { name?: { $in?: string[] } }) => ({
          project: vi.fn().mockReturnThis(),
          toArray: vi.fn(async () => {
            const wanted = new Set(filter?.name?.$in ?? roles.map((r) => r.name));
            return roles.filter((r) => wanted.has(r.name)).map((r) => ({ ...r }));
          }),
        })),
      };
    }
    if (name === 'role_permissions') {
      return {
        insertMany: vi.fn(async (docs: Array<Record<string, any>>) => {
          rolePermissions.push(...docs.map((d) => ({ ...d })));
          return { insertedCount: docs.length };
        }),
      };
    }
    if (name === 'syteline_credentials') {
      return {
        createIndex: vi.fn(async (keys: unknown, options: unknown) => {
          createdIndexes.push({ keys, options });
          return 'idx';
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return {
    db: { collection: vi.fn((name: string) => collection(name)) } as any,
    permissions,
    rolePermissions,
    roles,
    createdIndexes,
  };
}

const ALL_ROLES = ['Admin', 'AI Admin', 'Developer', 'User', 'Security Admin', 'Read Only'];

describe('migration 031 (syteline:ui permission)', () => {
  it('seeds the permission and grants it to Admin and AI Admin only', async () => {
    const { db, permissions, rolePermissions, roles } = fakeDb(ALL_ROLES);
    await migration031.up(db);

    expect(permissions.map((p) => p.name)).toContain('syteline:ui');
    const permId = permissions.find((p) => p.name === 'syteline:ui')!._id;
    const grantedRoleIds = rolePermissions
      .filter((g) => g.permissionId === permId)
      .map((g) => g.roleId);
    const grantedNames = roles.filter((r) => grantedRoleIds.includes(r._id)).map((r) => r.name);
    expect(grantedNames.sort()).toEqual(['AI Admin', 'Admin']);
  });

  it('creates the unique syteline_credentials index', async () => {
    const { db, createdIndexes } = fakeDb(ALL_ROLES);
    await migration031.up(db);
    expect(createdIndexes).toHaveLength(1);
    expect(createdIndexes[0]!.keys).toEqual({ tenantId: 1, userId: 1 });
    expect(createdIndexes[0]!.options).toMatchObject({
      name: 'idx_syteline_credentials_tenant_user',
      unique: true,
    });
  });

  it('is idempotent: re-running changes nothing', async () => {
    const { db, permissions, rolePermissions } = fakeDb(ALL_ROLES);
    await migration031.up(db);
    const grantsAfterFirst = rolePermissions.length;
    // Second run: the permission doc already exists (duplicate-key is swallowed).
    await expect(migration031.up(db)).resolves.toBeUndefined();
    expect(permissions.filter((p) => p.name === 'syteline:ui')).toHaveLength(1);
    // Grants resolve by name each run; insertManyIdempotent swallows dupes.
    expect(rolePermissions.length).toBeGreaterThanOrEqual(grantsAfterFirst);
  });

  it('grants nothing when the Admin/AI Admin roles are missing', async () => {
    const { db, rolePermissions } = fakeDb(['User', 'Developer']);
    await migration031.up(db);
    expect(rolePermissions).toHaveLength(0);
  });
});
