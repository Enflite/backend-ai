import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';

import { createSseSender, SseRawSocket } from '../src/chat/routes.js';

/**
 * Deterministic fake for the hijacked raw response: the test controls
 * whether `write()` applies backpressure (returns false) and when the
 * socket drains.
 */
class FakeRaw extends EventEmitter implements SseRawSocket {
  writes: string[] = [];
  writeReturns = true;
  writableEnded = false;
  destroyed = false;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.writeReturns;
  }

  emitDrain(): void {
    this.emit('drain');
  }

  emitClose(): void {
    this.emit('close');
  }
}

describe('createSseSender', () => {
  it('sends frames immediately when the socket accepts them', async () => {
    const raw = new FakeRaw();
    const sender = createSseSender(raw);
    await expect(sender.send('delta', { content: 'hi' })).resolves.toBe(true);
    expect(raw.writes).toEqual(['event: delta\ndata: {"content":"hi"}\n\n']);
    expect(sender.pendingBytes()).toBe(0);
    expect(sender.backpressureAborted).toBe(false);
  });

  it('waits for drain on a slow consumer, then continues', async () => {
    const raw = new FakeRaw();
    raw.writeReturns = false;
    const sender = createSseSender(raw, { drainTimeoutMs: 1000 });
    const pending = sender.send('delta', { content: 'slow' });
    // The frame was queued while the socket was full: accounted, not lost.
    expect(sender.pendingBytes()).toBeGreaterThan(0);
    raw.writeReturns = true;
    raw.emitDrain();
    await expect(pending).resolves.toBe(true);
    expect(sender.pendingBytes()).toBe(0);
    expect(sender.backpressureAborted).toBe(false);
  });

  it('gives up when the drain timeout expires', async () => {
    const raw = new FakeRaw();
    raw.writeReturns = false;
    const sender = createSseSender(raw, { drainTimeoutMs: 20 });
    // No drain is ever emitted: the consumer is treated as dead.
    await expect(sender.send('delta', { content: 'nobody home' })).resolves.toBe(false);
    expect(sender.backpressureAborted).toBe(true);
  });

  it('aborts past the pending-bytes cap without waiting for drain', async () => {
    const raw = new FakeRaw();
    raw.writeReturns = false;
    const sender = createSseSender(raw, { maxPendingBytes: 64, drainTimeoutMs: 5000 });
    await expect(sender.send('delta', { content: 'x'.repeat(1024) })).resolves.toBe(false);
    expect(sender.backpressureAborted).toBe(true);
    // A second send fails fast: the stream is already torn down.
    await expect(sender.send('delta', { content: 'y' })).resolves.toBe(false);
  });

  it('releases a pending drain wait when the abort signal fires', async () => {
    const raw = new FakeRaw();
    raw.writeReturns = false;
    const controller = new AbortController();
    const sender = createSseSender(raw, { drainTimeoutMs: 5000, abortSignal: controller.signal });
    const pending = sender.send('delta', { content: 'waiting' });
    controller.abort();
    await expect(pending).resolves.toBe(false);
    expect(sender.backpressureAborted).toBe(true);
  });

  it('fails fast on a destroyed socket without writing', async () => {
    const raw = new FakeRaw();
    raw.destroyed = true;
    const sender = createSseSender(raw);
    await expect(sender.send('delta', { content: 'hi' })).resolves.toBe(false);
    expect(raw.writes).toEqual([]);
  });

  it('ping writes a heartbeat comment on a healthy socket', () => {
    const raw = new FakeRaw();
    const sender = createSseSender(raw);
    sender.ping();
    expect(raw.writes).toEqual([': ping\n\n']);
  });

  it('ping never queues behind a slow consumer', () => {
    const raw = new FakeRaw();
    raw.writeReturns = false;
    const sender = createSseSender(raw, { maxPendingBytes: 1024 * 1024 });
    for (let i = 0; i < 50; i += 1) sender.ping();
    // Only the first ping counted toward the cap; the rest were skipped
    // rather than buffered, so a stalled consumer cannot grow memory here.
    expect(sender.pendingBytes()).toBe(': ping\n\n'.length);
    expect(sender.backpressureAborted).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Route-level: a client that disconnects mid-stream must abort the provider
// request, and the partial turn must persist as interrupted metadata — never
// as a clean completion, and never with the legacy in-content marker.
// ---------------------------------------------------------------------------

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { listApprovedModelsForUser, getApprovedModelForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser: vi.fn(),
}));
const { retrieveAuthorizedContext } = vi.hoisted(() => ({ retrieveAuthorizedContext: vi.fn() }));
const { gatewayStream } = vi.hoisted(() => ({ gatewayStream: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'user@example.test',
    displayName: 'User',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['chat:create', 'conversation:read', 'conversation:update'],
  },
}));

const { resolveCapabilityModel } = vi.hoisted(() => ({ resolveCapabilityModel: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({ resolveCapabilityModel }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser, getApprovedModelForUser }));
vi.mock('../src/rag/retrieval.js', () => ({ retrieveAuthorizedContext }));
vi.mock('../src/ai/gateway/gateway.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ai/gateway/gateway.js')>();
  return { ...mod, gatewayStream };
});
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { chatRoutes } from '../src/chat/routes.js';

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

const assistantInserts: unknown[][] = [];

function mockDb() {
  assistantInserts.length = 0;
  tenantQuery.mockImplementation(async (_tenantId: string, sql: string, params?: unknown[]) => {
    if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1' }] };
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('INSERT INTO messages')) {
      if (sql.includes("'assistant'")) assistantInserts.push(params ?? []);
      return { rows: [] };
    }
    if (sql.includes('UPDATE conversations')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
}

async function waitFor(condition: () => boolean, timeoutMs: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (condition()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('chat SSE disconnect handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDb();
    listApprovedModelsForUser.mockResolvedValue([testModel]);
    getApprovedModelForUser.mockResolvedValue(testModel);
  resolveCapabilityModel.mockResolvedValue({
    requested: 'chat',
    resolved: 'chat',
    model: testModel,
    fallbackUsed: false,
    strategy: 'quality',
  });
    retrieveAuthorizedContext.mockResolvedValue({ context: '', citations: [], results: [] });
    recordAudit.mockResolvedValue(undefined);
  });

  it('aborts the provider request and persists the partial turn as interrupted', async () => {
    let providerSignal: AbortSignal | undefined;
    gatewayStream.mockImplementation(async (input: any) => {
      providerSignal = input.signal as AbortSignal;
      return {
        events: (async function* () {
          yield { type: 'text', content: 'partial answer' };
          // Simulate a long provider tail that only ends on cancellation.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, 30_000);
            input.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                resolve();
              },
              { once: true }
            );
          });
          if (input.signal?.aborted) return;
          yield { type: 'text', content: 'never arrives' };
        })(),
        model: testModel,
        telemetry: {},
      };
    });

    const app = Fastify();
    app.addHook('onRequest', (req: any, _reply, done) => {
      req.requestId = 'req-1';
      done();
    });
    await app.register(chatRoutes, { prefix: '/api/v1' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    try {
      // Raw fetch client: read until the first delta frame, then abort the
      // request mid-stream (client disconnect). Uses the global fetch rather
      // than node:http so the test stays clear of a pre-existing type
      // pollution in this repo: importing @fastify/multipart (via
      // src/server.ts) makes tsc resolve node stream `.on('data', …)` calls
      // against a bogus `"limit"` overload. See the final report.
      const clientController = new AbortController();
      const response = await fetch(`http://127.0.0.1:${port}/api/v1/chat`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({ content: 'tell me something' }),
        signal: clientController.signal,
      });
      if (!response.ok || !response.body) throw new Error(`unexpected response: ${response.status}`);
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let sawDelta = false;
      for (let i = 0; i < 1000; i += 1) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('event: delta')) {
          sawDelta = true;
          break;
        }
      }
      expect(sawDelta).toBe(true);
      // Client disconnects mid-stream.
      clientController.abort();
      await reader.cancel().catch(() => undefined);

      // The provider request must have been aborted…
      await waitFor(() => providerSignal?.aborted === true, 10_000, 'provider AbortSignal to abort');
      expect(providerSignal!.aborted).toBe(true);

      // …and the partial turn must persist as interrupted metadata — never
      // as a clean completion, and never with the legacy in-content marker.
      await waitFor(() => assistantInserts.length > 0, 10_000, 'assistant message insert');
      const params = assistantInserts[0]!;
      const content = params[2] as string;
      const metadata = JSON.parse(params[6] as string) as Record<string, unknown>;
      expect(content).toContain('partial answer');
      expect(content).not.toContain('never arrives');
      expect(content).not.toContain('[incomplete:');
      expect(metadata).toEqual({ stream_status: 'interrupted', stream_interrupted: true });
    } finally {
      await app.close();
    }
  });
});
