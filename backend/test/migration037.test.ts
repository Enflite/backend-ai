/**
 * migration037.test.ts — seed aps:plan and grant it to every role, plus
 * aps_analyses indexes.
 *
 * - seeds the permission doc with the `name` field (the schema
 *   auth/middleware.ts resolves — NOT `key`)
 * - grants `{ _id, roleId, permissionId }` to ALL roles in this migration
 *   itself (all-permissions posture)
 * - idempotent: safe to re-run (no duplicate grants, no duplicate seeds)
 * - creates the two aps_analyses indexes
 *
 * Uses in-memory stand-ins for the collections; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE. VALIDATED IN CI.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration037 } from '../src/db/migrations/037_aps_plan_permission.js';

type Doc = Record<string, any>;

function fakeDb(roleNames: string[], permNames: string[] = [], pregrants: Array<[string, string]> = []) {
  const roles = roleNames.map((name, i) => ({ _id: `role-${i}`, name }));
  const permissions: Doc[] = permNames.map((name, i) => ({ _id: `perm-${i}`, name, createdAt: new Date() }));
  const rolePermissions: Doc[] = pregrants.map(([rn, pn], i) => {
    const r = roles.find((x) => x.name === rn)!;
    const p = permissions.find((x) => x.name === pn)!;
    return { _id: `grant-${i}`, roleId: r._id, permissionId: p._id };
  });
  const createdIndexes: Array<{ spec: Doc; name: string }> = [];

  const matchFind = (docs: Doc[], filter: Doc) =>
    docs.filter((d) =>
      Object.entries(filter).every(([k, v]) => {
        if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
          if ('$in' in (v as Doc)) return ((v as Doc).$in as unknown[]).includes(d[k]);
          return true;
        }
        return d[k] === v;
      }),
    );

  const collection = (name: string) => {
    if (name === 'permissions') {
      return {
        find: vi.fn((_f: unknown, _o: unknown) => ({ toArray: async () => [...permissions] })),
        findOne: vi.fn(async (filter: Doc) => permissions.find((p) => p.name === filter.name) ?? null),
        insertMany: vi.fn(async (docs: Doc[]) => {
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
      };
    }
    if (name === 'roles') {
      return {
        find: vi.fn((_f: unknown) => ({
          project: vi.fn(() => ({ toArray: async () => roles.map((r) => ({ _id: r._id })) })),
        })),
      };
    }
    if (name === 'role_permissions') {
      return {
        find: vi.fn((filter: Doc, _o: unknown) => ({
          toArray: async () => matchFind(rolePermissions, filter),
        })),
        insertMany: vi.fn(async (docs: Doc[]) => {
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
    if (name === 'aps_analyses') {
      return {
        createIndex: vi.fn(async (spec: Doc, opts: { name: string }) => {
          createdIndexes.push({ spec, name: opts.name });
          return opts.name;
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return {
    db: { collection: vi.fn((name: string) => collection(name)) } as any,
    permissions,
    rolePermissions,
    createdIndexes,
  };
}

const ROLES = ['Admin', 'AI Admin', 'Developer', 'User', 'Security Admin', 'Read Only'];

describe('migration 037 (aps:plan permission)', () => {
  it('seeds aps:plan with the `name` field and grants it to every role', async () => {
    const { db, permissions, rolePermissions } = fakeDb(ROLES);
    await migration037.up(db);
    const perm = permissions.find((p) => p.name === 'aps:plan');
    expect(perm, 'permission doc seeded').toBeTruthy();
    expect(perm!._id).toBeTruthy();
    expect(perm!.createdAt).toBeInstanceOf(Date);
    const grants = rolePermissions.filter((g) => g.permissionId === perm!._id);
    expect(grants).toHaveLength(ROLES.length);
    // Grant shape: { _id, roleId, permissionId } — permissionId is the doc's _id.
    for (const g of grants) {
      expect(Object.keys(g).sort()).toEqual(['_id', 'permissionId', 'roleId']);
    }
  });

  it('is idempotent: re-running seeds and grants nothing new', async () => {
    const { db, permissions, rolePermissions } = fakeDb(ROLES);
    await migration037.up(db);
    const afterFirst = { perms: permissions.length, grants: rolePermissions.length };
    await migration037.up(db);
    expect(permissions.length).toBe(afterFirst.perms);
    expect(rolePermissions.length).toBe(afterFirst.grants);
    const permCount = permissions.filter((p) => p.name === 'aps:plan').length;
    expect(permCount).toBe(1);
  });

  it('skips roles that already hold the grant', async () => {
    const { db, rolePermissions, permissions } = fakeDb(ROLES, ['aps:plan'], [['Admin', 'aps:plan']]);
    await migration037.up(db);
    const perm = permissions.find((p) => p.name === 'aps:plan')!;
    const grants = rolePermissions.filter((g) => g.permissionId === perm._id);
    expect(grants).toHaveLength(ROLES.length);
    const adminGrants = grants.filter((g) => g.roleId === 'role-0');
    expect(adminGrants).toHaveLength(1);
  });

  it('creates the aps_analyses indexes', async () => {
    const { db, createdIndexes } = fakeDb(ROLES);
    await migration037.up(db);
    const names = createdIndexes.map((i) => i.name).sort();
    expect(names).toEqual([
      'idx_aps_analyses_tenant_requester_created',
      'idx_aps_analyses_tenant_status_created',
    ]);
    for (const idx of createdIndexes) {
      expect(idx.spec.tenantId).toBe(1);
    }
  });

  it('is a no-op for grants when there are no roles', async () => {
    const { db, rolePermissions } = fakeDb([]);
    await migration037.up(db);
    expect(rolePermissions).toHaveLength(0);
  });
});
