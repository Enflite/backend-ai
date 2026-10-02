/**
 * 036_all_permissions_repair — re-assert every permission granted to every role.
 *
 * REPAIR migration for 034_all_permissions_all_roles. 034's guard exits
 * silently (and still records itself applied) when the `permissions` or
 * `roles` collection is empty at run time — e.g. a database where 034 ran
 * before the permission seeds landed. Such databases report 034 as applied
 * while `role_permissions` holds nothing, so every permission check denies.
 *
 * This migration runs the exact same grant logic again: the full cross
 * product of (role, permission) pairs, skipping pairs that already exist.
 * On a healthy database it is a pure no-op.
 *
 * Same product posture as 034 (Jake, 2026-10-02): all users get all
 * permissions for now; the granular checks stay enforced. Any later
 * migration that seeds a NEW permission must grant it to all roles itself
 * while this posture holds.
 *
 * Idempotent: skips (roleId, permissionId) pairs that already exist; the
 * unique index idx_role_permissions_pk on (roleId, permissionId) makes
 * re-running a no-op.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

export const migration036: Migration = {
  version: '036_all_permissions_repair',
  description: 'Repair: re-grant every permission to every role (covers 034 no-op databases)',

  up: async (db: Db): Promise<void> => {
    const permDocs = await coll(db, 'permissions')
      .find({}, { projection: { _id: 1 } })
      .toArray();
    const roleDocs = await coll(db, 'roles')
      .find({}, { projection: { _id: 1 } })
      .toArray();
    if (permDocs.length === 0 || roleDocs.length === 0) return;

    const existing = await coll(db, 'role_permissions')
      .find(
        {},
        { projection: { roleId: 1, permissionId: 1 } }
      )
      .toArray();
    const existingPairs = new Set(
      existing.map((d) => `${d.roleId}::${d.permissionId}`)
    );

    const grants = roleDocs.flatMap((r) =>
      permDocs
        .filter((p) => !existingPairs.has(`${r._id}::${p._id}`))
        .map((p) => ({
          _id: randomUUID(),
          roleId: r._id,
          permissionId: p._id,
        }))
    );
    await insertManyIdempotent(coll(db, 'role_permissions'), grants);
  },
};
