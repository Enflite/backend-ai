/**
 * 034_all_permissions_all_roles — grant every permission to every role.
 *
 * CURRENT PRODUCT POSTURE (Jake, 2026-10-02): all users get all permissions
 * right now. The granular permission infrastructure STAYS — every permission
 * check in the codebase remains enforced — but every role holds every
 * permission until the product owner says otherwise.
 *
 * When granular access is needed later, replace this migration's effect with
 * per-role grants (a new migration can revoke the blanket grants).
 *
 * NOTE FOR FUTURE MIGRATIONS: this migration only covers permissions that
 * exist in the `permissions` collection when it runs. Any later migration
 * that seeds a NEW permission must grant it to all roles itself while this
 * posture holds — otherwise the new permission will silently deny everyone.
 *
 * Idempotent: skips (roleId, permissionId) pairs that already exist; the
 * unique index idx_role_permissions_pk on (roleId, permissionId) makes
 * re-running a no-op.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

export const migration034: Migration = {
  version: '034_all_permissions_all_roles',
  description: 'Grant every permission to every role (all-users-get-all-permissions posture)',

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
