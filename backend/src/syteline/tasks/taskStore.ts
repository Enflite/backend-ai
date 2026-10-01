/**
 * taskStore.ts — Mongo persistence for the `syteline_tasks` collection
 * (DESIGN.md §11.1). Tenant-scoped everywhere: every filter carries
 * { tenantId } (no RLS in MongoDB, ADR-014).
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/mongo.js';
import type { AuthContext } from '../../authz/permissions.js';
import { Errors } from '../../errors.js';
import {
  type CreateTaskInput,
  type SytelineTaskDoc,
  type TaskAuthSnapshot,
  type TaskStatus,
  type TaskStepLog,
  TERMINAL_TASK_STATUSES,
} from './taskTypes.js';

export function snapshotRequesterAuth(
  auth: AuthContext,
  classification: string,
): TaskAuthSnapshot {
  return {
    userId: auth.userId,
    tenantId: auth.tenantId,
    email: auth.email,
    displayName: auth.displayName,
    clearance: auth.clearance,
    roleId: auth.roleId,
    roleName: auth.roleName,
    permissions: [...auth.permissions],
    classification,
  };
}

export async function createTask(
  auth: AuthContext,
  input: CreateTaskInput,
  classification: string,
  conversationId?: string,
): Promise<SytelineTaskDoc> {
  const now = new Date();
  const doc: SytelineTaskDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    requesterUserId: auth.userId,
    title: input.title,
    goal: input.goal,
    status: 'assigned',
    plan: [],
    steps: [],
    autoApproveWrites: input.autoApproveWrites ?? false,
    conversationId: conversationId ?? input.conversationId,
    authSnapshot: snapshotRequesterAuth(auth, classification),
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.collection<SytelineTaskDoc>('syteline_tasks').insertOne(doc);
  return doc;
}

export async function getTask(
  tenantId: string,
  taskId: string,
): Promise<SytelineTaskDoc | null> {
  const db = await getDb();
  return db
    .collection<SytelineTaskDoc>('syteline_tasks')
    .findOne({ _id: taskId, tenantId });
}

/**
 * Board listing: admins (tenant:manage) see the tenant's tasks; everyone
 * else sees only their own. Status filter is optional.
 */
export async function listTasks(
  tenantId: string,
  requesterUserId: string,
  isAdmin: boolean,
  status?: TaskStatus,
): Promise<SytelineTaskDoc[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = { tenantId };
  if (!isAdmin) filter.requesterUserId = requesterUserId;
  if (status) filter.status = status;
  return db
    .collection<SytelineTaskDoc>('syteline_tasks')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(100)
    .toArray();
}

/**
 * Atomic claim: `assigned` -> `in_progress` in a single findOneAndUpdate,
 * so concurrent backends (multi-instance deployments) can never double-run
 * the same task. Returns the claimed doc, or null when another runner won.
 */
export async function claimTask(
  tenantId: string,
  taskId: string,
  runnerId: string,
): Promise<SytelineTaskDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<SytelineTaskDoc>('syteline_tasks').findOneAndUpdate(
    { _id: taskId, tenantId, status: 'assigned' },
    {
      $set: {
        status: 'in_progress',
        runnerId,
        startedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
}

export async function savePlan(
  tenantId: string,
  taskId: string,
  plan: unknown[],
  steps: TaskStepLog[],
): Promise<void> {
  const db = await getDb();
  await db.collection<SytelineTaskDoc>('syteline_tasks').updateOne(
    { _id: taskId, tenantId },
    { $set: { plan, steps, updatedAt: new Date() } },
  );
}

export async function updateStep(
  tenantId: string,
  taskId: string,
  index: number,
  patch: Partial<TaskStepLog>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    set[`steps.${index}.${key}`] = value;
  }
  await db
    .collection<SytelineTaskDoc>('syteline_tasks')
    .updateOne({ _id: taskId, tenantId }, { $set: set });
}

export async function completeTask(
  tenantId: string,
  taskId: string,
  resultSummary: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  // Guarded: only an `in_progress` task may complete. A task cancelled (or
  // otherwise moved) mid-run keeps its newer state — the runner must never
  // silently resurrect a cancelled task.
  const res = await db.collection<SytelineTaskDoc>('syteline_tasks').updateOne(
    { _id: taskId, tenantId, status: 'in_progress' },
    {
      $set: {
        status: 'completed',
        resultSummary,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function blockTask(
  tenantId: string,
  taskId: string,
  blockedReason: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  // Same guard as completeTask: never overwrite a newer terminal state.
  const res = await db.collection<SytelineTaskDoc>('syteline_tasks').updateOne(
    { _id: taskId, tenantId, status: 'in_progress' },
    {
      $set: {
        status: 'blocked',
        blockedReason,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function cancelTask(
  tenantId: string,
  taskId: string,
): Promise<SytelineTaskDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<SytelineTaskDoc>('syteline_tasks').findOneAndUpdate(
    {
      _id: taskId,
      tenantId,
      status: { $nin: [...TERMINAL_TASK_STATUSES] },
    },
    { $set: { status: 'cancelled', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
}

export async function setResultSummary(
  tenantId: string,
  taskId: string,
  resultSummary: string,
): Promise<void> {
  const db = await getDb();
  await db.collection<SytelineTaskDoc>('syteline_tasks').updateOne(
    { _id: taskId, tenantId },
    { $set: { resultSummary, updatedAt: new Date() } },
  );
}

/** Oldest `assigned` tasks first, bounded per sweep. */
export async function findAssignedTasks(
  limit: number,
): Promise<SytelineTaskDoc[]> {
  const db = await getDb();
  return db
    .collection<SytelineTaskDoc>('syteline_tasks')
    .find({ status: 'assigned' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

/** Guard: a task may be viewed/cancelled by its requester or an admin. */
export function assertTaskVisible(
  task: SytelineTaskDoc,
  requesterUserId: string,
  isAdmin: boolean,
): void {
  if (task.requesterUserId !== requesterUserId && !isAdmin) {
    throw Errors.notFound('TASK_NOT_FOUND', 'Task not found');
  }
}
