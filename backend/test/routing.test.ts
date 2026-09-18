/**
 * routing.test.ts — Phase 6 capability routing.
 *
 * 1. Classifier unit tests: the deterministic task → capability mapping,
 *    including precedence (documents > code > syteline > chat), the
 *    syteline permission gate, and near-miss negatives.
 * 2. Router unit tests: explicit/pinned model passthrough, capability
 *    default resolution, and the deterministic fallback chain.
 * 3. Chat-route integration: POST /chat without a modelId classifies the
 *    turn, audits MODEL_ROUTED, and reports the decision in the SSE meta
 *    event; an explicit modelId skips routing entirely.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

import { classifyTask } from '../src/ai/routing/classifier.js';

// ---------------------------------------------------------------------------
// 1. Classifier
// ---------------------------------------------------------------------------

describe('classifyTask', () => {
  const tools = { sytelineToolsOffered: true };
  const noTools = { sytelineToolsOffered: false };

  it('defaults to chat for plain messages', () => {
    expect(classifyTask({ content: 'Hello!', ...tools })).toEqual({
      capability: 'chat',
      reasons: ['default-capability'],
    });
    expect(classifyTask({ content: '', ...tools }).capability).toBe('chat');
    expect(classifyTask({ content: '   ', ...tools }).capability).toBe('chat');
    expect(classifyTask({ content: 'What about the second one?', ...tools }).capability).toBe('chat');
  });

  it('does not steal everyday "order" language', () => {
    // No ERP entity ("ordered" ≠ "sales order") and no investigation verb.
    expect(
      classifyTask({ content: 'I ordered pizza for the team lunch', ...tools }).capability
    ).toBe('chat');
  });

  it('routes ERP investigations to syteline', () => {
    const cases: Array<[string, string[]]> = [
      ['Why is sales order 45213 late?', ['syteline-entities-detected']],
      ['Check inventory for item WIDGET-100 in Memphis', ['syteline-entities-detected']],
      ['Show me open purchase orders for vendor Acme', ['syteline-entities-detected']],
      ['What is our lead time for item X?', ['syteline-entities-detected']],
      ['order 45213', ['syteline-entities-detected']],
      ['List work orders behind schedule', ['syteline-entities-detected']],
      ['In SyteLine, where do I see backorders?', ['explicit-syteline-mention']],
    ];
    for (const [content, reasons] of cases) {
      expect(classifyTask({ content, ...tools }), content).toEqual({ capability: 'syteline', reasons });
    }
  });

  it('gates syteline routing on the tool offer', () => {
    // Same ERP language, but the caller cannot use syteline tools: routing
    // them to the syteline capability would buy nothing.
    expect(
      classifyTask({ content: 'Why is sales order 45213 late?', ...noTools }).capability
    ).toBe('chat');
  });

  it('routes code content to coding', () => {
    const cases = [
      '```python\nprint("hi")\n```\nWhat does this do?',
      'Traceback (most recent call last):\n  File "sync.py", line 42\nValueError: bad',
      'How do I fix the bug in src/sync.py?',
      'How do I debug a null pointer in Java?',
      'Refactor this SQL query to use a CTE',
    ];
    for (const content of cases) {
      expect(classifyTask({ content, ...tools }), content).toEqual({
        capability: 'coding',
        reasons: ['code-content-detected'],
      });
    }
  });

  it('prefers explicit document context over every heuristic', () => {
    expect(
      classifyTask({
        content: 'Why is sales order 45213 late?',
        documentIds: ['doc-1'],
        ...tools,
      })
    ).toEqual({ capability: 'rag', reasons: ['explicit-document-context'] });
    expect(
      classifyTask({ content: '```python\nx = 1\n```', documentIds: ['doc-1'], ...tools }).capability
    ).toBe('rag');
  });

  it('prefers code signals over ERP vocabulary', () => {
    // The task is writing code, even though it mentions SyteLine entities.
    expect(
      classifyTask({ content: 'Write a python script that checks SyteLine inventory levels', ...tools })
        .capability
    ).toBe('coding');
  });

  it('is total: never throws, always returns a valid classification', () => {
    const inputs = ['', '   ', '!@#$%^&*()', 'a'.repeat(32000)];
    for (const content of inputs) {
      const result = classifyTask({ content, ...tools });
      expect(['chat', 'syteline', 'coding', 'rag']).toContain(result.capability);
      expect(result.reasons.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Router (mocked registry/lifecycle/config)
// ---------------------------------------------------------------------------

const { resolveServingModel } = vi.hoisted(() => ({ resolveServingModel: vi.fn() }));
const { listApprovedModelsForUser, getApprovedModelForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser: vi.fn(),
}));
const { routingEnabled } = vi.hoisted(() => ({ routingEnabled: { value: true } }));

vi.mock('../src/ai/gateway/modelLifecycle.js', () => ({ resolveServingModel }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser, getApprovedModelForUser }));
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  // Real config (the chat route needs its limiter/rate-limit values at
  // import time) with only the routing flag made test-controllable.
  return {
    ...mod,
    config: { ...mod.config, get ROUTING_ENABLED() { return routingEnabled.value; } },
  };
});

import { AppError } from '../src/errors.js';
import { resolveChatModel } from '../src/ai/routing/router.js';

const sytelineModel = { id: 'model-syteline' };
const chatModel = { id: 'model-chat' };
const firstApproved = { id: 'model-first' };

describe('resolveChatModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routingEnabled.value = true;
    resolveServingModel.mockReset();
    listApprovedModelsForUser.mockResolvedValue([firstApproved]);
  });

  const base = {
    tenantId: 't1',
    userId: 'u1',
    roleId: 'r1',
    content: 'Why is sales order 45213 late?',
    sytelineToolsOffered: true,
  };

  it('honors an explicit modelId without classifying', async () => {
    const route = await resolveChatModel({ ...base, explicitModelId: 'explicit-id' });
    expect(route).toEqual({ modelId: 'explicit-id' });
    expect(resolveServingModel).not.toHaveBeenCalled();
    expect(route.routing).toBeUndefined();
  });

  it('honors a pinned conversation model without classifying', async () => {
    const route = await resolveChatModel({ ...base, pinnedModelId: 'pinned-id' });
    expect(route).toEqual({ modelId: 'pinned-id' });
    expect(resolveServingModel).not.toHaveBeenCalled();
  });

  it('resolves the classified capability default first', async () => {
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) =>
      cap === 'syteline' ? sytelineModel : undefined
    );
    const route = await resolveChatModel(base);
    expect(resolveServingModel).toHaveBeenCalledWith('t1', 'u1', 'r1', 'syteline');
    expect(route.modelId).toBe('model-syteline');
    expect(route.routing).toEqual({
      capability: 'syteline',
      reasons: ['syteline-entities-detected'],
    });
  });

  it('falls back to the chat default when the capability has none', async () => {
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) =>
      cap === 'chat' ? chatModel : undefined
    );
    const route = await resolveChatModel(base);
    expect(route.modelId).toBe('model-chat');
    // The classification is still reported: the turn WAS a syteline turn.
    expect(route.routing?.capability).toBe('syteline');
  });

  it('falls back to the first approved model when no defaults exist', async () => {
    resolveServingModel.mockResolvedValue(undefined);
    const route = await resolveChatModel(base);
    expect(route.modelId).toBe('model-first');
    expect(listApprovedModelsForUser).toHaveBeenCalledWith('t1', 'u1', 'r1');
  });

  it('falls through a capability default the caller is not granted', async () => {
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) => {
      if (cap === 'syteline') throw new AppError(403, 'MODEL_NOT_APPROVED', 'denied');
      if (cap === 'chat') return chatModel;
      return undefined;
    });
    const route = await resolveChatModel(base);
    expect(route.modelId).toBe('model-chat');
  });

  it('throws NO_APPROVED_MODEL when nothing is servable', async () => {
    resolveServingModel.mockResolvedValue(undefined);
    listApprovedModelsForUser.mockResolvedValue([]);
    await expect(resolveChatModel(base)).rejects.toMatchObject({ code: 'NO_APPROVED_MODEL' });
  });

  it('propagates non-approval errors from serving-default resolution', async () => {
    resolveServingModel.mockRejectedValue(new Error('db down'));
    await expect(resolveChatModel(base)).rejects.toThrow('db down');
  });

  it('with routing disabled, always resolves the chat default', async () => {
    routingEnabled.value = false;
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) =>
      cap === 'chat' ? chatModel : undefined
    );
    const route = await resolveChatModel(base);
    expect(resolveServingModel).toHaveBeenCalledWith('t1', 'u1', 'r1', 'chat');
    expect(resolveServingModel).not.toHaveBeenCalledWith('t1', 'u1', 'r1', 'syteline');
    expect(route.routing).toEqual({ capability: 'chat', reasons: ['routing-disabled'] });
  });
});

// ---------------------------------------------------------------------------
// 3. Chat-route integration
// ---------------------------------------------------------------------------

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { gatewayStream } = vi.hoisted(() => ({ gatewayStream: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { retrieveAuthorizedContext } = vi.hoisted(() => ({ retrieveAuthorizedContext: vi.fn() }));
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
    // tool:use + syteline:read so syteline.* tools are offered this turn.
    permissions: ['chat:create', 'conversation:read', 'tool:use', 'syteline:read'],
  },
}));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/ai/gateway/gateway.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/ai/gateway/gateway.js')>();
  return { ...mod, gatewayStream };
});
vi.mock('../src/rag/retrieval.js', () => ({ retrieveAuthorizedContext }));
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

const routedModel = {
  id: 'model-syteline-1',
  name: 'SyteLine Specialist',
  version: '1',
  provider: 'vllm',
  endpoint: 'http://localhost:8000/v1',
  model_identifier: 'syteline-model',
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
  tenantQuery.mockImplementation(async (_tenantId: string, sql: string, _params?: unknown[]) => {
    if (sql.includes('FROM conversations WHERE id')) return { rows: [] }; // no pinned conversation
    if (sql.includes('INSERT INTO conversations')) return { rows: [{ id: 'conv-1' }] };
    if (sql.includes('FROM messages')) return { rows: [] };
    if (sql.includes('INSERT INTO messages')) return { rows: [] };
    if (sql.includes('UPDATE conversations')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
}

function metaFrame(res: { rawPayload: Buffer }): Record<string, unknown> | undefined {
  const frames = res.rawPayload.toString('utf8').split('\n\n').filter(Boolean);
  for (const frame of frames) {
    if (!frame.includes('event: meta')) continue;
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) return JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>;
  }
  return undefined;
}

async function postChat(body: Record<string, unknown>) {
  const app = Fastify();
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  return app.inject({ method: 'POST', url: '/api/v1/chat', payload: body });
}

describe('chat route capability routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    routingEnabled.value = true;
    mockChatDb();
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) =>
      cap === 'syteline' ? { id: routedModel.id } : undefined
    );
    listApprovedModelsForUser.mockResolvedValue([routedModel]);
    getApprovedModelForUser.mockResolvedValue(routedModel);
    retrieveAuthorizedContext.mockResolvedValue({ context: '', citations: [], results: [] });
    recordAudit.mockResolvedValue(undefined);
    gatewayStream.mockImplementation(async () => ({
      events: (async function* () {
        yield { type: 'text', content: 'ok' };
      })(),
      model: routedModel,
      telemetry: {},
    }));
  });

  it('routes an unpinned syteline turn: MODEL_ROUTED audit + meta.routing', async () => {
    const res = await postChat({ content: 'Why is sales order 45213 late?' });
    expect(res.statusCode).toBe(200);

    const auditCall = recordAudit.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'MODEL_ROUTED'
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as {
      resourceId: string;
      metadata: { capability: string; reasons: string[] };
    };
    expect(payload.resourceId).toBe(routedModel.id);
    expect(payload.metadata.capability).toBe('syteline');
    expect(payload.metadata.reasons).toEqual(['syteline-entities-detected']);

    const meta = metaFrame(res as never);
    expect(meta?.model).toEqual({ id: routedModel.id, name: routedModel.name });
    expect(meta?.routing).toEqual({
      capability: 'syteline',
      reasons: ['syteline-entities-detected'],
    });
  });

  it('skips routing (and its audit) when the client names a model', async () => {
    const res = await postChat({
      content: 'Why is sales order 45213 late?',
      modelId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(res.statusCode).toBe(200);
    expect(
      recordAudit.mock.calls.some((call) => (call[0] as { action: string }).action === 'MODEL_ROUTED')
    ).toBe(false);
    expect(metaFrame(res as never)?.routing).toBeUndefined();
    expect(resolveServingModel).not.toHaveBeenCalled();
  });

  it('keeps a pinned conversation model without re-routing', async () => {
    tenantQuery.mockImplementation(async (_tenantId: string, sql: string, _params?: unknown[]) => {
      if (sql.includes('FROM conversations WHERE id')) {
        return { rows: [{ modelId: 'pinned-model-id', classification: 'INTERNAL' }] };
      }
      if (sql.includes('INSERT INTO messages')) return { rows: [] };
      if (sql.includes('FROM messages')) return { rows: [] };
      if (sql.includes('UPDATE conversations')) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });
    const pinned = { ...routedModel, id: 'pinned-model-id', name: 'Pinned' };
    getApprovedModelForUser.mockResolvedValue(pinned);

    const res = await postChat({
      content: 'Why is sales order 45213 late?',
      conversationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    });
    expect(res.statusCode).toBe(200);
    expect(
      recordAudit.mock.calls.some((call) => (call[0] as { action: string }).action === 'MODEL_ROUTED')
    ).toBe(false);
    expect(resolveServingModel).not.toHaveBeenCalled();
    expect(metaFrame(res as never)?.model).toEqual({ id: 'pinned-model-id', name: 'Pinned' });
  });
});
