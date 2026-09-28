/**
 * 030_syteline_forms_permission — seed the `syteline:forms` permission.
 *
 * The SyteLine form-project tools (PR #31) are gated by `syteline:forms`,
 * which was added to src/authz/permissions.ts but never seeded into the
 * `permissions` / `role_permissions` collections — so no role actually
 * holds it and the tools deny everyone.
 *
 * This seeds the permission doc and grants it to Admin, AI Admin and
 * Developer (PR #31's intent) plus User: the product direction is
 * default-open — every user can drive the SyteLine form-project tools.
 * Form-project PRs still require human review and are never auto-merged.
 *
 * Idempotent: safe to re-run.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const PERMISSION = 'syteline:forms';
const GRANT_ROLES = ['Admin', 'AI Admin', 'Developer', 'User'] as const;

export const migration030: Migration = {
  version: '030_syteline_forms_permission',
  description: 'Seed syteline:forms permission and grant it to Admin, AI Admin, Developer, User',

  up: async (db: Db): Promise<void> => {
    const now = new Date();
    await insertManyIdempotent(
      coll(db, 'permissions'),
      [{ _id: randomUUID(), name: PERMISSION, createdAt: now }]
    );

    const permDoc = await coll(db, 'permissions').findOne(
      { name: PERMISSION },
      { projection: { _id: 1 } }
    );
    if (!permDoc) return;
    const roleDocs = await coll(db, 'roles')
      .find({ name: { $in: [...GRANT_ROLES] } })
      .project({ _id: 1 })
      .toArray();
    const grants = roleDocs.map((r) => ({
      _id: randomUUID(),
      roleId: r._id,
      permissionId: permDoc._id,
    }));
    await insertManyIdempotent(coll(db, 'role_permissions'), grants);
  },
};
