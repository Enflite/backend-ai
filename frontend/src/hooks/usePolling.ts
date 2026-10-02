import { useEffect, useRef } from 'react';

interface PollOptions {
  /** Poll interval in ms. Default 3000. */
  intervalMs?: number;
  /** When false the timer is stopped. Default true. */
  active?: boolean;
}

/**
 * usePolling — re-run an async refresh on an interval while `active`.
 * The callback always sees the latest closure via ref; the timer is torn
 * down on unmount or when `active` flips false. Errors are swallowed —
 * callers surface them through their own state on the initial load.
 */
export function usePolling(callback: () => void | Promise<void>, { intervalMs = 3000, active = true }: PollOptions = {}): void {
  const ref = useRef(callback);
  ref.current = callback;
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => {
      try {
        const result = ref.current();
        if (result instanceof Promise) result.catch(() => undefined);
      } catch {
        // Poll failures resolve on the next tick; the views keep last state.
      }
    }, intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, active]);
}
