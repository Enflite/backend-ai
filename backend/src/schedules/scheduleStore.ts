/**
 * scheduleStore.ts — Mongo persistence for the `schedules` collection
 * (Schedules platform, ADR-023).
 *
 * Tenant-scoped everywhere: every filter carries { tenantId } (no RLS in
 * MongoDB, ADR-014). Schedules reference published flows by name
 * (validated at write time) and execute as their runAsUserId, whose live
 * membership is re-resolved at fire time by the runner.
 *
 * The due-claim path (claimDueSchedules) is a two-step compare-and-swap:
 * the replacement nextRunAt depends on the schedule's trigger, which is
 * only known after reading the doc, so the CAS guards on the exact old
 * tick (`{_id, enabled: true, nextRunAt: oldTick}`). Concurrent backends
 * racing the same tick get `value: null` and back off — no double-fire.
 */

import { randomUUID } from 'node:crypto';
import type { Filter } from 'mongodb';
import { getDb } from '../db/mongo.js';
import type { AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { getFlow } from '../flows/flowStore.js';
import type { FlowRunStatus } from '../flows/flowTypes.js';
import {
  type CreateScheduleInput,
  type ScheduleDoc,
  type ScheduleStats,
  type ScheduleTickStatus,
  type UpdateScheduleInput,
  nextFireTime,
  CronNoOccurrenceError,
} from './scheduleTypes.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: unknown };
  return e?.code === 11000;
}

/**
 * Resolve the target flow, throwing FLOW_NOT_FOUND when it does not exist.
 * Schedules may target any existing flow; the runner resolves live-vs-pinned
 * versions at fire time (route layer, ADR-023).
 */
async function requireFlow(tenantId: string, flowName: string): Promise<void> {
  const flow = await getFlow(tenantId, flowName);
  if (!flow) {
    throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${flowName}" not found`);
  }
}

/**
 * Validate the schedule's runAs user: the user must exist and be a member
 * of this tenant. Fails closed (400) — the runner re-validates live at
 * fire time, but a schedule created for a stranger is a config error.
 */
async function requireRunAsUser(tenantId: string, userId: string): Promise<void> {
  const db = await getDb();
  const user = await db
    .collection<{ _id: string }>('users')
    .findOne({ _id: userId });
  const membership = user
    ? await db
        .collection<{ _id: string; userId: string; tenantId: string }>('memberships')
        .findOne({ userId, tenantId })
    : null;
  if (!user || !membership) {
    throw Errors.badRequest(
      'INVALID_RUN_AS_USER',
      `Run-as user "${userId}" does not exist or is not a member of this tenant`,
    );
  }
}

/**
 * Compute the next fire time for an enabled schedule. An enabled trigger
 * that produces no occurrence (e.g. `30 2 30 2 *`) is a config error, not
 * a scheduler problem — reject it at write time so it can never stall
 * the due-sweep silently.
 */
function computeNextRunAt(trigger: CreateScheduleInput['trigger'], now: Date): Date {
  try {
    return nextFireTime(trigger, now);
  } catch (error) {
    if (error instanceof CronNoOccurrenceError) {
      throw Errors.badRequest(
        'CRON_HAS_NO_OCCURRENCE',
        `Cron expression "${error.expression}" has no occurrence within 366 days`,
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

/**
 * Create a schedule. Validates the target flow exists, the runAs user is a
 * tenant member, and computes the first nextRunAt when enabled. Throws
 * SCHEDULE_NAME_CONFLICT (409) on duplicate (tenant, name).
 */
export async function createSchedule(
  auth: AuthContext,
  input: CreateScheduleInput,
): Promise<ScheduleDoc> {
  await requireFlow(auth.tenantId, input.target.flowName);
  await requireRunAsUser(auth.tenantId, input.runAsUserId);

  const now = new Date();
  const doc: ScheduleDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    name: input.name,
    title: input.title,
    description: input.description,
    target: input.target,
    trigger: input.trigger,
    inputs: input.inputs,
    confirmWrites: input.confirmWrites,
    enabled: input.enabled,
    runAsUserId: input.runAsUserId,
    nextRunAt: input.enabled ? computeNextRunAt(input.trigger, now) : null,
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  try {
    await db.collection<ScheduleDoc>('schedules').insertOne(doc);
  } catch (error: unknown) {
    if (isDuplicateKey(error)) {
      throw Errors.conflict(
        'SCHEDULE_NAME_CONFLICT',
        `Schedule "${input.name}" already exists`,
      );
    }
    throw error;
  }
  return doc;
}

/** Fetch a schedule by (tenant, name). */
export async function getSchedule(
  tenantId: string,
  name: string,
): Promise<ScheduleDoc | null> {
  const db = await getDb();
  return db.collection<ScheduleDoc>('schedules').findOne({ name, tenantId });
}

/** Fetch a schedule by (tenant, id) — used by the runner's run-now path. */
export async function getScheduleById(
  tenantId: string,
  scheduleId: string,
): Promise<ScheduleDoc | null> {
  const db = await getDb();
  return db.collection<ScheduleDoc>('schedules').findOne({ _id: scheduleId, tenantId });
}

export interface ListSchedulesOptions {
  enabled?: boolean;
  limit: number;
}

/** Newest first; optional enabled filter. */
export async function listSchedules(
  tenantId: string,
  options: ListSchedulesOptions,
): Promise<ScheduleDoc[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = { tenantId };
  if (options.enabled !== undefined) filter.enabled = options.enabled;
  return db
    .collection<ScheduleDoc>('schedules')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(options.limit)
    .toArray();
}

/**
 * Update a schedule. When the trigger or enabled flag changes, nextRunAt
 * is recomputed (null while disabled). When the target flow or runAs user
 * changes, both are re-validated. Throws SCHEDULE_NOT_FOUND (404) when
 * the (tenant, name) pair does not exist.
 */
export async function updateSchedule(
  tenantId: string,
  name: string,
  patch: UpdateScheduleInput,
): Promise<ScheduleDoc> {
  const db = await getDb();
  const current = await db.collection<ScheduleDoc>('schedules').findOne({ name, tenantId });
  if (!current) {
    throw Errors.notFound('SCHEDULE_NOT_FOUND', `Schedule "${name}" not found`);
  }

  if (patch.target && patch.target.flowName !== current.target.flowName) {
    await requireFlow(tenantId, patch.target.flowName);
  }
  if (patch.runAsUserId && patch.runAsUserId !== current.runAsUserId) {
    await requireRunAsUser(tenantId, patch.runAsUserId);
  }

  const nextTrigger = patch.trigger ?? current.trigger;
  const nextEnabled = patch.enabled ?? current.enabled;
  const triggerChanged = patch.trigger !== undefined && JSON.stringify(patch.trigger) !== JSON.stringify(current.trigger);

  const now = new Date();
  const set: Record<string, unknown> = { updatedAt: now };
  for (const [key, value] of Object.entries(patch)) {
    set[key] = value;
  }
  // Recompute nextRunAt whenever the firing surface changes (or the
  // schedule is re-enabled): stale ticks must never linger after a write.
  if (triggerChanged || patch.enabled !== undefined) {
    set.nextRunAt = nextEnabled ? computeNextRunAt(nextTrigger, now) : null;
  }

  const updated = await db.collection<ScheduleDoc>('schedules').findOneAndUpdate(
    { _id: current._id, tenantId },
    { $set: set },
    { returnDocument: 'after' },
  );
  if (!updated) {
    // Deleted between the read and the update — report not found.
    throw Errors.notFound('SCHEDULE_NOT_FOUND', `Schedule "${name}" not found`);
  }
  return updated;
}

/** Delete a schedule. Fired run history in flow_runs is kept (audit). */
export async function deleteSchedule(tenantId: string, name: string): Promise<void> {
  const db = await getDb();
  const res = await db.collection<ScheduleDoc>('schedules').deleteOne({ name, tenantId });
  if (res.deletedCount === 0) {
    throw Errors.notFound('SCHEDULE_NOT_FOUND', `Schedule "${name}" not found`);
  }
}

/** Disable a schedule: no more ticks fire until resumed (nextRunAt -> null). */
export async function pauseSchedule(
  tenantId: string,
  name: string,
): Promise<ScheduleDoc> {
  return updateSchedule(tenantId, name, { enabled: false });
}

/**
 * Re-enable a schedule: nextRunAt is recomputed from now, so a schedule
 * resumed after a long pause does not fire a burst of stale ticks.
 */
export async function resumeSchedule(
  tenantId: string,
  name: string,
): Promise<ScheduleDoc> {
  return updateSchedule(tenantId, name, { enabled: true });
}

// ---------------------------------------------------------------------------
// Due-claim sweep (atomic; safe under concurrent backends)
// ---------------------------------------------------------------------------

/** A claimed due schedule plus the tick (old fire time) that was claimed. */
export type ClaimedSchedule = ScheduleDoc & { tick: Date };

/**
 * Claim up to `limit` schedules whose nextRunAt is due. Per schedule:
 * read the earliest due tick, compute the following fire time from the
 * schedule's trigger, and CAS (enabled && nextRunAt == old tick) -> new
 * nextRunAt. A lost race returns value: null and the sweep moves on; the
 * winner's doc is returned with `tick` = the old fire time. Schedules are
 * claimed oldest-due first.
 */
export async function claimDueSchedules(
  now: Date,
  limit: number,
): Promise<ClaimedSchedule[]> {
  const db = await getDb();
  const coll = db.collection<ScheduleDoc>('schedules');
  const claimed: ClaimedSchedule[] = [];

  for (let i = 0; i < limit; i++) {
    // Note: cross-tenant by design — the scheduler is global and each
    // schedule carries its own tenantId (same posture as flow_runs).
    const due = await coll.findOne(
      { enabled: true, nextRunAt: { $lte: now } },
      { sort: { nextRunAt: 1 } },
    );
    if (!due || !due.nextRunAt) break;

    const oldTick = due.nextRunAt;
    // Compute the following fire time from NOW, not from the old tick:
    // missed ticks are skipped, never caught up (a schedule down for a
    // week must not fire a burst of stale ticks when the sweeper returns).
    const next = computeNextRunAt(due.trigger, now);

    const result = await coll.findOneAndUpdate(
      { _id: due._id, enabled: true, nextRunAt: oldTick },
      { $set: { nextRunAt: next, updatedAt: now } },
      { returnDocument: 'before', includeResultMetadata: true },
    );
    if (result.value) {
      claimed.push({ ...result.value, tick: oldTick });
    }
    // Lost the race: another backend claimed this tick first. Do not
    // re-read the same doc in this sweep — move on to the next due tick.
  }
  return claimed;
}

// ---------------------------------------------------------------------------
// Tick bookkeeping + stats
// ---------------------------------------------------------------------------

export interface TickPatch {
  lastRunAt: Date;
  lastRunId?: string;
  lastTickStatus: ScheduleTickStatus;
}

/** Record the outcome of a fired tick on the schedule (the run itself lives in flow_runs). */
export async function recordTick(
  tenantId: string,
  scheduleId: string,
  patch: TickPatch,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = {
    lastRunAt: patch.lastRunAt,
    lastTickStatus: patch.lastTickStatus,
    updatedAt: new Date(),
  };
  if (patch.lastRunId !== undefined) set.lastRunId = patch.lastRunId;
  await db
    .collection<ScheduleDoc>('schedules')
    .updateOne({ _id: scheduleId, tenantId }, { $set: set });
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Minimal projection shape for the stats aggregation. */
interface FlowRunStat {
  status: FlowRunStatus;
  createdAt: Date;
}

/**
 * Per-status run counts for a schedule, derived from flow_runs rows with a
 * matching scheduleRef (written by the runner's fire path): all-time and
 * trailing-30-day windows, plus the schedule's current fire state.
 * Throws SCHEDULE_NOT_FOUND (404) for an unknown schedule id.
 */
export async function getScheduleStats(
  tenantId: string,
  scheduleId: string,
): Promise<ScheduleStats> {
  const db = await getDb();
  const schedule = await getScheduleById(tenantId, scheduleId);
  if (!schedule) {
    throw Errors.notFound('SCHEDULE_NOT_FOUND', `Schedule "${scheduleId}" not found`);
  }

  // scheduleRef is written by the runner's fire path (ADR-023); the field
  // lands on FlowRunDoc with the runner workstream, so the filter is cast
  // rather than typed against today's shape.
  const filter = {
    tenantId,
    'scheduleRef.scheduleId': scheduleId,
  } as unknown as Filter<FlowRunStat>;

  const runs = await db
    .collection<FlowRunStat>('flow_runs')
    .find(filter, { projection: { status: 1, createdAt: 1 } })
    .toArray();

  const byStatus: ScheduleStats['byStatus'] = {};
  const last30Days: ScheduleStats['last30Days'] = {};
  const cutoff = Date.now() - THIRTY_DAYS_MS;
  for (const run of runs) {
    byStatus[run.status] = (byStatus[run.status] ?? 0) + 1;
    if (run.createdAt.getTime() >= cutoff) {
      last30Days[run.status] = (last30Days[run.status] ?? 0) + 1;
    }
  }

  return {
    scheduleId: schedule._id,
    scheduleName: schedule.name,
    nextRunAt: schedule.nextRunAt,
    enabled: schedule.enabled,
    lastRunAt: schedule.lastRunAt,
    lastRunId: schedule.lastRunId,
    lastTickStatus: schedule.lastTickStatus,
    byStatus,
    last30Days,
    totalRuns: runs.length,
  };
}
