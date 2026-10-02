/**
 * sessionManager.ts — at most ONE browser session per (tenantId, userId).
 *
 * Sessions are short-lived: an idle TTL and an absolute max duration
 * (both env-configurable) bound how long a logged-in browser lives. Every
 * acquire/release writes an audit event. The manager is driver-agnostic —
 * production injects the Playwright factory, tests inject the FakeDriver
 * factory — and login is performed by an injected `connect` step so the
 * manager itself never touches credentials.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { recordAudit } from '../../audit/audit.js';
import { Errors } from '../../errors.js';
import type { AuthContext } from '../../authz/permissions.js';
import type { UiDriver } from './driver.js';

export interface UiSessionRecord {
  sessionId: string;
  userId: string;
  tenantId: string;
  startedAt: Date;
  lastUsedAt: Date;
}

export interface UiSessionHandle {
  record: UiSessionRecord;
  driver: UiDriver;
  /** Mark the session as recently used (resets the idle clock). */
  touch(): void;
}

/**
 * Metadata-only snapshot of one live session. No secrets, no driver
 * handles — safe for ops UIs and tool results.
 */
export interface UiSessionInfo {
  sessionId: string;
  userId: string;
  tenantId: string;
  startedAt: Date;
  lastUsedAt: Date;
  /** Milliseconds since last activity, per the manager's clock. */
  idleMs: number;
  state: 'active';
}

/**
 * Create the driver for a new session. The factory receives the fresh
 * session record; the `connect` hook (passed to acquire) performs login.
 */
export type UiDriverFactory = (record: UiSessionRecord) => Promise<UiDriver>;

/** Login step run inside acquire, after the driver is created. */
export type UiConnectFn = (driver: UiDriver, signal: AbortSignal) => Promise<void>;

export interface UiSessionManagerOptions {
  driverFactory: UiDriverFactory;
  idleMs?: number;
  maxMs?: number;
  /** Injectable clock for deterministic tests. */
  now?: () => number;
}

const sessionKey = (tenantId: string, userId: string): string => `${tenantId}:${userId}`;

export class UiSessionManager {
  private readonly sessions = new Map<string, UiSessionHandle>();
  /** In-flight acquire promises per key: concurrent acquires share one session. */
  private readonly inflight = new Map<string, Promise<UiSessionHandle>>();
  private readonly driverFactory: UiDriverFactory;
  private readonly idleMs: number;
  private readonly maxMs: number;
  private readonly now: () => number;

  constructor(options: UiSessionManagerOptions) {
    this.driverFactory = options.driverFactory;
    this.idleMs = options.idleMs ?? config.SYTELINE_UI_SESSION_IDLE_MS;
    this.maxMs = options.maxMs ?? config.SYTELINE_UI_SESSION_MAX_MS;
    this.now = options.now ?? Date.now;
  }

  private isExpired(record: UiSessionRecord, now: number): boolean {
    return (
      now - record.lastUsedAt.getTime() > this.idleMs ||
      now - record.startedAt.getTime() > this.maxMs
    );
  }

  /** Close and drop every expired session. Runs at the start of acquire. */
  async sweep(): Promise<number> {
    const now = this.now();
    let swept = 0;
    for (const [key, handle] of [...this.sessions.entries()]) {
      if (this.isExpired(handle.record, now)) {
        await this.drop(key, handle, 'expired');
        swept += 1;
      }
    }
    return swept;
  }

  /**
   * Acquire the caller's browser session, creating (and connecting) it when
   * absent or expired. At most one live session per (tenantId, userId):
   * concurrent acquires for the same key share the session — the connect
   * step runs once, guarded by an in-flight promise.
   */
  async acquire(
    auth: Pick<AuthContext, 'tenantId' | 'userId'>,
    options: { connect: UiConnectFn; signal: AbortSignal; requestId?: string },
  ): Promise<UiSessionHandle> {
    await this.sweep();
    const key = sessionKey(auth.tenantId, auth.userId);
    const existing = this.sessions.get(key);
    if (existing) {
      existing.touch();
      return existing;
    }
    const ongoing = this.inflight.get(key);
    if (ongoing) return ongoing;
    const pending = this.createSession(auth, key, options).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  private async createSession(
    auth: Pick<AuthContext, 'tenantId' | 'userId'>,
    key: string,
    options: { connect: UiConnectFn; signal: AbortSignal; requestId?: string },
  ): Promise<UiSessionHandle> {
    const now = new Date(this.now());
    const record: UiSessionRecord = {
      sessionId: randomUUID(),
      userId: auth.userId,
      tenantId: auth.tenantId,
      startedAt: now,
      lastUsedAt: now,
    };
    const driver = await this.driverFactory(record);
    try {
      await options.connect(driver, options.signal);
    } catch (error) {
      // A failed login must not leave a half-connected browser behind.
      await driver.close().catch(() => undefined);
      throw error;
    }
    const handle: UiSessionHandle = {
      record,
      driver,
      touch: () => {
        record.lastUsedAt = new Date(this.now());
      },
    };
    this.sessions.set(key, handle);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: options.requestId,
      action: 'SYTELINE_UI_SESSION_STARTED',
      success: true,
      metadata: { sessionId: record.sessionId },
    });
    return handle;
  }

  /** The caller's live session, or null when none exists. */
  peek(auth: Pick<AuthContext, 'tenantId' | 'userId'>): UiSessionHandle | null {
    const handle = this.sessions.get(sessionKey(auth.tenantId, auth.userId)) ?? null;
    if (handle && this.isExpired(handle.record, this.now())) return null;
    return handle;
  }

  /**
   * Metadata-only snapshot of the tenant's live (non-expired) sessions.
   * No secrets, no driver handles — safe for ops UIs and tool results.
   * Expired sessions are omitted (they are swept on the next acquire).
   */
  listSessions(tenantId: string): UiSessionInfo[] {
    const now = this.now();
    const out: UiSessionInfo[] = [];
    for (const handle of this.sessions.values()) {
      const record = handle.record;
      if (record.tenantId !== tenantId) continue;
      if (this.isExpired(record, now)) continue;
      out.push({
        sessionId: record.sessionId,
        userId: record.userId,
        tenantId: record.tenantId,
        startedAt: record.startedAt,
        lastUsedAt: record.lastUsedAt,
        idleMs: now - record.lastUsedAt.getTime(),
        state: 'active',
      });
    }
    return out;
  }

  /** Close and drop the caller's session. No-op when none exists. */
  async release(
    auth: Pick<AuthContext, 'tenantId' | 'userId'>,
    reason: string,
    requestId?: string,
  ): Promise<boolean> {
    const key = sessionKey(auth.tenantId, auth.userId);
    const handle = this.sessions.get(key);
    if (!handle) return false;
    await this.drop(key, handle, reason, requestId, auth);
    return true;
  }

  private async drop(
    key: string,
    handle: UiSessionHandle,
    reason: string,
    requestId?: string,
    auth?: Pick<AuthContext, 'tenantId' | 'userId'>,
  ): Promise<void> {
    this.sessions.delete(key);
    await handle.driver.close().catch(() => undefined);
    const durationMs = this.now() - handle.record.startedAt.getTime();
    await recordAudit({
      tenantId: auth?.tenantId ?? handle.record.tenantId,
      userId: auth?.userId ?? handle.record.userId,
      requestId,
      action: 'SYTELINE_UI_SESSION_ENDED',
      success: true,
      metadata: { sessionId: handle.record.sessionId, reason, durationMs },
    });
  }

  /** Test seam: number of live sessions. */
  get size(): number {
    return this.sessions.size;
  }
}
