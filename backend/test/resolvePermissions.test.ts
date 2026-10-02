import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PERMISSIONS } from '../src/authz/permissions.js';
import { resolvePermissions } from '../src/authz/resolvePermissions.js';

/** Minimal fake Db: records collection access, serves canned docs. */
function fakeDb(docs: Record<string, any[]>) {
  const accessed: string[] = [];
  return {
    accessed,
    collection: (name: string) => {
      accessed.push(name);
      return {
        find: (_query: any, _opts?: any) => ({
          toArray: async () => {
            const rows = docs[name] ?? [];
            // Honor simple {_id: {$in: [...]}} / {roleId} filters used by the helper.
            if (name === 'role_permissions') {
              return rows.filter((r) => r.roleId === _query.roleId);
            }
            if (name === 'permissions' && _query?._id?.$in) {
              const ids = new Set(_query._id.$in);
              return rows.filter((r) => ids.has(r._id));
            }
            return rows;
          },
        }),
      };
    },
  };
}

describe('resolvePermissions', () => {
  const OLD = process.env.PERMISSIONS_ALL_GRANTED;
  beforeEach(() => {
    delete process.env.PERMISSIONS_ALL_GRANTED;
  });
  afterEach(() => {
    if (OLD === undefined) delete process.env.PERMISSIONS_ALL_GRANTED;
    else process.env.PERMISSIONS_ALL_GRANTED = OLD;
  });

  it('returns the full PERMISSIONS registry by default without touching the DB', async () => {
    const db = fakeDb({}) as any;
    const perms = await resolvePermissions(db, 'role-1');
    expect(perms).toEqual([...PERMISSIONS]);
    expect(perms.length).toBeGreaterThan(0);
    expect(db.accessed).toEqual([]);
  });

  it('returns the full registry when PERMISSIONS_ALL_GRANTED=true', async () => {
    process.env.PERMISSIONS_ALL_GRANTED = 'true';
    const db = fakeDb({}) as any;
    const perms = await resolvePermissions(db, 'role-1');
    expect(perms).toEqual([...PERMISSIONS]);
    expect(db.accessed).toEqual([]);
  });

  it('returns the DB-driven set when PERMISSIONS_ALL_GRANTED=false', async () => {
    process.env.PERMISSIONS_ALL_GRANTED = 'false';
    const db = fakeDb({
      role_permissions: [
        { _id: 'rp1', roleId: 'role-1', permissionId: 'p1' },
        { _id: 'rp2', roleId: 'role-1', permissionId: 'p2' },
        { _id: 'rp3', roleId: 'role-2', permissionId: 'p3-other-role' },
      ],
      permissions: [
        { _id: 'p1', name: 'chat:create' },
        { _id: 'p2', name: 'syteline:ui' },
      ],
    }) as any;
    const perms = await resolvePermissions(db, 'role-1');
    expect(perms.sort()).toEqual(['chat:create', 'syteline:ui']);
    expect(db.accessed).toContain('role_permissions');
    expect(db.accessed).toContain('permissions');
  });

  it('returns [] for a role with no grants when PERMISSIONS_ALL_GRANTED=false', async () => {
    process.env.PERMISSIONS_ALL_GRANTED = 'false';
    const db = fakeDb({ role_permissions: [], permissions: [] }) as any;
    expect(await resolvePermissions(db, 'role-1')).toEqual([]);
  });

  it('new registry permissions are granted automatically (all-grant mode)', async () => {
    // The registry is the single source of truth: every entry must come back.
    const db = fakeDb({}) as any;
    const perms = await resolvePermissions(db, 'any-role');
    for (const p of PERMISSIONS) {
      expect(perms).toContain(p);
    }
  });
});
