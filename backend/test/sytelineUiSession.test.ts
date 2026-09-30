/**
 * sytelineUiSession.test.ts — UiSessionManager lifecycle.
 *
 * - one session per (tenantId, userId); re-acquire returns the same session
 * - idle TTL expiry, absolute max-duration expiry
 * - release closes the driver and audits; double release is a no-op
 * - cross-tenant / cross-user sessions never mix
 * - failed login closes the half-created driver and never registers a session
 * - acquire/release audit events carry identifiers only
 *
 * Drives the deterministic FakeDriver; a real browser
 * REQUIRES REAL SYTELINE. VALIDATED IN CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { FakeDriver } from '../src/syteline/ui/fakeDriver.js';
import type { UiDriver } from '../src/syteline/ui/driver.js';
import { UiSessionManager } from '../src/syteline/ui/sessionManager.js';

const BASE_URL = 'https://syteline.example/web';

function loginDriver() {
  return FakeDriver.withLoginPage(BASE_URL, 'jsmith1', 's3cret');
}

function makeManager(now: () => number, onDriver?: (driver: FakeDriver) => void) {
  const drivers: FakeDriver[] = [];
  const manager = new UiSessionManager({
    driverFactory: async () => {
      const driver = loginDriver();
      drivers.push(driver);
      onDriver?.(driver);
      return driver;
    },
    idleMs: 300_000,
    maxMs: 1_800_000,
    now,
  });
  return { manager, drivers };
}

const AUTH = { tenantId: 'tenant-a', userId: 'user-a' };
const CONNECT = async (driver: UiDriver, signal: AbortSignal) => {
  const { loginSyteline } = await import('../src/syteline/ui/driver.js');
  await loginSyteline(driver, 'jsmith1', 's3cret', BASE_URL, signal);
};

let nowMs: number;
beforeEach(() => {
  vi.clearAllMocks();
  recordAuditMock.mockResolvedValue(undefined);
  nowMs = 1_000_000;
});

describe('UiSessionManager', () => {
  it('creates one session per user and reuses it on re-acquire', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const first = await manager.acquire(AUTH, { connect: CONNECT, signal: new AbortController().signal });
    const second = await manager.acquire(AUTH, { connect: CONNECT, signal: new AbortController().signal });
    expect(second.record.sessionId).toBe(first.record.sessionId);
    expect(drivers).toHaveLength(1);
    expect(manager.size).toBe(1);
  });

  it('keeps sessions scoped per tenant and per user', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    await manager.acquire(AUTH, { connect: CONNECT, signal });
    await manager.acquire({ tenantId: 'tenant-a', userId: 'user-b' }, { connect: CONNECT, signal });
    await manager.acquire({ tenantId: 'tenant-b', userId: 'user-a' }, { connect: CONNECT, signal });
    expect(manager.size).toBe(3);
    expect(drivers).toHaveLength(3);
    // Releasing one user's session leaves the others untouched.
    await manager.release(AUTH, 'test');
    expect(manager.size).toBe(2);
    expect(manager.peek({ tenantId: 'tenant-a', userId: 'user-b' })).not.toBeNull();
  });

  it('expires idle sessions and creates a fresh one', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    const first = await manager.acquire(AUTH, { connect: CONNECT, signal });
    nowMs += 300_001; // past the 5-minute idle TTL
    const second = await manager.acquire(AUTH, { connect: CONNECT, signal });
    expect(second.record.sessionId).not.toBe(first.record.sessionId);
    expect(drivers).toHaveLength(2);
    expect(drivers[0]!.isClosed).toBe(true);
  });

  it('expires sessions past the absolute max duration even when active', async () => {
    const { manager } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    const first = await manager.acquire(AUTH, { connect: CONNECT, signal });
    nowMs += 60_000;
    // Touch keeps it alive under the idle TTL...
    const still = await manager.acquire(AUTH, { connect: CONNECT, signal });
    expect(still.record.sessionId).toBe(first.record.sessionId);
    nowMs += 1_800_000; // ...but the absolute max duration wins.
    const second = await manager.acquire(AUTH, { connect: CONNECT, signal });
    expect(second.record.sessionId).not.toBe(first.record.sessionId);
  });

  it('release closes the driver, audits, and is a no-op when absent', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    await manager.acquire(AUTH, { connect: CONNECT, signal });
    expect(await manager.release(AUTH, 'user_requested')).toBe(true);
    expect(drivers[0]!.isClosed).toBe(true);
    expect(manager.peek(AUTH)).toBeNull();
    expect(await manager.release(AUTH, 'user_requested')).toBe(false);

    const ended = recordAuditMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === 'SYTELINE_UI_SESSION_ENDED',
    );
    expect(ended).toHaveLength(1);
    expect((ended[0]![0] as { metadata: Record<string, unknown> }).metadata.reason).toBe('user_requested');
  });

  it('a failed login closes the driver and never registers a session', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const badConnect = async (driver: UiDriver, signal: AbortSignal) => {
      const { loginSyteline } = await import('../src/syteline/ui/driver.js');
      await loginSyteline(driver, 'jsmith1', 'wrong-password', BASE_URL, signal);
    };
    await expect(
      manager.acquire(AUTH, { connect: badConnect, signal: new AbortController().signal }),
    ).rejects.toThrow();
    expect(manager.size).toBe(0);
    expect(drivers[0]!.isClosed).toBe(true);
    // No SESSION_STARTED audit for a session that never connected.
    const started = recordAuditMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === 'SYTELINE_UI_SESSION_STARTED',
    );
    expect(started).toHaveLength(0);
  });

  it('sweep drops expired sessions without an acquire', async () => {
    const { manager, drivers } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    await manager.acquire(AUTH, { connect: CONNECT, signal });
    nowMs += 400_000;
    expect(await manager.sweep()).toBe(1);
    expect(manager.size).toBe(0);
    expect(drivers[0]!.isClosed).toBe(true);
  });

  it('audit events carry identifiers only, never secrets', async () => {
    const { manager } = makeManager(() => nowMs);
    const signal = new AbortController().signal;
    await manager.acquire(AUTH, { connect: CONNECT, signal });
    await manager.release(AUTH, 'done');
    const serialized = JSON.stringify(recordAuditMock.mock.calls);
    expect(serialized).not.toContain('s3cret');
  });
});
