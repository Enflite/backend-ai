/**
 * defaultOpenRoutes.test.ts — route-level default-open behavior.
 *
 * - POST /conversations with no modelId and a grantless user resolves to
 *   the tenant default (200), never 403 NO_APPROVED_MODEL.
 * - When no servable model exists at all, /conversations surfaces the
 *   operational MODEL_UNAVAILABLE (500) instead of a permissions denial.
 * - POST/DELETE /admin/models/:id/access: explicit grant/revoke writes,
 *   validation of the exactly-one-principal rule, and audit events.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { getApprovedModelForUser } = vi.hoisted(() => ({
  getApprovedModelForUser: vi.fn(),
}));
const { resolveDefaultOpenModel } = vi.hoisted(() => ({
  resolveDefaultOpenModel: vi.fn(),
}));
const { recordAuditInTx } = vi.hoisted(() => ({ recordAuditInTx: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'fresh@example.test',
    displayName: 'Fresh User',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['chat:create', 'conversation:read', 'conversation:update'],
  },
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTx: vi.fn(async (cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock())),
}));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ getApprovedModelForUser }));
vi.mock('../src/ai/gateway/capabilityRouter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ai/gateway/capabilityRouter.js')>();
  return { ...actual, resolveDefaultOpenModel };
});
vi.mock('../src/audit/audit.js', () => ({ recordAuditInTx }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { conversationRoutes } from '../src/conversations/routes.js';
import { modelAdminRoutes } from '../src/ai/gateway/routes.js';
import { Errors } from '../src/errors.js';

const defaultModel = {
  id: 'default-model-id',
  name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  version: '1.0',
  contextWindow: 131072,
};

const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        sort: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      })),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 1 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
    };
  }
  return mockCollections[name];
}

async function buildConversationsApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL_ERROR', message: error.message });
  });
  await app.register(conversationRoutes);
  return app;
}

async function buildAdminApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL_ERROR', message: error.message });
  });
  await app.register(modelAdminRoutes);
  return app;
}

beforeEach(() => {
  for (const name of Object.keys(mockCollections)) delete mockCollections[name];
  const db = { collection: (name: string) => getMockCollection(name) };
  getDbMock.mockReset();
  tenantOpMock.mockReset();
  getDbMock.mockResolvedValue(db);
  tenantOpMock.mockImplementation(async (_t: string, cb: (d: any) => Promise<any>) => cb(db));
  vi.clearAllMocks();
  getDbMock.mockResolvedValue(db);
  tenantOpMock.mockImplementation(async (_t: string, cb: (d: any) => Promise<any>) => cb(db));
});

describe('POST /conversations (default-open)', () => {
  it('creates a conversation for a grantless user with the tenant default (no 403)', async () => {
    resolveDefaultOpenModel.mockResolvedValue(defaultModel);
    getApprovedModelForUser.mockResolvedValue(defaultModel);
    const app = await buildConversationsApp();

    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { title: 'hello' },
    });

    expect(res.statusCode).toBe(201);
    expect(resolveDefaultOpenModel).toHaveBeenCalledWith(
      currentAuth.tenantId,
      currentAuth.userId,
      currentAuth.roleId
    );
    const body = res.json();
    expect(res.json().conversation.model_id).toBe('default-model-id');
  });

  it('an explicit modelId still wins over the default', async () => {
    const explicitModelId = 'bbbbbbbb-2222-4222-8222-222222222222';
    const explicit = { id: explicitModelId, name: 'Explicit', version: '1.0', contextWindow: 8192 };
    getApprovedModelForUser.mockResolvedValue(explicit);
    const app = await buildConversationsApp();

    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { modelId: explicitModelId },
    });

    expect(res.statusCode).toBe(201);
    expect(resolveDefaultOpenModel).not.toHaveBeenCalled();
    expect(res.json().conversation.model_id).toBe(explicitModelId);
  });

  it('surfaces MODEL_UNAVAILABLE (not a permissions denial) when no servable model exists', async () => {
    resolveDefaultOpenModel.mockRejectedValue(Errors.internal('none', undefined, 'MODEL_UNAVAILABLE'));
    const app = await buildConversationsApp();

    const res = await app.inject({
      method: 'POST',
      url: '/conversations',
      payload: { title: 'hello' },
    });

    expect(res.statusCode).toBe(500);
    const body = res.json();
    expect(body.code).toBe('MODEL_UNAVAILABLE');
    expect(body.code).not.toBe('NO_APPROVED_MODEL');
  });
});

describe('admin model access endpoints', () => {
  const modelId = 'aaaaaaaa-1111-4111-8111-111111111111';
  const userId = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    getMockCollection('models').findOne.mockResolvedValue({ _id: modelId });
  });

  it('POST /admin/models/:id/access writes an explicit grant and audits it', async () => {
    const app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/models/${modelId}/access`,
      payload: { userId, revoked: false },
    });
    expect(res.statusCode).toBe(200);
    const access = getMockCollection('model_access');
    expect(access.updateOne).toHaveBeenCalledWith(
      { tenantId: currentAuth.tenantId, modelId, userId },
      expect.objectContaining({ $set: expect.objectContaining({ revoked: false }) }),
      expect.objectContaining({ upsert: true })
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: 'MODEL_ACCESS_SET' })
    );
  });

  it('POST /admin/models/:id/access writes an explicit revocation', async () => {
    const app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/models/${modelId}/access`,
      payload: { userId, revoked: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().revoked).toBe(true);
    expect(getMockCollection('model_access').updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ userId }),
      expect.objectContaining({ $set: expect.objectContaining({ revoked: true }) }),
      expect.anything()
    );
  });

  it('rejects when both or neither principal is supplied', async () => {
    const app = await buildAdminApp();
    for (const payload of [{ revoked: false }, { userId, roleId: 'r', revoked: false }]) {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/models/${modelId}/access`,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(getMockCollection('model_access').updateOne).not.toHaveBeenCalled();
  });

  it('DELETE /admin/models/:id/access clears the row and audits it', async () => {
    const app = await buildAdminApp();
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/models/${modelId}/access`,
      payload: { userId },
    });
    expect(res.statusCode).toBe(200);
    expect(getMockCollection('model_access').deleteOne).toHaveBeenCalledWith(
      { tenantId: currentAuth.tenantId, modelId, userId },
      expect.anything()
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ action: 'MODEL_ACCESS_CLEARED' })
    );
  });

  it('returns 404 for an unknown model', async () => {
    getMockCollection('models').findOne.mockResolvedValue(null);
    const app = await buildAdminApp();
    const res = await app.inject({
      method: 'POST',
      url: `/admin/models/${modelId}/access`,
      payload: { userId, revoked: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().code).toBe('MODEL_NOT_FOUND');
  });
});
