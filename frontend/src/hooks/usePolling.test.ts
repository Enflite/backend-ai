import { describe, expect, it } from 'vitest';
import {
  backoffDelayMs,
  createPoller,
  MAX_POLL_BACKOFF_MS,
  type PollerEnvironment,
} from './usePolling';

interface FakeEnv extends PollerEnvironment {
  /** Fire the currently pending timer (throws if none). */
  fireNext: () => void;
  /** Number of timers currently pending. */
  pendingCount: () => number;
  /** Flip visibility and notify listeners. */
  setHidden: (hidden: boolean) => void;
  /** Delays passed to setTimeout, in order. */
  scheduledDelays: number[];
  /** Registered visibility listeners. */
  listenerCount: () => number;
}

function makeEnv(): FakeEnv {
  const listeners = new Set<() => void>();
  let hidden = false;
  let nextId = 1;
  const pending = new Map<number, () => void>();
  const scheduledDelays: number[] = [];

  const env: PollerEnvironment = {
    setTimeout: (fn, ms) => {
      const id = nextId++;
      pending.set(id, fn);
      scheduledDelays.push(ms);
      return id;
    },
    clearTimeout: (id) => {
      pending.delete(id as number);
    },
    addVisibilityListener: (fn) => {
      listeners.add(fn);
    },
    removeVisibilityListener: (fn) => {
      listeners.delete(fn);
    },
    isHidden: () => hidden,
  };

  return {
    ...env,
    fireNext: () => {
      const entry = pending.entries().next();
      if (entry.done) throw new Error('no pending timer');
      const [id, fn] = entry.value;
      pending.delete(id);
      fn();
    },
    pendingCount: () => pending.size,
    setHidden: (value: boolean) => {
      hidden = value;
      [...listeners].forEach((fn) => fn());
    },
    scheduledDelays,
    listenerCount: () => listeners.size,
  };
}

/** Let queued promise continuations run. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('backoffDelayMs', () => {
  it('returns the base interval with no failures', () => {
    expect(backoffDelayMs(0, 3000)).toBe(3000);
    expect(backoffDelayMs(-2, 3000)).toBe(3000);
  });

  it('doubles per consecutive failure', () => {
    expect(backoffDelayMs(1, 3000)).toBe(6000);
    expect(backoffDelayMs(2, 3000)).toBe(12000);
    expect(backoffDelayMs(3, 5000)).toBe(40000);
  });

  it('caps at the maximum', () => {
    expect(backoffDelayMs(100, 3000)).toBe(MAX_POLL_BACKOFF_MS);
    expect(backoffDelayMs(4, 5000)).toBe(60000);
    expect(backoffDelayMs(10, 3000, 10_000)).toBe(10_000);
  });
});

describe('createPoller', () => {
  it('polls on the base cadence while visible', async () => {
    const env = makeEnv();
    let calls = 0;
    const dispose = createPoller(env, () => {
      calls++;
    }, 3000);
    try {
      expect(env.pendingCount()).toBe(1);
      env.fireNext();
      await flush();
      expect(calls).toBe(1);
      expect(env.scheduledDelays.at(-1)).toBe(3000);
      env.fireNext();
      await flush();
      expect(calls).toBe(2);
    } finally {
      dispose();
    }
  });

  it('pauses while the tab is hidden and refreshes immediately on return', async () => {
    const env = makeEnv();
    let calls = 0;
    const dispose = createPoller(env, () => {
      calls++;
    }, 3000);
    try {
      env.fireNext();
      await flush();
      expect(calls).toBe(1);

      env.setHidden(true);
      // Timer cleared on hide: nothing pending, no backend traffic.
      expect(env.pendingCount()).toBe(0);
      expect(calls).toBe(1);

      env.setHidden(false);
      // Immediate refresh on becoming visible again.
      await flush();
      expect(calls).toBe(2);
      // …then resumes the normal cadence.
      expect(env.pendingCount()).toBe(1);
      expect(env.scheduledDelays.at(-1)).toBe(3000);
    } finally {
      dispose();
    }
  });

  it('backs off on consecutive failures and resets on success', async () => {
    const env = makeEnv();
    let failuresLeft = 2;
    const dispose = createPoller(
      env,
      () => {
        if (failuresLeft > 0) {
          failuresLeft--;
          return Promise.reject(new Error('backend down'));
        }
        return Promise.resolve();
      },
      3000,
    );
    try {
      env.fireNext(); // fails
      await flush();
      expect(env.scheduledDelays.at(-1)).toBe(6000);

      env.fireNext(); // fails again
      await flush();
      expect(env.scheduledDelays.at(-1)).toBe(12000);

      env.fireNext(); // succeeds
      await flush();
      expect(env.scheduledDelays.at(-1)).toBe(3000);
    } finally {
      dispose();
    }
  });

  it('backs off on synchronous throws too', async () => {
    const env = makeEnv();
    const dispose = createPoller(
      env,
      () => {
        throw new Error('sync boom');
      },
      5000,
    );
    try {
      env.fireNext();
      await flush();
      expect(env.scheduledDelays.at(-1)).toBe(10000);
    } finally {
      dispose();
    }
  });

  it('dispose stops timers and removes the visibility listener', () => {
    const env = makeEnv();
    let calls = 0;
    const dispose = createPoller(env, () => {
      calls++;
    }, 3000);
    expect(env.listenerCount()).toBe(1);
    dispose();
    expect(env.pendingCount()).toBe(0);
    expect(env.listenerCount()).toBe(0);
    env.setHidden(true);
    env.setHidden(false);
    expect(calls).toBe(0);
  });
});
