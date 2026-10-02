/**
 * flowScheduler.ts — in-process flow-run scheduler (ADR-022).
 *
 * Polls for `queued` flow runs every FLOW_RUNNER_INTERVAL_MS and runs the
 * claim→execute pipeline via processQueuedRuns. Started at server startup,
 * stopped at shutdown (preClose hook in server.ts). The timer is unref'd
 * so it never keeps the process alive on its own, and sweeps never
 * overlap: a slow sweep delays the next one rather than stacking.
 *
 * The whole scheduler is fail-closed behind FLOW_RUNNER_ENABLED (default
 * false): when off, the timer still exists but every sweep is a no-op,
 * and runs simply wait in `queued`.
 *
 * Multi-instance deployments: every instance runs the scheduler; the
 * atomic findOneAndUpdate claim in claimRun makes concurrent sweeps safe
 * (a run claimed by one instance is invisible to the other).
 */

import { config } from '../config.js';
import { processQueuedRuns } from './flowRunner.js';

let timer: NodeJS.Timeout | null = null;
let runInFlight = false;
let kickRequested = false;

async function runOnce(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;
  try {
    const result = await processQueuedRuns();
    if (result.claimed > 0) {
      console.log(
        `Flow runner sweep: ${result.claimed} run(s) claimed, ` +
          `${result.succeeded} completed, ${result.blocked} blocked`,
      );
    }
  } catch (error) {
    console.error('Flow runner sweep failed', error);
  } finally {
    runInFlight = false;
    if (kickRequested) {
      kickRequested = false;
      void runOnce();
    }
  }
}

/** Test seam. */
export function isFlowRunnerSchedulerRunning(): boolean {
  return timer !== null;
}

export function startFlowRunnerScheduler(): void {
  if (timer) return;
  const intervalMs = config.FLOW_RUNNER_INTERVAL_MS;
  timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  console.log(
    `Flow runner scheduler started (every ${intervalMs}ms; ` +
      `enabled=${config.FLOW_RUNNER_ENABLED})`,
  );
}

export function stopFlowRunnerScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Trigger an out-of-band sweep (e.g. right after a flow run is created
 * asynchronously). Fire-and-forget: if a sweep is already running, the
 * request is queued and honored when it finishes. No-op when the runner
 * is disabled.
 */
export function kickFlowRunner(): void {
  if (!config.FLOW_RUNNER_ENABLED) return;
  if (runInFlight) {
    kickRequested = true;
    return;
  }
  void runOnce();
}
