/**
 * 033_flows_permissions — seed the `flows:manage` and `flows:run`
 * permissions, and index the `flows` / `flow_runs` collections (ADR-022).
 *
 * Flows execute tools as their requester, so both permissions are
 * privileged: granted to Admin and AI Admin ONLY — never to User or
 * Developer (same posture as `syteline:ui` in migration 031).
 *
 * Idempotent: createIndex with a fixed name is a no-op when the index
 * already exists, and seed inserts swallow duplicate-key errors.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const PERMISSIONS = ['flows:manage', 'flows:run'] as const;
const GRANT_ROLES = ['Admin', 'AI Admin'] as const;

export const migration033: Migration = {
  version: '033_flows_permissions',
  description: 'Seed flows:manage / flows:run permissions (Admin, AI Admin only) and index flows + flow_runs',

  up: async (db: Db): Promise<void> => {
    const now = new Date();
    await insertManyIdempotent(
      coll(db, 'permissions'),
      PERMISSIONS.map((name) => ({ _id: randomUUID(), name, createdAt: now }))
    );

    const permDocs = await coll(db, 'permissions')
      .find({ name: { $in: [...PERMISSIONS] } })
      .project({ _id: 1 })
      .toArray();
    const roleDocs = await coll(db, 'roles')
      .find({ name: { $in: [...GRANT_ROLES] } })
      .project({ _id: 1 })
      .toArray();
    const grants = roleDocs.flatMap((r) =>
      permDocs.map((p) => ({
        _id: randomUUID(),
        roleId: r._id,
        permissionId: p._id,
      }))
    );
    await insertManyIdempotent(coll(db, 'role_permissions'), grants);

    const flows = db.collection('flows');
    // Flow lookup by (tenant, name); also backs the unique name constraint.
    await flows.createIndex(
      { tenantId: 1, name: 1 },
      { name: 'idx_flows_tenant_name', unique: true }
    );

    const runs = db.collection('flow_runs');
    // Idempotency: one live key per (tenant, key).
    await runs.createIndex(
      { tenantId: 1, idempotencyKey: 1 },
      { name: 'idx_flow_runs_tenant_idempotency', unique: true, sparse: true }
    );
    // Runner sweep: global { status: 'queued' } query, oldest first.
    // (The scheduler is intentionally cross-tenant; each run carries its
    // own tenantId and the runner acts per-run.)
    await runs.createIndex(
      { status: 1, createdAt: 1 },
      { name: 'idx_flow_runs_status_created' }
    );
    // Board listing: tenant runs with optional flow/status filter, newest first.
    await runs.createIndex(
      { tenantId: 1, flowName: 1, status: 1, createdAt: -1 },
      { name: 'idx_flow_runs_tenant_flow_status_created' }
    );
    // Per-requester listing, newest first.
    await runs.createIndex(
      { tenantId: 1, 'requestedBy.userId': 1, createdAt: -1 },
      { name: 'idx_flow_runs_tenant_requester_created' }
    );
  },
};
