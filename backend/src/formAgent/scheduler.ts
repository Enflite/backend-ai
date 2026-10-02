/**
 * scheduler.ts — in-process scheduler for the SyteLine
 * Form AI Agent runner.
 *
 * Polls for `requested` customizations every
 * FORM_CUSTOMIZATION_RUNNER_INTERVAL_MS and runs the claim→plan→execute→report
 * pipeline via processRequestedCustomizations. Started at server startup,
 * stopped at shutdown (preClose hook in server.ts). The timer is unref'd
 * so it never keeps the process alive on its own, and sweeps never overlap:
 * a slow sweep delays the next one rather than stacking.
 *
 * The whole scheduler is fail-closed behind FORM_CUSTOMIZATION_RUNNER_ENABLED
 * (default false): when off, the timer still exists but every sweep is a
 * no-op, and runs simply wait in `requested`.
 *
 * Multi-instance deployments: every instance runs the scheduler; the
 * atomic findOneAndUpdate claim in claimCustomization makes concurrent
 * sweeps safe (a customization claimed by one instance is invisible to
 * the other).
 */

import { config } from '../config.js';
import { processRequestedCustomizations } from './runner.js';

let timer: NodeJS.Timeout | null = null;
let runInFlight = false;
let kickRequested = false;

async function runOnce(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;
  try {
    const result = await processRequestedCustomizations();
    if (result.claimed > 0) {
      console.log(
        `SyteLine Form AI Agent sweep: ${result.claimed} customization(s) claimed, ` +
          `${result.succeeded} awaiting review, ${result.blocked} blocked`,
      );
    }
  } catch (error) {
    console.error('SyteLine Form AI Agent sweep failed', error);
  } finally {
    runInFlight = false;
    if (kickRequested) {
      kickRequested = false;
      void runOnce();
    }
  }
}

/** Test seam. */
export function isFormAgentSchedulerRunning(): boolean {
  return timer !== null;
}

export function startFormAgentScheduler(): void {
  if (timer) return;
  const intervalMs = config.FORM_CUSTOMIZATION_RUNNER_INTERVAL_MS;
  timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  console.log(
    `SyteLine Form AI Agent scheduler started (every ${intervalMs}ms; ` +
      `enabled=${config.FORM_CUSTOMIZATION_RUNNER_ENABLED})`,
  );
}

export function stopFormAgentScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/**
 * Trigger an out-of-band sweep (e.g. right after POST /form-customizations).
 * Fire-and-forget: if a sweep is already running, the request is queued
 * and honored when it finishes. No-op when the runner is disabled.
 */
export function kickFormAgentRunner(): void {
  if (!config.FORM_CUSTOMIZATION_RUNNER_ENABLED) return;
  if (runInFlight) {
    kickRequested = true;
    return;
  }
  void runOnce();
}
