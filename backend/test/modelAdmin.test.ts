import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { query, withTx } = vi.hoisted(() => {
  const query = vi.fn();
  // Emulate withTx: the callback runs against a client whose query delegates
  // to the shared query mock, so per-call mockResolvedValue sequencing keeps
  // working and the single-transaction structure stays observable.
  const withTx = vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) =>
    callback({ query }));
  return { query, withTx };
});
const { recordAudit, recordAuditInTx } = vi.hoisted(() => ({ recordAudit: vi.fn(), recordAuditInTx: vi.fn() }));
// Mutable so each test can act as an AI Admin or an unprivileged user.
const authState = { permissions: ['model:manage', 'model:use'] as string[] };

vi.mock('../src/db/pool.js', () => ({ query, withTx }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit, recordAuditInTx }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: 'admin-1',
      tenantId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'ai-admin@example.test',
      displayName: 'AI Admin',
      roleName: 'AI Admin',
      clearance: 'INTERNAL',
      permissions: authState.permissions,
    };
    done();
  },
}));
// The REAL requirePermission middleware is used so the model:manage gate is
// genuinely exercised (on denial it audits AUTHORIZATION_FAILURE itself).

import { modelAdminRoutes } from '../src/ai/gateway/routes.js';
import { AppError } from '../src/errors.js';

const MODEL_ID = '55555555-5555-4555-8555-555555555555';

function modelRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MODEL_ID,
    name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    version: '1.0',
    provider: 'vllm',
    endpoint: 'http://vllm:8000/v1',
    model_identifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    status: 'APPROVED',
    license: 'llama3.1',
    source: 'meta',
    sha256: null,
    context_window: 131072,
    capabilities: { chat: true },
    allowed_classifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    request_timeout_ms: null,
    max_tokens: null,
    temperature: null,
    fallback_model_id: null,
    enabled: true,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function app() {
  const fastify = Fastify();
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(modelAdminRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.permissions = ['model:manage', 'model:use'];
  recordAudit.mockResolvedValue(undefined);
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('GET /admin/models', () => {
  it('returns full registry detail to a model:manage holder', async () => {
    query.mockResolvedValue({ rows: [modelRow()], rowCount: 1 });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/models' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.models).toHaveLength(1);
    expect(body.models[0]).toMatchObject({
      id: MODEL_ID,
      name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      provider: 'vllm',
      endpoint: 'http://vllm:8000/v1',
      modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
      status: 'APPROVED',
      contextWindow: 131072,
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Models are platform-level: no tenant scoping in the query.
    expect(String(query.mock.calls[0]![0])).toContain('FROM models');
    expect(String(query.mock.calls[0]![0])).not.toContain('tenant_id');
    await fastify.close();
  });

  it('rejects callers without model:manage', async () => {
    authState.permissions = ['model:use'];
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/models' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'AUTHORIZATION_FAILURE', success: false })
    );
    await fastify.close();
  });
});

describe('PATCH /admin/models/:id', () => {
  it('toggles enabled and audits MODEL_ENABLED_CHANGED with previous/new values', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: MODEL_ID, enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow({ enabled: false })], rowCount: 1 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model.enabled).toBe(false);
    expect(query.mock.calls[1]![0]).toMatch(/UPDATE models SET enabled/);
    expect(query.mock.calls[1]![1]).toEqual([MODEL_ID, false]);
    // The update and its audit event commit in ONE transaction: withTx wraps
    // both, and the audit goes through the transactional insert.
    expect(withTx).toHaveBeenCalledTimes(1);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.objectContaining({ query: expect.any(Function) }),
      expect.objectContaining({
        action: 'MODEL_ENABLED_CHANGED',
        resource: 'model',
        resourceId: MODEL_ID,
        metadata: { previousEnabled: true, newEnabled: false },
      })
    );
    // The non-transactional audit path is never used for the toggle.
    expect(recordAudit).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('fails the toggle when the audit insert fails (fail-closed, atomic)', async () => {
    query
      .mockResolvedValueOnce({ rows: [{ id: MODEL_ID, enabled: true }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow({ enabled: false })], rowCount: 1 });
    // A fail-closed audit failure inside the transaction must surface as 503
    // instead of a 200 with a silently unaudited model change; the withTx
    // wrapper rolls the UPDATE back in production.
    recordAuditInTx.mockRejectedValueOnce(new AppError(503, 'AUDIT_PERSISTENCE_FAILED', 'Audit event could not be persisted'));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AUDIT_PERSISTENCE_FAILED');
    expect(withTx).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('returns 404 for an unknown model', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MODEL_NOT_FOUND');
    // No mutation attempted after the miss.
    expect(query).toHaveBeenCalledTimes(1);
    expect(withTx).not.toHaveBeenCalled();
    expect(recordAuditInTx).not.toHaveBeenCalled();
    expect(recordAudit).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('rejects invalid ids and unknown body fields (strict enabled-only schema)', async () => {
    const fastify = await app();
    const badId = await fastify.inject({
      method: 'PATCH',
      url: '/admin/models/not-a-uuid',
      payload: { enabled: false },
    });
    expect(badId.statusCode).toBe(400);
    const badBody = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false, endpoint: 'http://evil.example/v1' },
    });
    expect(badBody.statusCode).toBe(400);
    expect(query).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('rejects callers without model:manage', async () => {
    authState.permissions = ['model:use'];
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(403);
    expect(query).not.toHaveBeenCalled();
    await fastify.close();
  });
});
