/**
 * scheduleRunner.ts — execution layer for the Schedules platform (ADR-023).
 *
 * Turns claimed schedule ticks into flow runs:
 * - `fireDueSchedules(now, limit)` — the sweeper's workhorse. Claims due
 *   schedules (atomic, via the store), re-resolves the schedule owner's
 *   LIVE auth (a demoted/deactivated owner fails closed), resolves the
 *   target flow (pinned version or live alias), and creates a flow run
 *   stamped with the schedule's idempotency key and a `scheduleRef`.
 *   Never throws: every schedule is handled inside its own try/catch.
 * - `fireScheduleNow(auth, schedule, overrides)` — the interactive
 *   run-now path. The calling operator is the requester (their live auth
 *   from the request); the schedule's stored inputs/confirmWrites apply
 *   unless overridden for this one-off run.
 *
 * Approval gating (inherited from the Flows platform): `confirmWrites` on
 * the schedule IS the scoped human approval for writes in every run it
 * fires — the same semantics as an interactive flow run's confirmWrites.
 * Default false: a scheduled run is read-only/recon unless the schedule
 * owner explicitly approved writes on the schedule. Destructive tool
 * steps in a run with confirmWrites=false block per each tool's own
 * confirmation policy (runToolCall still enforces it).
 *
 * STORE CONTRACT (`scheduleStore.ts`):
 * - `claimDueSchedules(now: Date, limit: number): Promise<ClaimedSchedule[]>`
 *   Atomically claims due schedules, advancing each schedule's nextRunAt
 *   past the claimed tick in the same findOneAndUpdate (compare-and-swap).
 *   Returns the flat schedule doc plus `tick` (the claimed fire time, i.e.
 *   the schedule's previous nextRunAt) — the tick feeds the idempotency
 *   key so a crash between createRun and recordTick can never double-fire.
 * - `recordTick(tenantId: string, scheduleId: string, patch: TickPatch): Promise<void>`
 *   Records the outcome of one tick (lastRunAt / lastRunId /
 *   lastTickStatus). Never throws out of this module (failures are logged).
 * - `getSchedule(tenantId, name)`, `getScheduleById(tenantId, id)`,
 *   `getScheduleStats(tenantId, scheduleId)` — used by the HTTP routes.
 * - `createSchedule(auth, input)`, `listSchedules(tenantId, query)`,
 *   `updateSchedule(tenantId, name, patch, userId)` (throws
 *   SCHEDULE_NOT_FOUND), `deleteSchedule(tenantId, name)` (throws
 *   SCHEDULE_NOT_FOUND), `pauseSchedule(tenantId, name)` /
 *   `resumeSchedule(tenantId, name)` — CRUD used by the HTTP routes.
 */

import { randomUUID } from 'node:crypto';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import type { AuthContext } from '../authz/permissions.js';
import { liveRequesterAuth } from '../syteline/requesterAuth.js';
import {
  createRun,
  getFlow,
  getLiveDefinition,
  getVersion,
} from '../flows/flowStore.js';
import type { FlowRunDoc } from '../flows/flowTypes.js';
import { kickFlowRunner } from '../flows/flowScheduler.js';
import {
  claimDueSchedules,
  recordTick,
  type ClaimedSchedule,
  type TickPatch,
} from './scheduleStore.js';
import {
  type RunNowInput,
  type ScheduleDoc,
  type ScheduleTickStatus,
} from './scheduleTypes.js';

export interface FireDueSchedulesResult {
  claimed: number;
  triggered: number;
  skipped: number;
}

async function safeRecordTick(
  tenantId: string,
  scheduleId: string,
  patch: TickPatch,
): Promise<void> {
  try {
    await recordTick(tenantId, scheduleId, patch);
  } catch (error) {
    // The tick outcome is best-effort bookkeeping; the schedule itself was
    // already claimed atomically, so a failed write must not break the loop.
    console.error(`scheduleRunner: recordTick failed for schedule ${scheduleId}`, error);
  }
}

async function safeAudit(
  tenantId: string,
  userId: string,
  action: string,
  success: boolean,
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await recordAudit({ tenantId, userId, action, success, metadata });
  } catch (error) {
    console.error(`scheduleRunner: audit ${action} failed`, error);
  }
}

/**
 * Resolve the schedule's target to a concrete frozen flow version.
 * Throws FLOW_NOT_FOUND when the flow is gone, NO_LIVE_VERSION when the
 * live alias points at nothing (mirrors POST /flows/:name/pull).
 */
async function resolveTargetVersion(
  tenantId: string,
  target: ScheduleDoc['target'],
): Promise<{ version: number } | null> {
  if (target.version !== undefined) {
    const entry = await getVersion(tenantId, target.flowName, target.version);
    return entry ? { version: entry.version } : null;
  }
  const live = await getLiveDefinition(tenantId, target.flowName);
  return live ? { version: live.version } : null;
}

/**
 * Fire one claimed tick. Returns true when a flow run was created (or
 * already existed under the tick's idempotency key), false when the tick
 * was skipped. Never throws: tick bookkeeping and audit are best-effort.
 */
async function fireClaimedSchedule(
  schedule: ScheduleDoc,
  tick: Date,
  now: Date,
): Promise<boolean> {
  const tenantId = schedule.tenantId;
  const scheduleId = schedule._id;

  if (!schedule.enabled) {
    // Defensive: the store only claims due (enabled) schedules, but a
    // disabled schedule must never fire even if it slips through.
    await safeAudit(tenantId, schedule.runAsUserId, 'SCHEDULE_TRIGGER_SKIPPED', false, {
      scheduleName: schedule.name,
      flowName: schedule.target.flowName,
      reason: 'schedule-disabled',
    });
    return false;
  }

  // 1. Re-resolve the owner's LIVE auth. A demoted, deactivated, or removed
  // owner — or one who lost flows:run — fails closed: the tick is skipped
  // and audited, never run under a stale grant.
  let auth: AuthContext | null = null;
  try {
    auth = await liveRequesterAuth({
      _id: scheduleId,
      requesterUserId: schedule.runAsUserId,
      tenantId,
    });
  } catch (error) {
    console.error(`scheduleRunner: liveRequesterAuth failed for schedule ${schedule.name}`, error);
  }
  if (!auth || !auth.permissions.includes('flows:run')) {
    await safeRecordTick(tenantId, scheduleId, {
      lastRunAt: now,
      lastTickStatus: 'skipped-auth' satisfies ScheduleTickStatus,
    });
    await safeAudit(tenantId, schedule.runAsUserId, 'SCHEDULE_TRIGGER_SKIPPED', false, {
      scheduleName: schedule.name,
      flowName: schedule.target.flowName,
      reason: 'requester-lost-permission',
    });
    return false;
  }

  // 2. Resolve the target flow (pinned version or live alias).
  const resolved = await resolveTargetVersion(tenantId, schedule.target);
  if (!resolved) {
    await safeRecordTick(tenantId, scheduleId, {
      lastRunAt: now,
      lastTickStatus: 'skipped-flow-missing' satisfies ScheduleTickStatus,
    });
    await safeAudit(tenantId, schedule.runAsUserId, 'SCHEDULE_TRIGGER_SKIPPED', false, {
      scheduleName: schedule.name,
      flowName: schedule.target.flowName,
      version: schedule.target.version ?? null,
      reason: 'flow-missing',
    });
    return false;
  }

  // 3. Create the flow run. The idempotency key is scoped to (schedule,
  // tick): if a previous sweep crashed after createRun but before
  // recordTick, the retry returns the existing run instead of double-firing.
  let run: FlowRunDoc;
  try {
    const created = await createRun(
      auth,
      schedule.target.flowName,
      {
        inputs: schedule.inputs,
        confirmWrites: schedule.confirmWrites,
        version: resolved.version,
        idempotencyKey: `sched:${scheduleId}:${tick.toISOString()}`,
        scheduleRef: { scheduleId, scheduleName: schedule.name },
      },
      auth.clearance,
    );
    run = created.run;
  } catch (error) {
    await safeRecordTick(tenantId, scheduleId, {
      lastRunAt: now,
      lastTickStatus: 'create-failed' satisfies ScheduleTickStatus,
    });
    await safeAudit(tenantId, schedule.runAsUserId, 'SCHEDULE_TRIGGER_SKIPPED', false, {
      scheduleName: schedule.name,
      flowName: schedule.target.flowName,
      version: resolved.version,
      reason: 'create-failed',
      error: error instanceof Error ? error.message : 'unknown',
    });
    return false;
  }

  // 4. Success: bookkeeping + audit.
  await safeRecordTick(tenantId, scheduleId, {
    lastRunAt: now,
    lastRunId: run._id,
    lastTickStatus: 'triggered' satisfies ScheduleTickStatus,
  });
  await safeAudit(tenantId, schedule.runAsUserId, 'SCHEDULE_RUN_TRIGGERED', true, {
    scheduleName: schedule.name,
    flowName: schedule.target.flowName,
    version: resolved.version,
    runId: run._id,
    confirmWrites: schedule.confirmWrites,
  });
  return true;
}

/**
 * Claim due schedules and fire them. Never throws — a failing store claim
 * yields an empty result, and each schedule is isolated in its own
 * try/catch so one bad schedule cannot starve the rest.
 */
export async function fireDueSchedules(
  now: Date,
  limit: number,
): Promise<FireDueSchedulesResult> {
  const result: FireDueSchedulesResult = { claimed: 0, triggered: 0, skipped: 0 };
  let claims: ClaimedSchedule[];
  try {
    claims = await claimDueSchedules(now, limit);
  } catch (error) {
    console.error('scheduleRunner: claimDueSchedules failed', error);
    return result;
  }
  result.claimed = claims.length;
  for (const claimed of claims) {
    // Flat ClaimedSchedule: the schedule doc plus its claimed tick.
    const schedule: ScheduleDoc = claimed;
    const tick = claimed.tick;
    try {
      const fired = await fireClaimedSchedule(schedule, tick, now);
      if (fired) result.triggered += 1;
      else result.skipped += 1;
    } catch (error) {
      // Unreachable in practice (fireClaimedSchedule never throws), but the
      // loop must survive even if that invariant ever breaks.
      console.error(`scheduleRunner: schedule ${schedule.name} failed unexpectedly`, error);
      result.skipped += 1;
    }
  }
  if (result.triggered > 0) kickFlowRunner();
  return result;
}

/**
 * Interactive run-now: fire a schedule immediately as the calling operator.
 * The caller's own auth is the requester (no liveRequesterAuth re-resolution
 * — this is an explicit human action, not a background tick). The schedule's
 * stored inputs/confirmWrites apply unless overridden for this one-off run.
 *
 * confirmWrites semantics are identical to the background path: `true` here
 * IS the scoped human approval for writes in this run; `false` (default)
 * leaves destructive tool steps to block per each tool's confirmation policy.
 *
 * Throws FLOW_NOT_FOUND / NO_LIVE_VERSION when the target cannot be
 * resolved (mirrors the flows API error shapes).
 */
export async function fireScheduleNow(
  auth: AuthContext,
  schedule: ScheduleDoc,
  overrides: RunNowInput,
): Promise<FlowRunDoc> {
  const tenantId = schedule.tenantId;
  const resolved = await resolveTargetVersion(tenantId, schedule.target);
  if (!resolved) {
    const flow = await getFlow(tenantId, schedule.target.flowName);
    if (!flow) {
      throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${schedule.target.flowName}" not found`);
    }
    throw Errors.badRequest(
      'NO_LIVE_VERSION',
      `Flow "${schedule.target.flowName}" has no live version; publish one first`,
    );
  }
  const version = resolved.version;
  const confirmWrites = overrides.confirmWrites ?? schedule.confirmWrites;

  const { run } = await createRun(
    auth,
    schedule.target.flowName,
    {
      inputs: overrides.inputs ?? schedule.inputs,
      confirmWrites,
      version,
      idempotencyKey:
        overrides.idempotencyKey ?? `sched:${schedule._id}:manual:${randomUUID()}`,
      scheduleRef: { scheduleId: schedule._id, scheduleName: schedule.name },
    },
    auth.clearance,
  );

  await safeRecordTick(tenantId, schedule._id, {
    lastRunAt: new Date(),
    lastRunId: run._id,
    lastTickStatus: 'triggered' satisfies ScheduleTickStatus,
  });
  await safeAudit(tenantId, auth.userId, 'SCHEDULE_RUN_NOW', true, {
    scheduleName: schedule.name,
    flowName: schedule.target.flowName,
    version,
    runId: run._id,
    confirmWrites,
    manual: true,
  });
  kickFlowRunner();
  return run;
}
