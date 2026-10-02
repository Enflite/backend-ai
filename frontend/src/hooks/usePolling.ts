import { useEffect, useRef } from 'react';

interface PollOptions {
  /** Poll interval in ms. Default 3000. */
  intervalMs?: number;
  /** When false the timer is stopped. Default true. */
  active?: boolean;
}

/** Upper bound for failure backoff. */
export const MAX_POLL_BACKOFF_MS = 60_000;

/**
 * Delay before the next tick after `consecutiveFailures` straight failures.
 * Doubles the base interval per failure, capped at `maxMs`. Pure and
 * exported for unit tests.
 */
export function backoffDelayMs(
  consecutiveFailures: number,
  baseMs: number,
  maxMs: number = MAX_POLL_BACKOFF_MS,
): number {
  if (consecutiveFailures <= 0) return baseMs;
  return Math.min(baseMs * 2 ** consecutiveFailures, maxMs);
}

/** Timer + page-visibility surface the polling core runs against. */
export interface PollerEnvironment {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  addVisibilityListener: (fn: () => void) => void;
  removeVisibilityListener: (fn: () => void) => void;
  isHidden: () => boolean;
}

const browserEnvironment: PollerEnvironment = {
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (id) => window.clearTimeout(id as number),
  addVisibilityListener: (fn) => document.addEventListener('visibilitychange', fn),
  removeVisibilityListener: (fn) => document.removeEventListener('visibilitychange', fn),
  isHidden: () => document.hidden,
};

/**
 * Framework-free polling core. Exported so it can be unit-tested with fake
 * timers/visibility; the hook below is a thin browser binding.
 *
 * Behavior:
 * - While the page is hidden, no timer runs at all — zero backend traffic.
 *   Becoming visible again fires one immediate refresh, then resumes.
 * - Consecutive callback failures back off (double the interval, capped at
 *   60s) instead of hammering a struggling backend; any success resets.
 * - Errors stay swallowed, as before — callers surface them through their
 *   own state on the initial load.
 *
 * Returns a dispose function that stops the timer and removes listeners.
 */
export function createPoller(
  env: PollerEnvironment,
  callback: () => void | Promise<void>,
  intervalMs: number,
): () => void {
  let consecutiveFailures = 0;
  let timer: unknown;
  let disposed = false;

  const schedule = (delayMs: number): void => {
    if (disposed) return;
    timer = env.setTimeout(run, delayMs);
  };

  const settle = (ok: boolean): void => {
    if (disposed) return;
    consecutiveFailures = ok ? 0 : consecutiveFailures + 1;
    schedule(backoffDelayMs(consecutiveFailures, intervalMs));
  };

  function run(): void {
    timer = undefined;
    if (disposed) return;
    if (env.isHidden()) {
      // Safety net (the visibility listener normally clears the timer
      // outright): don't hit the backend, just re-check at base cadence.
      schedule(intervalMs);
      return;
    }
    let result: void | Promise<void>;
    try {
      result = callback();
    } catch {
      settle(false);
      return;
    }
    if (result instanceof Promise) {
      result.then(
        () => settle(true),
        () => settle(false),
      );
    } else {
      settle(true);
    }
  }

  const onVisibilityChange = (): void => {
    if (timer !== undefined) {
      env.clearTimeout(timer);
      timer = undefined;
    }
    if (!env.isHidden()) {
      // Back in view: refresh immediately so data isn't stale, then resume.
      consecutiveFailures = 0;
      run();
    }
    // While hidden, no timer is scheduled — the tab goes fully quiet.
  };

  env.addVisibilityListener(onVisibilityChange);
  schedule(intervalMs);

  return () => {
    disposed = true;
    if (timer !== undefined) env.clearTimeout(timer);
    env.removeVisibilityListener(onVisibilityChange);
  };
}

/**
 * usePolling — re-run an async refresh on an interval while `active`.
 * The callback always sees the latest closure via ref; the timer is torn
 * down on unmount or when `active` flips false. Polling pauses while the
 * tab is hidden and backs off on consecutive failures (see createPoller).
 */
export function usePolling(
  callback: () => void | Promise<void>,
  { intervalMs = 3000, active = true }: PollOptions = {},
): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (!active || typeof document === 'undefined') return;
    return createPoller(browserEnvironment, () => ref.current(), intervalMs);
  }, [intervalMs, active]);
}
