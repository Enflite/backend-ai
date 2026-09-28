/**
 * migration029030.test.ts — default-open migrations (029, 030).
 *
 * - 029 flags the platform default model with `isDefault` without ever
 *   clobbering an operator-chosen default, and creates the partial index.
 * - 030 seeds the `syteline:forms` permission and grants it to Admin,
 *   AI Admin, Developer, and User — idempotently, skipping missing roles.
 *
 * Uses in-memory stand-ins for the collections; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration029 } from '../src/db/migrations/029_model_default_open.js';
import { migration030 } from '../src/db/migrations/030_syteline_forms_permission.js';

const SEED_NAME = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

function fakeModelsDb(docs: Array<Record<string, any>>) {
  const rows = docs.map((d) => ({ ...d }));
  const collection = {
    createIndex: vi.fn(async () => 'idx'),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      if (filter.isDefault === true) return rows.find((r) => r.isDefault === true) ?? null;
      return rows.find((r) => r.name === filter.name) ?? null;
    }),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      const row = rows.find((r) => r.name === filter.name);
      if (row) Object.assign(row, update.$set);
      return { modifiedCount: row ? 1 : 0 };
    }),
  };
  return {
    db: { collection: vi.fn(() => collection) } as any,
    rows,
    collection,
  };
}

describe('migration 029 (model default-open flag)', () => {
  it('creates the partial index and flags the seed model', async () => {
    const { db, rows, collection } = fakeModelsDb([{ _id: 'm1', name: SEED_NAME, status: 'ACTIVE' }]);
    await migration029.up(db);
    expect(collection.createIndex).toHaveBeenCalledWith(
      { isDefault: 1 },
      expect.objectContaining({ name: 'idx_models_is_default' })
    );
    expect(rows[0]!.isDefault).toBe(true);
    expect(collection.updateOne).toHaveBeenCalledTimes(1);
  });

  it('never clobbers an operator-chosen default', async () => {
    const { db, rows, collection } = fakeModelsDb([
      { _id: 'op', name: 'operator/custom-model', isDefault: true },
      { _id: 'm1', name: SEED_NAME, status: 'ACTIVE' },
    ]);
    await migration029.up(db);
    expect(collection.updateOne).not.toHaveBeenCalled();
    expect(rows[1]!.isDefault).not.toBe(true);
    expect(rows[0]!.isDefault).toBe(true);
  });

  it('is a no-op on a second run (idempotent)', async () => {
    const { db, collection } = fakeModelsDb([{ _id: 'm1', name: SEED_NAME, isDefault: true }]);
    await migration029.up(db);
    await migration029.up(db);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
});

function fakeAccessDb(existingRoles: string[]) {
  const permissions: Array<Record<string, any>> = [];
  const role_permissions: Array<Record<string, any>> = [];
  const roleDocs = existingRoles.map((name, i) => ({ _id: `role-${i}`, name }));
  const collection = (name: string) => {
    if (name === 'permissions') {
      return {
        findOne: vi.fn(async (filter: Record<string, any>) =>
          permissions.find((p) => p.name === filter.name) ?? null
        ),
        insertMany: vi.fn(async (docs: Array<Record<string, any>>) => {
          for (const d of docs) {
            if (!permissions.some((p) => p.name === d.name)) permissions.push({ ...d });
          }
          return { insertedCount: docs.length };
        }),
      };
    }
    if (name === 'roles') {
      return {
        find: vi.fn(() => ({
          project: vi.fn(() => ({
            toArray: vi.fn(async () => roleDocs),
          })),
        })),
      };
    }
    // role_permissions
    return {
      insertMany: vi.fn(async (docs: Array<Record<string, any>>) => {
        for (const d of docs) {
          if (!role_permissions.some((g) => g.roleId === d.roleId && g.permissionId === d.permissionId)) {
            role_permissions.push({ ...d });
          }
        }
        return { insertedCount: docs.length };
      }),
    };
  };
  return {
    db: { collection: vi.fn((name: string) => collection(name)) } as any,
    permissions,
    role_permissions,
  };
}

describe('migration 030 (syteline:forms permission)', () => {
  const ALL_ROLES = ['Admin', 'AI Admin', 'Developer', 'User'];

  it('seeds the permission and grants it to Admin, AI Admin, Developer, and User', async () => {
    const { db, permissions, role_permissions } = fakeAccessDb(ALL_ROLES);
    await migration030.up(db);
    expect(permissions.some((p) => p.name === 'syteline:forms')).toBe(true);
    expect(role_permissions).toHaveLength(4);
    const permId = permissions.find((p) => p.name === 'syteline:forms')!._id;
    for (const g of role_permissions) expect(g.permissionId).toBe(permId);
  });

  it('grants User the permission (default-open end-user capability)', async () => {
    const { db, role_permissions } = fakeAccessDb(ALL_ROLES);
    await migration030.up(db);
    expect(role_permissions.some((g) => g.roleId === 'role-3')).toBe(true);
  });

  it('skips roles that do not exist yet', async () => {
    const { db, role_permissions } = fakeAccessDb(['Admin', 'User']);
    await migration030.up(db);
    expect(role_permissions).toHaveLength(2);
  });

  it('is idempotent: a second run adds no duplicate grants', async () => {
    const { db, permissions, role_permissions } = fakeAccessDb(ALL_ROLES);
    await migration030.up(db);
    await migration030.up(db);
    expect(permissions.filter((p) => p.name === 'syteline:forms')).toHaveLength(1);
    expect(role_permissions).toHaveLength(4);
  });
});
