import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, tenantOpMock, withTxMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTxMock = vi.fn(async (cb: (session: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (session: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTxMock, withTenantTxMock };
});
const { recordAudit, recordAuditInTx } = vi.hoisted(() => ({ recordAudit: vi.fn(), recordAuditInTx: vi.fn() }));
const { getPromotionGate } = vi.hoisted(() => ({ getPromotionGate: vi.fn() }));
// Mutable so each test can act as an AI Admin or an unprivileged user.
const authState = { permissions: ['model:manage', 'model:use'] as string[] };

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock, withTx: withTxMock, withTenantTx: withTenantTxMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit, recordAuditInTx }));
vi.mock('../src/eval/compare.js', () => ({ getPromotionGate }));
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

import { modelAdminRoutes, modelArtifactRoutes } from '../src/ai/gateway/routes.js';
import { AppError } from '../src/errors.js';
import { config } from '../src/config.js';

const MODEL_ID = '55555555-5555-4555-8555-555555555555';
const TENANT = '22222222-2222-4222-8222-222222222222';

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: 'new-id' }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset();
    coll.findOne.mockResolvedValue(null);
    coll.findOneAndUpdate.mockReset();
    coll.findOneAndUpdate.mockResolvedValue(null);
    coll.updateOne.mockReset();
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset();
    coll.insertOne.mockReset();
    coll.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'new-id' });
    coll.deleteMany.mockReset();
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  tenantOpMock.mockReset();
  tenantOpMock.mockImplementation(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  withTxMock.mockReset();
  withTxMock.mockImplementation(async (cb: (session: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  withTenantTxMock.mockReset();
  withTenantTxMock.mockImplementation(async (_tenantId: string, cb: (session: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
}

function modelDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: MODEL_ID,
    name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    version: '1.0',
    provider: 'vllm',
    endpoint: 'http://vllm:8000/v1',
    modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    status: 'ACTIVE',
    license: 'llama3.1',
    source: 'meta',
    sha256: null,
    contextWindow: 131072,
    capabilities: { chat: true },
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    enabled: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
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
  await fastify.register(modelArtifactRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  authState.permissions = ['model:manage', 'model:use'];
  recordAudit.mockResolvedValue(undefined);
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('GET /admin/models', () => {
  it('returns full registry detail to a model:manage holder', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([modelDoc()]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
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
      status: 'ACTIVE',
      contextWindow: 131072,
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      enabled: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    // Models are platform-level: no tenant scoping in the query.
    expect(modelsColl.find).toHaveBeenCalledWith({});
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
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue({ _id: MODEL_ID, enabled: true });
    modelsColl.findOneAndUpdate.mockResolvedValue(modelDoc({ enabled: false }));

    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().model.enabled).toBe(false);
    expect(modelsColl.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: MODEL_ID },
      { $set: { enabled: false } },
      expect.objectContaining({ returnDocument: 'after' })
    );
    // The update and its audit event commit in ONE transaction: withTx wraps
    // both, and the audit goes through the transactional insert.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
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
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue({ _id: MODEL_ID, enabled: true });
    modelsColl.findOneAndUpdate.mockResolvedValue(modelDoc({ enabled: false }));
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
    expect(withTxMock).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('returns 404 for an unknown model', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/models/${MODEL_ID}`,
      payload: { enabled: false },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MODEL_NOT_FOUND');
    // No mutation attempted after the miss.
    expect(modelsColl.findOne).toHaveBeenCalledTimes(1);
    expect(withTxMock).not.toHaveBeenCalled();
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
    expect(getMockCollection('models').findOne).not.toHaveBeenCalled();
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
    expect(getMockCollection('models').findOne).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe('POST /admin/models (registration)', () => {
  function registrationBody(overrides: Record<string, unknown> = {}) {
    return {
      name: 'test/new-model',
      version: '1.0',
      provider: 'vllm',
      endpoint: 'http://vllm:8000/v1',
      modelIdentifier: 'test/new-model',
      license: 'apache-2.0',
      source: 'https://huggingface.co/test/new-model',
      sha256: 'a'.repeat(64),
      contextWindow: 8192,
      capabilities: { chat: true },
      allowedClassifications: ['PUBLIC', 'INTERNAL'],
      deployment: {},
      ...overrides,
    };
  }

  it('registers a model at REGISTERED: it serves no traffic until promoted', async () => {
    const modelsColl = getMockCollection('models');
    const createdDoc = modelDoc({ status: 'REGISTERED', name: 'test/new-model' });
    // withTx callback does insertOne; we capture the doc via the mock
    modelsColl.insertOne.mockImplementation(async (doc: any) => {
      // Simulate the doc being created
      return { acknowledged: true, insertedId: doc._id };
    });
    // The route returns the created doc; we need withTx to return it
    withTxMock.mockImplementation(async (cb: (session: any, db: any) => Promise<any>) => {
      const db = await getDbMock();
      const session = {};
      // Run the callback but intercept the return - the callback returns the doc
      const result = await cb(session, db);
      return result;
    });

    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/admin/models', payload: registrationBody() });
    expect(res.statusCode).toBe(201);
    expect(res.json().model).toMatchObject({ name: 'test/new-model', status: 'REGISTERED' });
    expect(modelsColl.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'test/new-model', status: 'REGISTERED' }),
      expect.objectContaining({ session: expect.anything() })
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_REGISTERED', resource: 'model' })
    );
    await fastify.close();
  });

  it('rejects duplicate model names with 409', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.insertOne.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/admin/models', payload: registrationBody() });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MODEL_NAME_EXISTS');
    await fastify.close();
  });

  it('rejects unknown providers', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models', payload: registrationBody({ provider: 'mystery' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MODEL_PROVIDER_UNSUPPORTED');
    expect(getMockCollection('models').insertOne).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('accepts arbitrary model endpoints — no egress allowlist gate', async () => {
    // The AI_PROVIDER_ALLOWED_ORIGINS gate was removed (Jake, 2026-10-02):
    // model endpoints come from the operator-controlled registry.
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models', payload: registrationBody({ endpoint: 'http://proxy.internal.example/v1' }),
    });
    expect(res.statusCode).toBe(201);
    expect(getMockCollection('models').insertOne).toHaveBeenCalled();
    await fastify.close();
  });

  it('rejects model sources outside the source allowlist', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models', payload: registrationBody({ source: 'https://evil.example/x' }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODEL_SOURCE_DENIED');
    expect(getMockCollection('models').insertOne).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('rejects UNKNOWN as an allowed classification', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models',
      payload: registrationBody({ allowedClassifications: ['UNKNOWN'] }),
    });
    expect(res.statusCode).toBe(400);
    expect(getMockCollection('models').insertOne).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('rejects callers without model:manage', async () => {
    authState.permissions = ['model:use'];
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/admin/models', payload: registrationBody() });
    expect(res.statusCode).toBe(403);
    expect(getMockCollection('models').insertOne).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe('POST /admin/models/:id/transition', () => {
  it('walks a legal transition and returns from/to status', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'REGISTERED' }));
    modelsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });

    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'DOWNLOADING' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transition).toMatchObject({ fromStatus: 'REGISTERED', toStatus: 'DOWNLOADING' });
    await fastify.close();
  });

  it('rejects an illegal jump without touching the model row again', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'REGISTERED' }));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'ACTIVE' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MODEL_TRANSITION_INVALID');
    expect(modelsColl.findOne).toHaveBeenCalledTimes(1);
    expect(modelsColl.updateOne).not.toHaveBeenCalled();
    await fastify.close();
  });

  it('approves only when the eval promotion gate passes', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: true, latestRunId: 'run-1' });
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'PENDING_APPROVAL' }));
    modelsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });

    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'APPROVED' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().transition.toStatus).toBe('APPROVED');
    await fastify.close();
  });

  it('blocks approval when required evals fail — there is no override', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: false, reason: 'P0 failures: 1', latestRunId: null });
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'PENDING_APPROVAL' }));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'APPROVED' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MODEL_PROMOTION_GATE_FAILED');
    await fastify.close();
  });

  it('returns 404 for an unknown model', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'DOWNLOADING' },
    });
    expect(res.statusCode).toBe(404);
    await fastify.close();
  });

  it('rejects malformed ids and unknown statuses', async () => {
    const fastify = await app();
    const badId = await fastify.inject({
      method: 'POST', url: '/admin/models/not-a-uuid/transition', payload: { status: 'DOWNLOADING' },
    });
    expect(badId.statusCode).toBe(400);
    const badStatus = await fastify.inject({
      method: 'POST', url: `/admin/models/${MODEL_ID}/transition`, payload: { status: 'BOGUS' },
    });
    expect(badStatus.statusCode).toBe(400);
    expect(getMockCollection('models').findOne).not.toHaveBeenCalled();
    await fastify.close();
  });
});

describe('/admin/serving-defaults', () => {
  it('lists the tenant serving defaults', async () => {
    const defaultsColl = getMockCollection('model_serving_defaults');
    const doc = {
      _id: `${TENANT}:chat`,
      tenantId: TENANT,
      capability: 'chat',
      modelId: MODEL_ID,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    };
    defaultsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([doc]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/serving-defaults' });
    expect(res.statusCode).toBe(200);
    expect(res.json().defaults).toHaveLength(1);
    await fastify.close();
  });

  it('sets a default for a servable model and audits it', async () => {
    const modelsColl = getMockCollection('models');
    const defaultsColl = getMockCollection('model_serving_defaults');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'ACTIVE' }));
    const upsertedDoc = {
      _id: `${TENANT}:chat`,
      tenantId: TENANT,
      capability: 'chat',
      modelId: MODEL_ID,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    };
    defaultsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    defaultsColl.findOne.mockResolvedValue(upsertedDoc);

    const fastify = await app();
    const res = await fastify.inject({
      method: 'PUT', url: '/admin/serving-defaults/chat', payload: { modelId: MODEL_ID },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().default).toMatchObject({ capability: 'chat', modelId: MODEL_ID });
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_SERVING_DEFAULT_SET' })
    );
    await fastify.close();
  });

  it('refuses defaults pointing at non-servable models', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc({ status: 'APPROVED' }));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PUT', url: '/admin/serving-defaults/chat', payload: { modelId: MODEL_ID },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('MODEL_NOT_SERVABLE');
    await fastify.close();
  });
});

describe('/admin/routing-policies', () => {
  const tenantId = TENANT;
  const policyDoc = {
    _id: `${tenantId}:syteline`,
    tenantId,
    capability: 'syteline',
    strategy: 'latency',
    fallbackToChat: true,
    updatedBy: 'admin-1',
    updatedAt: new Date('2026-09-01T00:00:00Z'),
  };

  it('lists the tenant routing policies', async () => {
    const policiesColl = getMockCollection('model_routing_policies');
    policiesColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([policyDoc]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/routing-policies' });
    expect(res.statusCode).toBe(200);
    expect(res.json().policies).toHaveLength(1);
    expect(res.json().policies[0]).toMatchObject({ capability: 'syteline', strategy: 'latency' });
    await fastify.close();
  });

  it('returns the platform default for an unconfigured capability', async () => {
    const policiesColl = getMockCollection('model_routing_policies');
    policiesColl.findOne.mockResolvedValue(null);
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/routing-policies/coding' });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy).toMatchObject({
      tenantId, capability: 'coding', strategy: 'quality', fallbackToChat: true, updatedBy: null,
    });
    await fastify.close();
  });

  it('rejects unknown capabilities with INVALID_CAPABILITY', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/routing-policies/image-gen' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_CAPABILITY');
    await fastify.close();
  });

  it('sets a policy and audits it', async () => {
    const policiesColl = getMockCollection('model_routing_policies');
    const updatedDoc = { ...policyDoc, strategy: 'cost', fallbackToChat: false };
    policiesColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    policiesColl.findOne.mockResolvedValue(updatedDoc);

    const fastify = await app();
    const res = await fastify.inject({
      method: 'PUT', url: '/admin/routing-policies/syteline',
      payload: { strategy: 'cost', fallbackToChat: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().policy).toMatchObject({ capability: 'syteline', strategy: 'cost', fallbackToChat: false });
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_ROUTING_POLICY_SET', resourceId: `${tenantId}:syteline` })
    );
    await fastify.close();
  });

  it('rejects invalid strategies and requires model:manage', async () => {
    const fastify = await app();
    const bad = await fastify.inject({
      method: 'PUT', url: '/admin/routing-policies/syteline',
      payload: { strategy: 'rocket', fallbackToChat: true },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_REQUEST');
    authState.permissions = ['model:use'];
    const denied = await fastify.inject({ method: 'GET', url: '/admin/routing-policies' });
    expect(denied.statusCode).toBe(403);
    await fastify.close();
  });
});

describe('/admin/models/artifacts (local dev only)', () => {
  const originalFetch = globalThis.fetch;
  const originalAllowDev = config.ALLOW_DEV_PROVIDERS;
  const originalNames = config.OLLAMA_ALLOWED_MODELS;
  const originalOllamaEnabled = config.OLLAMA_ENABLED;

  beforeEach(() => {
    config.ALLOW_DEV_PROVIDERS = true;
    config.OLLAMA_ALLOWED_MODELS = 'llama3.1:8b,nomic-embed-text';
    // These tests exercise the local-stack artifact paths; the
    // OLLAMA_ENABLED=false behavior is covered in ollamaFlag.test.ts.
    config.OLLAMA_ENABLED = true;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    config.ALLOW_DEV_PROVIDERS = originalAllowDev;
    config.OLLAMA_ALLOWED_MODELS = originalNames;
    config.OLLAMA_ENABLED = originalOllamaEnabled;
  });

  it('refuses artifact access when dev providers are disabled', async () => {
    config.ALLOW_DEV_PROVIDERS = false;
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/models/artifacts/local' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODEL_ARTIFACT_DEV_ONLY');
    await fastify.close();
  });

  it('lists local Ollama models', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b' }] }), { status: 200 })
    ) as never;
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/admin/models/artifacts/local' });
    expect(res.statusCode).toBe(200);
    expect(res.json().models).toEqual([
      { name: 'llama3.1:8b', present: true, sizeBytes: null, details: null },
    ]);
    await fastify.close();
  });

  it('streams pull progress as SSE and audits the request', async () => {
    const ndjson = [JSON.stringify({ status: 'pulling' }), JSON.stringify({ status: 'success' })].join('\n');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 })) as never;
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models/artifacts/pull', payload: { name: 'llama3.1:8b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain('data: {"status":"pulling"}');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'MODEL_PULL_REQUESTED' }));
    await fastify.close();
  });

  it('refuses to pull a model outside the allowlist', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST', url: '/admin/models/artifacts/pull', payload: { name: 'evil:1b' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('MODEL_SOURCE_DENIED');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'MODEL_PULL_REQUESTED' }));
    await fastify.close();
  });
});
