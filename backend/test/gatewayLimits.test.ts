/**
 * Phase 4b — gateway fairness: concurrency caps and rate limits.
 *
 * - Unit tests for ConcurrencyLimiter (acquire/release, tenant isolation,
 *   user isolation, 429 body shape, slot released on error, no leaks).
 * - Synthetic-load tests against the real chat + tool routes with a mocked
 *   provider layer: N concurrent requests above the cap must yield exactly
 *   `cap` in-flight (queued) requests and 429+Retry-After for the rest, with
 *   every slot released afterwards.
 *
 * The provider layer is mocked; no real model is ever hit.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { gatewayStream } = vi.hoisted(() => ({ gatewayStream: vi.fn() }));
const { runToolCall } = vi.hoisted(() => ({ runToolCall: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { listApprovedModelsForUser, getApprovedModelForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser: vi.fn(),
}));
const { resolveServingModel } = vi.hoisted(() => ({ resolveServingModel: vi.fn() }));
const { retrieveAuthorizedContext } = vi.hoisted(() => ({ retrieveAuthorizedContext: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/ai/gateway/gateway.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ai/gateway/gateway.js')>();
  return { ...mod, gatewayStream };
});
vi.mock('../src/tools/gateway.js', () => ({ runToolCall, toolRegistry: [] }));
// Per repo convention, the audit mock includes sanitizeReason.
vi.mock('../src/audit/audit.js', () => ({ recordAudit, sanitizeReason: (reason: string) => reason }));
vi.mock('../src/ai/gateway/modelLifecycle.js', () => ({ resolveServingModel }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser, getApprovedModelForUser }));
vi.mock('../src/rag/retrieval.js', () => ({ retrieveAuthorizedContext }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: (req.headers['x-test-user'] as string | undefined) ?? 'user-1',
      tenantId: 'tenant-1',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'user@example.test',
      displayName: 'User',
      roleName: 'User',
      clearance: 'INTERNAL',
      permissions: ['chat:create', 'tool:use'],
    };
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

type LimitsModule = typeof import('../src/ai/gateway/limits.js');
type ChatRoutesModule = typeof import('../src/chat/routes.js');
type ToolRoutesModule = typeof import('../src/tools/routes.js');

let limits: LimitsModule;
let chatModule: ChatRoutesModule;
let toolModule: ToolRoutesModule;

const TENANT = 'tenant-1';

beforeAll(async () => {
  // Stub caps BEFORE the route modules are imported: the limiters are built
  // from config at module scope.
  vi.stubEnv('AI_MAX_CONCURRENT_PER_TENANT', '100');
  vi.stubEnv('AI_MAX_CONCURRENT_PER_USER', '2');
  vi.stubEnv('AI_MAX_CONCURRENT_TOOLS_PER_USER', '2');
  vi.stubEnv('CHAT_RATE_LIMIT_PER_MIN', '1000');
  vi.stubEnv('TOOL_RATE_LIMIT_PER_MIN', '1000');
  limits = await import('../src/ai/gateway/limits.js');
  chatModule = await import('../src/chat/routes.js');
  toolModule = await import('../src/tools/routes.js');
});

afterAll(() => {
  vi.unstubAllEnvs();
});

const testModel = {
  id: 'm1',
  name: 'Test Model',
  version: '1',
  provider: 'vllm',
  endpoint: 'http://localhost:8000/v1',
  model_identifier: 'test-model',
  status: 'ACTIVE',
  context_window: 8192,
  capabilities: {},
  allowed_classifications: ['PUBLIC', 'INTERNAL'],
  deployment: {},
  request_timeout_ms: null,
  max_tokens: null,
  temperature: null,
  fallback_model_id: null,
};

function mockChatDb() {
  tenantQuery.mockImplementation(async (_tenantId: string, sql: string) => {
    if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1' }] };
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('INSERT INTO messages')) return { rows: [] };
    if (sql.includes('UPDATE conversations')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
}

async function* textOnly(text: string) {
  yield { type: 'text', content: text };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

async function waitFor(condition: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  mockChatDb();
  listApprovedModelsForUser.mockResolvedValue([testModel]);
  getApprovedModelForUser.mockResolvedValue(testModel);
  resolveServingModel.mockResolvedValue(null);
  retrieveAuthorizedContext.mockResolvedValue({ context: '', citations: [], results: [] });
  recordAudit.mockResolvedValue(undefined);
});

describe('ConcurrencyLimiter', () => {
  it('grants a slot and releases it', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 10, maxPerUser: 2 });
    const slot = limiter.tryAcquire('t1', 'u1');
    expect(slot.ok).toBe(true);
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 1, user: 1 });
    if (slot.ok) slot.release();
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 0, user: 0 });
  });

  it('enforces the per-user cap and reports the configured retry delay', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 100, maxPerUser: 2, retryAfterSeconds: 7 });
    const a = limiter.tryAcquire('t1', 'u1');
    const b = limiter.tryAcquire('t1', 'u1');
    const c = limiter.tryAcquire('t1', 'u1');
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(c).toEqual({ ok: false, retryAfterSeconds: 7 });
    if (a.ok) a.release();
    const d = limiter.tryAcquire('t1', 'u1');
    expect(d.ok).toBe(true);
    if (b.ok) b.release();
    if (d.ok) d.release();
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 0, user: 0 });
  });

  it('enforces the per-tenant cap across many users', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 2, maxPerUser: 10 });
    expect(limiter.tryAcquire('t1', 'u1').ok).toBe(true);
    expect(limiter.tryAcquire('t1', 'u2').ok).toBe(true);
    // u3 has no personal usage, but the tenant is full.
    expect(limiter.tryAcquire('t1', 'u3')).toEqual({ ok: false, retryAfterSeconds: 3 });
  });

  it('isolates users: one user at cap does not block another', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 100, maxPerUser: 1 });
    const a = limiter.tryAcquire('t1', 'u1');
    expect(a.ok).toBe(true);
    expect(limiter.tryAcquire('t1', 'u1').ok).toBe(false);
    const b = limiter.tryAcquire('t1', 'u2');
    expect(b.ok).toBe(true);
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 2, user: 1 });
    expect(limiter.inFlight('t1', 'u2')).toEqual({ tenant: 2, user: 1 });
    if (a.ok) a.release();
    if (b.ok) b.release();
  });

  it('isolates tenants: one tenant at cap does not block another, even for the same user id', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 1, maxPerUser: 10 });
    const a = limiter.tryAcquire('t1', 'u1');
    expect(a.ok).toBe(true);
    expect(limiter.tryAcquire('t1', 'u2').ok).toBe(false);
    // Same user id in a different tenant has its own quota.
    const b = limiter.tryAcquire('t2', 'u1');
    expect(b.ok).toBe(true);
    if (a.ok) a.release();
    if (b.ok) b.release();
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 0, user: 0 });
    expect(limiter.inFlight('t2', 'u1')).toEqual({ tenant: 0, user: 0 });
  });

  it('release is idempotent and never drives counts negative', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 10, maxPerUser: 2 });
    const slot = limiter.tryAcquire('t1', 'u1');
    expect(slot.ok).toBe(true);
    if (slot.ok) {
      slot.release();
      slot.release();
      slot.release();
    }
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 0, user: 0 });
    // A fresh acquire still works after over-release.
    expect(limiter.tryAcquire('t1', 'u1').ok).toBe(true);
  });

  it('releases the slot when the protected section throws (try/finally discipline)', () => {
    const limiter = new limits.ConcurrencyLimiter({ maxPerTenant: 10, maxPerUser: 2 });
    const slot = limiter.tryAcquire('t1', 'u1');
    expect(slot.ok).toBe(true);
    try {
      if (slot.ok) {
        try {
          throw new Error('provider exploded');
        } finally {
          slot.release();
        }
      }
    } catch {
      // expected
    }
    expect(limiter.inFlight('t1', 'u1')).toEqual({ tenant: 0, user: 0 });
  });

  it('rejects non-positive caps at construction', () => {
    expect(() => new limits.ConcurrencyLimiter({ maxPerTenant: 0, maxPerUser: 2 })).toThrow();
    expect(() => new limits.ConcurrencyLimiter({ maxPerTenant: 10, maxPerUser: -1 })).toThrow();
  });
});

describe('busy 429 body', () => {
  it('has the exact friendly shape', () => {
    expect(limits.busyBody(5)).toEqual({
      error: 'busy',
      message: 'The AI is at capacity right now — please retry in a few seconds.',
      retryAfterSeconds: 5,
    });
  });

  it('replyBusy sends 429 with the body and a Retry-After header', () => {
    const calls: { status?: number; headers: Record<string, string>; body?: unknown } = { headers: {} };
    const reply = {
      code(status: number) {
        calls.status = status;
        return this;
      },
      header(name: string, value: string) {
        calls.headers[name] = value;
        return this;
      },
      send(body: unknown) {
        calls.body = body;
        return this;
      },
    } as any;
    limits.replyBusy(reply, 3);
    expect(calls.status).toBe(429);
    expect(calls.headers['Retry-After']).toBe('3');
    expect(calls.body).toEqual({
      error: 'busy',
      message: 'The AI is at capacity right now — please retry in a few seconds.',
      retryAfterSeconds: 3,
    });
  });
});

describe('chat route concurrency (synthetic load)', () => {
  async function buildApp() {
    const app = Fastify();
    app.addHook('onRequest', (req: any, _reply, done) => {
      req.requestId = 'req-1';
      done();
    });
    await app.register(chatModule.chatRoutes, { prefix: '/api/v1' });
    return app;
  }

  function postChat(app: any, userId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/chat',
      headers: { 'x-test-user': userId },
      payload: { content: 'hello' },
    });
  }

  it('holds exactly the cap in flight, 429s the rest with Retry-After, and releases every slot', async () => {
    const app = await buildApp();
    const gate = deferred();
    gatewayStream.mockImplementation(async () => {
      await gate.promise; // hold the stream (and its slot) open until released
      return { events: textOnly('hello'), model: testModel, telemetry: {} };
    });

    const results: Array<{ status: number; body: string; retryAfter: string | undefined }> = [];
    // 5 concurrent chat requests from one user against a per-user cap of 2.
    const pending = Array.from({ length: 5 }, () =>
      postChat(app, 'user-1').then((res: any) => {
        results.push({
          status: res.statusCode,
          body: res.body,
          retryAfter: res.headers['retry-after'] as string | undefined,
        });
      })
    );

    // Exactly the cap may proceed into the (mocked) provider stream.
    await waitFor(() => gatewayStream.mock.calls.length === 2, '2 streams to start');
    // The other 3 must be rejected without ever reaching the provider.
    await waitFor(() => results.length === 3, '3 requests to be rejected');
    expect(gatewayStream.mock.calls.length).toBe(2);

    const rejected = results.filter((r) => r.status === 429);
    expect(rejected).toHaveLength(3);
    for (const r of rejected) {
      expect(JSON.parse(r.body)).toEqual({
        error: 'busy',
        message: 'The AI is at capacity right now — please retry in a few seconds.',
        retryAfterSeconds: 3,
      });
      expect(r.retryAfter).toBe('3');
    }
    expect(chatModule.chatConcurrency.inFlight(TENANT, 'user-1')).toEqual({ tenant: 2, user: 2 });

    // A different user is unaffected by user-1's exhaustion (user isolation).
    const otherUser = postChat(app, 'user-2').then((res: any) => {
      results.push({ status: res.statusCode, body: res.body, retryAfter: res.headers['retry-after'] });
    });
    await waitFor(() => gatewayStream.mock.calls.length === 3, 'other-user stream to start');
    expect(results.filter((r) => r.status === 429)).toHaveLength(3);

    // Release the streams; everything completes and no slot leaks.
    gate.resolve();
    await Promise.all([...pending, otherUser]);
    await app.close();

    const ok = results.filter((r) => r.status === 200);
    expect(ok).toHaveLength(3);
    expect(chatModule.chatConcurrency.inFlight(TENANT, 'user-1')).toEqual({ tenant: 0, user: 0 });
    expect(chatModule.chatConcurrency.inFlight(TENANT, 'user-2')).toEqual({ tenant: 0, user: 0 });
  });
});

describe('tool route concurrency (synthetic load)', () => {
  async function buildApp() {
    const app = Fastify();
    app.addHook('onRequest', (req: any, _reply, done) => {
      req.requestId = 'req-1';
      done();
    });
    await app.register(toolModule.toolRoutes, { prefix: '/api/v1' });
    return app;
  }

  function postExecute(app: any, userId: string) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/tools/echo/execute',
      headers: { 'x-test-user': userId },
      payload: { parameters: {}, classification: 'PUBLIC', confirmed: false },
    });
  }

  it('caps per-user in-flight tool executions, 429s the rest, and releases every slot', async () => {
    const app = await buildApp();
    const gate = deferred();
    runToolCall.mockImplementation(async () => {
      await gate.promise; // hold the execution (and its slot) open
      return { ok: true, executionId: 'exec-1', data: { x: 1 } };
    });

    const results: Array<{ status: number; body: string; retryAfter: string | undefined }> = [];
    // 4 concurrent executions from one user against a per-user cap of 2.
    const pending = Array.from({ length: 4 }, () =>
      postExecute(app, 'user-1').then((res: any) => {
        results.push({
          status: res.statusCode,
          body: res.body,
          retryAfter: res.headers['retry-after'] as string | undefined,
        });
      })
    );

    await waitFor(() => runToolCall.mock.calls.length === 2, '2 tool executions to start');
    await waitFor(() => results.length === 2, '2 requests to be rejected');

    const rejected = results.filter((r) => r.status === 429);
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      expect(JSON.parse(r.body)).toEqual({
        error: 'busy',
        message: 'The AI is at capacity right now — please retry in a few seconds.',
        retryAfterSeconds: 2,
      });
      expect(r.retryAfter).toBe('2');
    }
    expect(toolModule.toolConcurrency.inFlight(TENANT, 'user-1')).toEqual({ tenant: 2, user: 2 });

    gate.resolve();
    await Promise.all(pending);
    await app.close();

    expect(results.filter((r) => r.status === 200)).toHaveLength(2);
    expect(toolModule.toolConcurrency.inFlight(TENANT, 'user-1')).toEqual({ tenant: 0, user: 0 });
  });

  it('releases the slot when the tool call fails (no leak on error)', async () => {
    const app = await buildApp();
    runToolCall.mockResolvedValue({ ok: false, errorCode: 'TOOL_NOT_FOUND', message: 'nope' });

    const res = await postExecute(app, 'user-1');
    expect(res.statusCode).toBe(404);
    expect(toolModule.toolConcurrency.inFlight(TENANT, 'user-1')).toEqual({ tenant: 0, user: 0 });
    await app.close();
  });
});
