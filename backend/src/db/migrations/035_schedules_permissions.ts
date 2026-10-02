/**
 * 035_schedules_permissions — seed the `schedules:manage` and
 * `schedules:run` permissions, and index the `schedules` collection
 * plus the scheduleRef slice of `flow_runs` (ADR-023).
 * Access posture (Jake, 2026-10-02): ALL users hold ALL permissions for
 * now — the permission infrastructure (checks) stays enforced, but every
 * role is granted every permission. So both new permissions are granted
 * to every role here; granularity can be revisited later.
 *
 * Idempotent: createIndex with a fixed name is a no-op when the index
 * already exists, and seed inserts swallow duplicate-key errors.
 */
import { randomUUID } from 'node:crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll, insertManyIdempotent } from './helpers.js';

const PERMISSIONS = ['schedules:manage', 'schedules:run'] as const;
/** All-grant posture: every role holds every permission (for now). */
const GRANT_ROLES = [
  'User',
  'Admin',
  'Security Admin',
  'AI Admin',
  'Developer',
  'Read Only',
] as const;

export const migration035: Migration = {
  version: '035_schedules_permissions',
  description:
    'Seed schedules:manage / schedules:run permissions (granted to all roles per all-grant posture); index schedules + flow_runs.scheduleRef',

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

    const schedules = db.collection('schedules');
    // Schedule lookup by (tenant, name); backs the unique name constraint.
    await schedules.createIndex(
      { tenantId: 1, name: 1 },
      { name: 'idx_schedules_tenant_name', unique: true }
    );
    // Due-claim sweep: enabled + nextRunAt due, oldest first. Cross-tenant
    // by design — the scheduler is global and each schedule carries its own
    // tenantId (same posture as the flow_runs runner sweep).
    await schedules.createIndex(
      { enabled: 1, nextRunAt: 1 },
      { name: 'idx_schedules_due' }
    );

    const runs = db.collection('flow_runs');
    // Schedule stats view: runs fired by one schedule, newest first.
    await runs.createIndex(
      { tenantId: 1, 'scheduleRef.scheduleId': 1, createdAt: -1 },
      { name: 'idx_flow_runs_tenant_schedule_created' }
    );
  },
};
