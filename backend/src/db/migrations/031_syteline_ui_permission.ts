/**
 * 031_syteline_ui_permission — seed the `syteline:ui` permission.
 *
 * The agentic SyteLine UI automation tools (syteline.ui.*) drive the
 * SyteLine web client as the requesting user, so the permission is
 * privileged: granted to Admin and AI Admin ONLY — never to User or
 * Developer.
 *
 * Also creates the unique index backing the credential store's
 * one-document-per-(tenant,user) upsert on `syteline_credentials`.
 *
 * Idempotent: safe to re-run.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const PERMISSION = 'syteline:ui';
const GRANT_ROLES = ['Admin', 'AI Admin'] as const;

export const migration031: Migration = {
  version: '031_syteline_ui_permission',
  description: 'Seed syteline:ui permission (Admin, AI Admin only) and the syteline_credentials unique index',

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

    // One credential document per (tenant, user): the store upserts on this key.
    await db.collection('syteline_credentials').createIndex(
      { tenantId: 1, userId: 1 },
      { name: 'idx_syteline_credentials_tenant_user', unique: true }
    );
  },
};
