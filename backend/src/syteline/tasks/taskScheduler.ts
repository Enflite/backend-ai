/**
 * taskScheduler.ts — in-process SyteLine task-runner scheduler (DESIGN.md §11.3).
 *
 * Polls for `assigned` tasks every SYTELINE_TASK_RUNNER_INTERVAL_MS and
 * runs the claim→plan→execute→report pipeline via processAssignedTasks.
 * Started at server startup, stopped at shutdown (preClose hook in
 * server.ts). The timer is unref'd so it never keeps the process alive on
 * its own, and sweeps never overlap: a slow sweep delays the next one
 * rather than stacking.
 *
 * The whole scheduler is fail-closed behind SYTELINE_TASK_RUNNER_ENABLED
 * (default false): when off, the timer still exists but every sweep is a
 * no-op, and tasks simply wait in `assigned`.
 *
 * Multi-instance deployments: every instance runs the scheduler; the
 * atomic findOneAndUpdate claim in claimTask makes concurrent sweeps safe
 * (a task claimed by one instance is invisible to the other).
 */

import { config } from '../../config.js';
import { processAssignedTasks } from './taskRunner.js';

let timer: NodeJS.Timeout | null = null;
let runInFlight = false;
let kickRequested = false;

async function runOnce(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;
  try {
    const result = await processAssignedTasks();
    if (result.claimed > 0) {
      console.log(
        `SyteLine task runner sweep: ${result.claimed} task(s) claimed, ` +
          `${result.succeeded} completed, ${result.blocked} blocked`,
      );
    }
  } catch (error) {
    console.error('SyteLine task runner sweep failed', error);
  } finally {
    runInFlight = false;
    if (kickRequested) {
      kickRequested = false;
      void runOnce();
    }
  }
}

/** Test seam. */
export function isTaskRunnerSchedulerRunning(): boolean {
  return timer !== null;
}

export function startTaskRunnerScheduler(): void {
  if (timer) return;
  const intervalMs = config.SYTELINE_TASK_RUNNER_INTERVAL_MS;
  timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  console.log(
    `SyteLine task runner scheduler started (every ${intervalMs}ms; ` +
      `enabled=${config.SYTELINE_TASK_RUNNER_ENABLED})`,
  );
}

export function stopTaskRunnerScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Trigger an out-of-band sweep (e.g. right after `syteline.task.create`).
 * Fire-and-forget: if a sweep is already running, the request is queued
 * and honored when it finishes. No-op when the runner is disabled.
 */
export function kickTaskRunner(): void {
  if (!config.SYTELINE_TASK_RUNNER_ENABLED) return;
  if (runInFlight) {
    kickRequested = true;
    return;
  }
  void runOnce();
}
