/**
 * 006_learning_flywheel — feedback, fine-tune datasets and jobs (ADR-015).
 *
 * Collections:
 *  - feedback:          user ratings/corrections on assistant messages.
 *  - finetune_datasets: immutable SFT datasets built from approved feedback.
 *  - finetune_jobs:     durable queue + status for fine-tune jobs (also the
 *                       claim queue for self-hosted `local` GPU workers).
 *
 * Also seeds the new permissions (feedback:submit, feedback:curate,
 * finetune:manage) and grants them per ROLE_PERMISSIONS in
 * src/authz/permissions.ts. Idempotent: safe to re-run.
 *
 * `_id` conventions: UUID strings everywhere (ADR-014).
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const NEW_PERMISSIONS = ['feedback:submit', 'feedback:curate', 'finetune:manage'] as const;

// Mirrors ROLE_PERMISSIONS in src/authz/permissions.ts. Note the migration
// snapshots of 001_init do NOT see later permission additions, so Admin must
// be granted explicitly here for existing databases (on fresh databases
// 001 seeds the old snapshot and this migration adds the rest).
const NEW_GRANTS: Record<string, readonly string[]> = {
  User: ['feedback:submit'],
  Developer: ['feedback:submit'],
  Admin: ['feedback:submit', 'feedback:curate', 'finetune:manage'],
  'AI Admin': ['feedback:curate', 'finetune:manage'],
};

export const migration006: Migration = {
  version: '006_learning_flywheel',
  description:
    'Learning flywheel collections (feedback, finetune_datasets, finetune_jobs) with indexes and permission seeds',

  up: async (db: Db): Promise<void> => {
    // ------------------------------------------------------------------
    // feedback
    // ------------------------------------------------------------------
    await db
      .collection('feedback')
      .createIndex({ tenantId: 1, createdAt: -1 }, { name: 'idx_feedback_tenant_created' });
    await db
      .collection('feedback')
      .createIndex({ tenantId: 1, status: 1 }, { name: 'idx_feedback_tenant_status' });
    await db
      .collection('feedback')
      .createIndex({ tenantId: 1, userId: 1 }, { name: 'idx_feedback_tenant_user' });

    // ------------------------------------------------------------------
    // finetune_datasets
    // ------------------------------------------------------------------
    await db.collection('finetune_datasets').createIndex(
      { tenantId: 1, name: 1 },
      { unique: true, name: 'idx_finetune_datasets_tenant_name' }
    );
    await db
      .collection('finetune_datasets')
      .createIndex({ tenantId: 1, createdAt: -1 }, { name: 'idx_finetune_datasets_tenant_created' });

    // ------------------------------------------------------------------
    // finetune_jobs (also the local-worker claim queue)
    // ------------------------------------------------------------------
    await db
      .collection('finetune_jobs')
      .createIndex({ tenantId: 1, createdAt: -1 }, { name: 'idx_finetune_jobs_tenant_created' });
    await db
      .collection('finetune_jobs')
      .createIndex({ tenantId: 1, status: 1 }, { name: 'idx_finetune_jobs_tenant_status' });
    // Worker claim scan: oldest queued job first.
    await db
      .collection('finetune_jobs')
      .createIndex(
        { status: 1, createdAt: 1 },
        { name: 'idx_finetune_jobs_claim', partialFilterExpression: { status: 'queued' } }
      );

    // ------------------------------------------------------------------
    // Permission seeds (idempotent via unique indexes + ordered:false)
    // ------------------------------------------------------------------
    const now = new Date();
    await insertManyIdempotent(
      coll(db, 'permissions'),
      NEW_PERMISSIONS.map((name) => ({ _id: randomUUID(), name, createdAt: now }))
    );

    const roleDocs = await coll(db, 'roles')
      .find({ name: { $in: Object.keys(NEW_GRANTS) } })
      .project({ _id: 1, name: 1 })
      .toArray();
    const permDocs = await coll(db, 'permissions')
      .find({ name: { $in: [...NEW_PERMISSIONS] } })
      .project({ _id: 1, name: 1 })
      .toArray();
    const roleIdByName = new Map(roleDocs.map((r) => [r.name, r._id]));
    const permIdByName = new Map(permDocs.map((p) => [p.name, p._id]));

    const grants: Array<{ _id: string; roleId: string; permissionId: string }> = [];
    for (const [roleName, permNames] of Object.entries(NEW_GRANTS)) {
      const roleId = roleIdByName.get(roleName);
      if (!roleId) continue;
      for (const permName of permNames) {
        const permissionId = permIdByName.get(permName);
        if (!permissionId) continue;
        grants.push({ _id: randomUUID(), roleId, permissionId });
      }
    }
    await insertManyIdempotent(coll(db, 'role_permissions'), grants);
  },
};
