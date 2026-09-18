/**
 * Gateway fairness: in-process concurrency caps (counting semaphores) for the
 * expensive AI endpoints.
 *
 * A slot is acquired before a chat stream starts or a tool executes and is
 * released when it ends — on success, error, client abort, or server
 * shutdown. Both the tenant cap and the user cap must have room; when either
 * is exhausted the caller gets an honest HTTP 429 'busy' response, never a
 * silent drop.
 *
 * In-process per instance: two instances each allow the full caps. Front
 * multi-instance deployments with a shared limiter (see docs/deployment.md).
 * `NODE_ENV=test` suites exercise the limiter directly; route tests stub the
 * caps via environment before importing the route modules.
 */
import type { FastifyReply } from 'fastify';
import { config } from '../../config.js';

export const BUSY_MESSAGE =
  'The AI is at capacity right now — please retry in a few seconds.';

/** How long a rejected client is asked to wait before retrying. */
export const DEFAULT_BUSY_RETRY_AFTER_SECONDS = 3;

export interface ConcurrencyLimiterOptions {
  /** Max in-flight slots across the tenant (noisy-neighbor guard). */
  maxPerTenant: number;
  /** Max in-flight slots per user within the tenant. */
  maxPerUser: number;
  /** Seconds clients should wait before retrying after a rejection. */
  retryAfterSeconds?: number;
  /**
   * Optional shared tenant counter. When provided, the limiter draws its
   * tenant-wide counts from this map instead of a private one, so two
   * limiters (e.g. chat + direct tool execution) enforce ONE tenant ceiling.
   * Per-user counters always stay private to each limiter.
   */
  sharedTenantCounts?: Map<string, number>;
}

export type ConcurrencyAcquireResult =
  | { ok: true; release: () => void }
  | { ok: false; retryAfterSeconds: number };

export class ConcurrencyLimiter {
  private readonly tenantInFlight: Map<string, number>;
  private readonly userInFlight = new Map<string, number>();
  private readonly retryAfterSeconds: number;

  constructor(private readonly options: ConcurrencyLimiterOptions) {
    if (!Number.isInteger(options.maxPerTenant) || options.maxPerTenant < 1) {
      throw new Error('ConcurrencyLimiter: maxPerTenant must be a positive integer');
    }
    if (!Number.isInteger(options.maxPerUser) || options.maxPerUser < 1) {
      throw new Error('ConcurrencyLimiter: maxPerUser must be a positive integer');
    }
    this.tenantInFlight = options.sharedTenantCounts ?? new Map<string, number>();
    this.retryAfterSeconds =
      options.retryAfterSeconds ?? DEFAULT_BUSY_RETRY_AFTER_SECONDS;
  }

  /**
   * Try to take one slot for this tenant+user. Non-blocking: returns
   * immediately with `ok: false` when either cap is exhausted. The returned
   * `release` is idempotent and must be called exactly once per successful
   * acquire — callers wrap the protected section in try/finally.
   */
  tryAcquire(tenantId: string, userId: string): ConcurrencyAcquireResult {
    // User counts are namespaced by tenant: user ids are only unique within
    // their tenant, so a bare userId key would leak quota across tenants.
    const tenantKey = tenantId;
    const userKey = `${tenantId}:${userId}`;
    const tenantCount = this.tenantInFlight.get(tenantKey) ?? 0;
    const userCount = this.userInFlight.get(userKey) ?? 0;
    if (tenantCount >= this.options.maxPerTenant || userCount >= this.options.maxPerUser) {
      return { ok: false, retryAfterSeconds: this.retryAfterSeconds };
    }
    this.tenantInFlight.set(tenantKey, tenantCount + 1);
    this.userInFlight.set(userKey, userCount + 1);
    let released = false;
    const release = (): void => {
      if (released) return;
      released = true;
      decrement(this.tenantInFlight, tenantKey);
      decrement(this.userInFlight, userKey);
    };
    return { ok: true, release };
  }

  /** Current in-flight counts, for observability and tests. */
  inFlight(tenantId: string, userId: string): { tenant: number; user: number } {
    return {
      tenant: this.tenantInFlight.get(tenantId) ?? 0,
      user: this.userInFlight.get(`${tenantId}:${userId}`) ?? 0,
    };
  }
}

function decrement(counts: Map<string, number>, key: string): void {
  const current = counts.get(key) ?? 0;
  if (current <= 1) counts.delete(key);
  else counts.set(key, current - 1);
}

/**
 * The friendly capacity body every 429 in the gateway speaks: plain,
 * human-readable, no security lecture, no invented content. Flat shape (not
 * the nested `{ error: { code } }` envelope) so clients can branch on
 * `error === 'busy'` without knowing the rest of the API's error taxonomy.
 */
export function busyBody(retryAfterSeconds: number): {
  error: 'busy';
  message: string;
  retryAfterSeconds: number;
} {
  return { error: 'busy', message: BUSY_MESSAGE, retryAfterSeconds };
}

/**
 * Reply 429 with the friendly busy body and a Retry-After header. Use as an
 * early return BEFORE reply.hijack() — afterwards only raw writes work.
 */
export function replyBusy(reply: FastifyReply, retryAfterSeconds: number): FastifyReply {
  return reply
    .code(429)
    .header('Retry-After', String(retryAfterSeconds))
    .send(busyBody(retryAfterSeconds));
}

/**
 * Read the Retry-After the @fastify/rate-limit plugin already set on the
 * reply before throwing its 429; fall back when the header is absent (unit
 * tests, other 429 sources).
 */
export function retryAfterSecondsFromReply(reply: FastifyReply, fallback: number): number {
  try {
    const raw = reply.getHeader('retry-after');
    const parsed = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  } catch {
    // getHeader is unavailable on bare test stubs; use the fallback.
  }
  return fallback;
}

/**
 * The single tenant-wide in-flight counter shared by the chat and tool
 * limiters below. Module scope so both factories — constructed in different
 * route modules — enforce one tenant ceiling instead of two.
 */
const sharedTenantInFlight = new Map<string, number>();

/**
 * Limiter for chat streams: a slot covers the whole SSE stream including
 * agentic tool rounds. Built from config at module scope in the chat route.
 * Shares its tenant counter with the tool limiter.
 */
export function createChatConcurrencyLimiter(): ConcurrencyLimiter {
  return new ConcurrencyLimiter({
    maxPerTenant: config.AI_MAX_CONCURRENT_PER_TENANT,
    maxPerUser: config.AI_MAX_CONCURRENT_PER_USER,
    sharedTenantCounts: sharedTenantInFlight,
  });
}

/**
 * Limiter for direct tool executions (POST /tools/:name/execute). Tool calls
 * fan out, so the per-user cap is looser than the chat-stream cap; the tenant
 * cap is shared with chat so one tenant's tool storm cannot starve chat.
 */
export function createToolConcurrencyLimiter(): ConcurrencyLimiter {
  return new ConcurrencyLimiter({
    maxPerTenant: config.AI_MAX_CONCURRENT_PER_TENANT,
    maxPerUser: config.AI_MAX_CONCURRENT_TOOLS_PER_USER,
    retryAfterSeconds: 2,
    sharedTenantCounts: sharedTenantInFlight,
  });
}
