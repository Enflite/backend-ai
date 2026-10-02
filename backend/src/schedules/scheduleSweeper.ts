/**
 * scheduleSweeper.ts — in-process schedule sweeper (ADR-023).
 *
 * Polls for due schedules every SCHEDULE_SWEEP_INTERVAL_MS and fires them
 * via fireDueSchedules (claim → create flow run). Started at server startup,
 * stopped at shutdown (preClose hook in server.ts). The timer is unref'd
 * so it never keeps the process alive on its own, and sweeps never
 * overlap: a slow sweep delays the next one rather than stacking.
 *
 * The whole sweeper is fail-closed behind SCHEDULES_ENABLED (default
 * false): when off, the timer still exists but every sweep is a silent
 * no-op, and due schedules simply wait.
 *
 * Multi-instance deployments: every instance runs the sweeper; the atomic
 * findOneAndUpdate claim in the store's claimDueSchedules makes concurrent
 * sweeps safe (a tick claimed by one instance is invisible to the other),
 * and the per-(schedule, tick) idempotency key on the created flow runs
 * makes retries safe.
 */

import { config } from '../config.js';
import { fireDueSchedules } from './scheduleRunner.js';

let timer: NodeJS.Timeout | null = null;
let sweepInFlight = false;
let kickRequested = false;

async function sweepOnce(): Promise<void> {
  // Fail-closed: no-op while the schedules platform is disabled.
  if (!config.SCHEDULES_ENABLED) return;
  if (sweepInFlight) return;
  sweepInFlight = true;
  try {
    const result = await fireDueSchedules(new Date(), config.SCHEDULE_SWEEP_LIMIT);
    if (result.claimed > 0) {
      console.log(
        `Schedule sweep: ${result.claimed} schedule(s) claimed, ` +
          `${result.triggered} run(s) triggered, ${result.skipped} skipped`,
      );
    }
  } catch (error) {
    // fireDueSchedules never throws; this is belt-and-braces.
    console.error('Schedule sweep failed', error);
  } finally {
    sweepInFlight = false;
    if (kickRequested) {
      kickRequested = false;
      void sweepOnce();
    }
  }
}

/** Test seam. */
export function isScheduleSweeperRunning(): boolean {
  return timer !== null;
}

export function startScheduleSweeper(): void {
  if (timer) return;
  const intervalMs = config.SCHEDULE_SWEEP_INTERVAL_MS;
  timer = setInterval(() => void sweepOnce(), intervalMs);
  timer.unref?.();
  console.log(
    `Schedule sweeper started (every ${intervalMs}ms; ` +
      `enabled=${config.SCHEDULES_ENABLED})`,
  );
}

export function stopScheduleSweeper(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Trigger an out-of-band sweep (e.g. right after a schedule is created or
 * resumed, so a due tick doesn't wait for the next interval).
 * Fire-and-forget: if a sweep is already running, the request is queued
 * and honored when it finishes. No-op when schedules are disabled.
 */
export function kickScheduleSweeper(): void {
  if (!config.SCHEDULES_ENABLED) return;
  if (sweepInFlight) {
    kickRequested = true;
    return;
  }
  void sweepOnce();
}
