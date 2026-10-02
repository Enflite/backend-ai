/**
 * 038_studio_permissions — seed the SyteLine Automation Studio permissions
 * (`studio:manage`, `studio:run`) and grant them to every role, plus indexes
 * for the Studio's `studio_connections` collection.
 *
 * Structure follows 037 exactly: permissions docs are
 * `{ _id, name, createdAt }` (the field is `name`), and grants in
 * `role_permissions` are `{ _id, roleId, permissionId }` where
 * `permissionId` is the permission doc's `_id` (this is what
 * auth/middleware.ts resolves at request time).
 *
 * Grant scope: ALL roles. The standing product posture (034) is
 * all-users-get-all-permissions; per 034's own note, any migration that
 * seeds a NEW permission must grant it to all roles itself — otherwise the
 * new permission silently denies everyone.
 *
 * Idempotent: safe to re-run (insertManyIdempotent swallows duplicate-key
 * errors; createIndex with a fixed name is a no-op when it exists).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const STUDIO_PERMISSIONS = ['studio:manage', 'studio:run'];

export const migration038: Migration = {
  version: '038_studio_permissions',
  description: 'Seed studio:manage / studio:run (granted to all roles) and studio_connections indexes',

  up: async (db: Db): Promise<void> => {
    const now = new Date();
    await insertManyIdempotent(
      coll(db, 'permissions'),
      STUDIO_PERMISSIONS.map((name) => ({ _id: randomUUID(), name, createdAt: now }))
    );

    // All roles (all-permissions posture): every role holds both Studio
    // permissions.
    const roleDocs = await coll(db, 'roles')
      .find({})
      .project({ _id: 1 })
      .toArray();
    for (const permission of STUDIO_PERMISSIONS) {
      const permDoc = await coll(db, 'permissions').findOne(
        { name: permission },
        { projection: { _id: 1 } }
      );
      if (!permDoc) continue;
      const existing = await coll(db, 'role_permissions')
        .find({ permissionId: permDoc._id }, { projection: { roleId: 1 } })
        .toArray();
      const grantedRoleIds = new Set(existing.map((d) => d.roleId));
      const grants = roleDocs
        .filter((r) => !grantedRoleIds.has(r._id))
        .map((r) => ({
          _id: randomUUID(),
          roleId: r._id,
          permissionId: permDoc._id,
        }));
      await insertManyIdempotent(coll(db, 'role_permissions'), grants);
    }

    // Connection listing: tenant connections, newest first.
    await db.collection('studio_connections').createIndex(
      { tenantId: 1, createdAt: -1 },
      { name: 'idx_studio_connections_tenant_created' }
    );
    // Name uniqueness is enforced per tenant in application code (case
    // insensitive) rather than via a unique index, so a rename race is a
    // 409 from the route rather than a duplicate-key write the UI cannot
    // explain.
  },
};
