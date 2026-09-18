/**
 * scheduler.ts — in-process retention purge scheduler (Phase 5c).
 *
 * Runs purgeAllTenants() every RETENTION_PURGE_INTERVAL_HOURS. Started at
 * server startup, stopped at shutdown (preClose hook in server.ts). The
 * timer is unref'd so it never keeps the process alive on its own, and
 * runs never overlap: a slow sweep delays the next one rather than
 * stacking.
 *
 * Multi-instance deployments: every instance runs the scheduler; the
 * batched, idempotent DELETEs make concurrent sweeps safe (a row deleted
 * by one instance is simply not found by the other).
 */

import { config } from '../config.js';
import { purgeAllTenants } from './purge.js';

let timer: NodeJS.Timeout | null = null;
let runInFlight = false;

async function runOnce(): Promise<void> {
  if (runInFlight) return;
  runInFlight = true;
  try {
    const result = await purgeAllTenants();
    console.log(
      `Retention purge sweep: ${result.tenants} tenant(s), ` +
        `${result.counts.conversations} conversations, ${result.counts.messages} messages, ` +
        `${result.counts.auditEvents} audit events purged` +
        (result.failed.length > 0 ? `; ${result.failed.length} tenant(s) failed` : '') +
        (result.globalAuditPurgeError ? '; platform-global audit purge failed' : '')
    );
  } catch (error) {
    console.error('Retention purge sweep failed', error);
  } finally {
    runInFlight = false;
  }
}

/** Test seam. */
export function isRetentionSchedulerRunning(): boolean {
  return timer !== null;
}

export function startRetentionScheduler(): void {
  if (timer) return;
  const intervalMs = config.RETENTION_PURGE_INTERVAL_HOURS * 3600 * 1000;
  timer = setInterval(() => void runOnce(), intervalMs);
  timer.unref?.();
  console.log(`Retention scheduler started (every ${config.RETENTION_PURGE_INTERVAL_HOURS}h)`);
}

export function stopRetentionScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
