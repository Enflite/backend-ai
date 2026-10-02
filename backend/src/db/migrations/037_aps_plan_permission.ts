/**
 * 037_aps_plan_permission — seed the `aps:plan` permission and grant it to
 * every role, plus indexes for the APS Planning Agent's `aps_analyses`
 * collection.
 *
 * Structure follows 030/031 exactly: permissions docs are
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

const PERMISSION = 'aps:plan';

export const migration037: Migration = {
  version: '037_aps_plan_permission',
  description: 'Seed aps:plan permission (granted to all roles) and aps_analyses indexes',

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

    // All roles (all-permissions posture): every role holds aps:plan.
    const roleDocs = await coll(db, 'roles')
      .find({})
      .project({ _id: 1 })
      .toArray();
    const existing = await coll(db, 'role_permissions')
      .find(
        { permissionId: permDoc._id },
        { projection: { roleId: 1 } }
      )
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

    // Analysis listing: tenant analyses with optional status filter, newest first.
    await db.collection('aps_analyses').createIndex(
      { tenantId: 1, status: 1, createdAt: -1 },
      { name: 'idx_aps_analyses_tenant_status_created' }
    );
    // Per-requester listing, newest first.
    await db.collection('aps_analyses').createIndex(
      { tenantId: 1, requesterUserId: 1, createdAt: -1 },
      { name: 'idx_aps_analyses_tenant_requester_created' }
    );
  },
};
