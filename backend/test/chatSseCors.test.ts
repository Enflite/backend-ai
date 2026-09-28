/**
 * chatSseCors.test.ts — regression test for the "Failed to fetch" dev bug.
 *
 * The /chat SSE handler hijacks the reply, which bypasses @fastify/cors, so
 * the CORS headers a cross-origin browser client needs must be written by
 * hand. Without them the browser blocks the stream even though the turn
 * completed 200 server-side. These tests pin the allowlist semantics:
 * reflect the Origin only when it is on the configured CORS_ORIGIN list,
 * never `*`, and always add Vary: Origin.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { getApprovedModelForUser } = vi.hoisted(() => ({ getApprovedModelForUser: vi.fn() }));
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

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({ resolveCapabilityModel }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({
  listApprovedModelsForUser: vi.fn(),
  getApprovedModelForUser,
}));
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
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

const testModel = {
  id: 'm1',
  name: 'Test Model',
  version: '1',
  provider: 'vllm',
  endpoint: 'http://localhost:8000/v1',
  modelIdentifier: 'test-model',
  status: 'ACTIVE',
  contextWindow: 8192,
  capabilities: {},
  allowedClassifications: ['PUBLIC', 'INTERNAL'],
  deployment: {},
  requestTimeoutMs: null,
  maxTokens: null,
  temperature: null,
  fallbackModelId: null,
};

async function* textOnly(text: string) {
  yield { type: 'text', content: text };
}

beforeEach(() => {
  vi.clearAllMocks();
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  resolveCapabilityModel.mockResolvedValue({
    requested: 'chat',
    resolved: 'chat',
    model: testModel,
    fallbackUsed: false,
    strategy: 'quality',
  });
  getApprovedModelForUser.mockResolvedValue(testModel);
  retrieveAuthorizedContext.mockResolvedValue({ context: '', citations: [], results: [] });
  recordAudit.mockResolvedValue(undefined);
  gatewayStream.mockImplementation(async () => ({
    events: textOnly('hello'),
    model: testModel,
    telemetry: {},
  }));
});

async function postChat(origin?: string) {
  const app = Fastify();
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  return app.inject({
    method: 'POST',
    url: '/api/v1/chat',
    payload: { content: 'hi' },
    headers: origin ? { origin } : {},
  });
}

describe('chat SSE CORS headers', () => {
  it('reflects an allowed origin with credentials and Vary: Origin', async () => {
    // Default CORS_ORIGIN is http://localhost:8443 (dev frontend).
    const res = await postChat('http://localhost:8443');
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8443');
    expect(res.headers['access-control-allow-credentials']).toBe('true');
    expect(String(res.headers.vary ?? '')).toContain('Origin');
  });

  it('omits Access-Control-Allow-Origin for a disallowed origin', async () => {
    const res = await postChat('https://evil.example');
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('omits Access-Control-Allow-Origin when no origin is sent', async () => {
    const res = await postChat();
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
