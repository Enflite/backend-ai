/**
 * 032_syteline_tasks — indexes for the SyteLine task-agent system
 * (DESIGN.md §11.1).
 *
 * The `syteline_tasks` collection needs no permission seeding: the task
 * tools (syteline.task.*) reuse the existing `syteline:ui` permission
 * (migration 031, Admin / AI Admin only).
 *
 * Idempotent: createIndex with a fixed name is a no-op when the index
 * already exists. Safe to re-run.
 */
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';

export const migration032: Migration = {
  version: '032_syteline_tasks',
  description: 'Indexes for the syteline_tasks collection (task-agent kanban + runner sweep)',

  up: async (db: Db): Promise<void> => {
    const tasks = db.collection('syteline_tasks');
    // Runner sweep: global { status: 'assigned' } query, oldest first.
    // (The scheduler is intentionally cross-tenant; each task carries its
    // own tenantId and the runner acts per-task.)
    await tasks.createIndex(
      { status: 1, createdAt: 1 },
      { name: 'idx_syteline_tasks_status_created' }
    );
    // Admin board listing: tenant tasks with optional status filter, newest first.
    await tasks.createIndex(
      { tenantId: 1, status: 1, createdAt: -1 },
      { name: 'idx_syteline_tasks_tenant_status_created' }
    );
    // Per-requester listing, newest first.
    await tasks.createIndex(
      { tenantId: 1, requesterUserId: 1, createdAt: -1 },
      { name: 'idx_syteline_tasks_tenant_requester_created' }
    );
  },
};
