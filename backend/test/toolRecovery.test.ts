import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isTransientToolError,
  runToolCallWithRecovery,
  ToolCallRunner,
  ToolCallRunnerOptions,
} from '../src/chat/toolRecovery.js';
import type { ToolCallResult } from '../src/tools/gateway.js';

const okResult: ToolCallResult = { ok: true, output: '{"price":42}' };
const transientFailure: ToolCallResult = { ok: false, errorCode: 'TOOL_TIMEOUT', message: 'Tool execution failed' };
const permanentFailure: ToolCallResult = { ok: false, errorCode: 'INVALID_TOOL_PARAMETERS', message: 'Tool parameters are invalid' };

function baseOptions(overrides: Partial<ToolCallRunnerOptions> = {}): ToolCallRunnerOptions {
  return {
    auth: {} as ToolCallRunnerOptions['auth'],
    name: 'syteline.getItem',
    rawArguments: '{}',
    classification: 'INTERNAL' as ToolCallRunnerOptions['classification'],
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('isTransientToolError', () => {
  it.each(['TOOL_TIMEOUT', 'SYTELINE_UPSTREAM_ERROR', 'TOOL_EXECUTION_FAILED'])(
    'treats %s as transient',
    (code) => expect(isTransientToolError(code)).toBe(true)
  );

  it.each([
    'INVALID_TOOL_ARGUMENTS',
    'INVALID_TOOL_PARAMETERS',
    'TOOL_NOT_FOUND',
    'TOOL_FORBIDDEN',
    'TOOL_CLASSIFICATION_DENIED',
    'CONFIRMATION_REQUIRED',
    'SYTELINE_NOT_CONFIGURED',
    'SOME_UNKNOWN_CODE',
  ])('treats %s as deterministic (no blind retry)', (code) => expect(isTransientToolError(code)).toBe(false));

  it('treats undefined as non-transient', () => {
    expect(isTransientToolError(undefined)).toBe(false);
  });
});

describe('runToolCallWithRecovery', () => {
  it('does not retry a success', async () => {
    let calls = 0;
    const runner = (async (_o: ToolCallRunnerOptions): Promise<ToolCallResult> => {
      calls += 1;
      return okResult;
    }) as ToolCallRunner;
    const outcome = await runToolCallWithRecovery(runner, baseOptions());
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: okResult, retried: false });
  });

  it('retries once on a transient failure and returns the retry result', async () => {
    let calls = 0;
    const runner = (async (_o: ToolCallRunnerOptions): Promise<ToolCallResult> => {
      calls += 1;
      return calls === 1 ? transientFailure : okResult;
    }) as ToolCallRunner;
    const outcome = await runToolCallWithRecovery(runner, baseOptions());
    expect(calls).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.result).toEqual(okResult);
  });

  it('stops after one retry even when the retry also fails transiently', async () => {
    let calls = 0;
    const runner = (async (_o: ToolCallRunnerOptions): Promise<ToolCallResult> => {
      calls += 1;
      return transientFailure;
    }) as ToolCallRunner;
    const outcome = await runToolCallWithRecovery(runner, baseOptions());
    expect(calls).toBe(2);
    expect(outcome.retried).toBe(true);
    expect(outcome.result).toEqual(transientFailure);
  });

  it('does not retry a deterministic failure', async () => {
    let calls = 0;
    const runner = (async (_o: ToolCallRunnerOptions): Promise<ToolCallResult> => {
      calls += 1;
      return permanentFailure;
    }) as ToolCallRunner;
    const outcome = await runToolCallWithRecovery(runner, baseOptions());
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: permanentFailure, retried: false });
  });

  it('does not retry when the caller already went away', async () => {
    let calls = 0;
    const runner = (async (_o: ToolCallRunnerOptions): Promise<ToolCallResult> => {
      calls += 1;
      return transientFailure;
    }) as ToolCallRunner;
    const controller = new AbortController();
    controller.abort();
    const outcome = await runToolCallWithRecovery(runner, baseOptions({ signal: controller.signal }));
    expect(calls).toBe(1);
    expect(outcome).toEqual({ result: transientFailure, retried: false });
  });
});

// --- Route level: a transient tool failure is retried once, then the ---
// --- sanitized error is fed back so the model can explain gracefully. ---

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { listApprovedModelsForUser, getApprovedModelForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser: vi.fn(),
}));
const { retrieveAuthorizedContext } = vi.hoisted(() => ({ retrieveAuthorizedContext: vi.fn() }));
const { gatewayStream } = vi.hoisted(() => ({ gatewayStream: vi.fn() }));
const { recordAudit, sanitizeReason } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  // runToolCall sanitizes failure diagnostics through this before auditing;
  // the real one must exist or the failure path throws.
  sanitizeReason: vi.fn((reason?: string) => reason ?? null),
}));
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
    permissions: ['chat:create', 'conversation:read', 'conversation:update', 'tool:use'],
  },
}));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser, getApprovedModelForUser }));
vi.mock('../src/rag/retrieval.js', () => ({ retrieveAuthorizedContext }));
vi.mock('../src/ai/gateway/gateway.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ai/gateway/gateway.js')>();
  return { ...mod, gatewayStream };
});
vi.mock('../src/audit/audit.js', () => ({ recordAudit, sanitizeReason }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import Fastify from 'fastify';
import { chatRoutes } from '../src/chat/routes.js';
import { toolRegistry } from '../src/tools/gateway.js';
import { Errors } from '../src/errors.js';

const sytelineTool = toolRegistry.find((tool) => tool.name === 'syteline.getItem')!;

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

async function* textOnly(text: string) {
  yield { type: 'text', content: text };
}

describe('chat route tool recovery', () => {
  beforeEach(() => {
    // resetAllMocks (not clearAllMocks): a test whose flow diverges could
    // otherwise leave unconsumed mockImplementationOnce queues behind for
    // the next test. Implementations are re-applied below.
    vi.resetAllMocks();
    tenantQuery.mockImplementation(async (_tenantId: string, sql: string) => {
      if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1' }] };
      if (sql.includes('FROM messages')) return { rows: [] };
      if (sql.includes('INSERT INTO tool_executions')) return { rows: [{ id: 'exec-1' }] };
      if (sql.includes('UPDATE tool_executions')) return { rows: [] };
      if (sql.includes('INSERT INTO messages')) return { rows: [] };
      if (sql.includes('UPDATE conversations')) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });
    listApprovedModelsForUser.mockResolvedValue([testModel]);
    getApprovedModelForUser.mockResolvedValue(testModel);
    retrieveAuthorizedContext.mockResolvedValue({ context: '', citations: [], results: [] });
    recordAudit.mockResolvedValue(undefined);
  });

  async function postChat(body: Record<string, unknown>) {
    const app = Fastify();
    app.addHook('onRequest', (req: any, _reply, done) => {
      req.requestId = 'req-1';
      done();
    });
    await app.register(chatRoutes, { prefix: '/api/v1' });
    return app.inject({ method: 'POST', url: '/api/v1/chat', payload: body });
  }

  function ssePayload(res: { rawPayload: Buffer }): string[] {
    return res.rawPayload.toString('utf8').split('\n\n').filter(Boolean);
  }

  it('retries a transient tool failure once, then feeds the sanitized error back for a graceful explanation', async () => {
    // First attempt times out (transient); the retry succeeds.
    sytelineTool.execute = vi.fn()
      .mockRejectedValueOnce(Errors.internal('upstream exploded: host db-1.internal', undefined, 'TOOL_TIMEOUT'))
      .mockResolvedValueOnce({ item: 'ABC', price: 42 }) as never;

    gatewayStream
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          yield { type: 'tool_call', id: 'call_1', name: 'syteline.getItem', arguments: '{"item":"ABC","site":"MAIN"}' };
        })(),
        model: testModel,
        telemetry: {},
      }))
      .mockImplementationOnce(async () => ({ events: textOnly('The price is 42.'), model: testModel, telemetry: {} }));

    const res = await postChat({ content: 'price of ABC?' });
    expect(res.statusCode).toBe(200);
    // Exactly one retry: two attempts total.
    expect(sytelineTool.execute).toHaveBeenCalledTimes(2);
    const payload = ssePayload(res as never);
    expect(payload.some((f) => f.includes('The price is 42.'))).toBe(true);
  });

  it('feeds the sanitized error back when the retry also fails — never a dead end', async () => {
    // Both attempts time out. The adapter's raw message must never reach
    // the model or client; the model gets the sanitized error and explains.
    sytelineTool.execute = vi.fn()
      .mockRejectedValue(Errors.internal('upstream exploded: host db-1.internal', undefined, 'TOOL_TIMEOUT')) as never;

    let seenToolResult = '';
    gatewayStream
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          yield { type: 'tool_call', id: 'call_1', name: 'syteline.getItem', arguments: '{"item":"ABC","site":"MAIN"}' };
        })(),
        model: testModel,
        telemetry: {},
      }))
      .mockImplementationOnce(async ({ messages }: any) => {
        const toolResult = (messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
        seenToolResult = String(toolResult?.content ?? '');
        return { events: textOnly("The lookup timed out; here's what to try next."), model: testModel, telemetry: {} };
      });

    const res = await postChat({ content: 'price of ABC?' });
    expect(res.statusCode).toBe(200);
    expect(sytelineTool.execute).toHaveBeenCalledTimes(2);
    // The model saw a sanitized error result (not the raw adapter message).
    expect(seenToolResult).toContain('error (TOOL_TIMEOUT)');
    expect(seenToolResult).not.toContain('upstream exploded');
    expect(seenToolResult).not.toContain('db-1.internal');
    // …and produced a graceful explanation instead of a dead end.
    const payload = ssePayload(res as never);
    expect(payload.some((f) => f.includes("here's what to try next"))).toBe(true);
    expect(payload.some((f) => f.includes('event: done'))).toBe(true);
  });

  it('does not retry a deterministic tool failure', async () => {
    sytelineTool.execute = vi.fn(async () => ({ item: 'ABC' })) as never;
    gatewayStream
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          // Unknown tool: TOOL_NOT_FOUND is deterministic — no retry.
          yield { type: 'tool_call', id: 'call_9', name: 'nope.notreal', arguments: '{}' };
        })(),
        model: testModel,
        telemetry: {},
      }))
      .mockImplementationOnce(async () => ({ events: textOnly('that tool does not exist'), model: testModel, telemetry: {} }));

    const res = await postChat({ content: 'use the nope tool' });
    expect(res.statusCode).toBe(200);
    expect(sytelineTool.execute).not.toHaveBeenCalled();
    const payload = ssePayload(res as never);
    expect(payload.some((f) => f.includes('that tool does not exist'))).toBe(true);
  });
});
