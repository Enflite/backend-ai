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
    permissions: ['chat:create', 'conversation:read', 'conversation:update', 'tool:use', 'syteline:read'],
  },
}));
const { resolveCapabilityModel } = vi.hoisted(() => ({ resolveCapabilityModel: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({ resolveCapabilityModel }));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ getApprovedModelForUser }));
vi.mock('../src/ai/gateway/privacyRouting.js', () => ({
  applyPrivacyRouting: async (input: { preliminaryModel: unknown }) => ({
    model: input.preliminaryModel,
    privacyOverridden: false,
    autoRoutedToCloud: false,
    notice: null,
    detection: { hasCustomerData: false, reasons: [], categories: [] },
    enforcedCategories: [],
    allEnforcedCategories: ['customer', 'finance', 'proprietary'],
    codeRoutableToCloud: true,
  }),
  stripCustomerDataTools: (tools: unknown[]) => tools,
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
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' }),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    };
  }
  return mockCollections[name];
}

function resetDbMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset();
    coll.findOne.mockResolvedValue(null);
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    coll.insertOne.mockReset();
    coll.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' });
    coll.updateOne.mockReset();
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

const testModel = {
  id: 'm1',
  name: 'Test Model',
  version: '1',
  provider: 'ollama',
  endpoint: 'http://localhost:11434',
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

function ssePayload(res: { rawPayload: Buffer }): string[] {
  return res.rawPayload.toString('utf8').split('\n\n').filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
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
    events: textOnly('Hey there! What can I help with?'),
    model: testModel,
    telemetry: {},
  }));
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

describe('chat small-talk bypass', () => {
  it('offers zero tools and the slim prompt on a greeting', async () => {
    let seenTools: unknown[] | undefined;
    let seenSystemPrompt = '';
    gatewayStream.mockImplementationOnce(async ({ tools, systemPrompt }: any) => {
      seenTools = tools;
      seenSystemPrompt = systemPrompt;
      return { events: textOnly('Hey! What can I do for you?'), model: testModel, telemetry: {} };
    });

    const res = await postChat({ content: 'Hello' });
    expect(res.statusCode).toBe(200);
    // No tools offered: the model cannot call repo.readFile (or anything else)
    // for a greeting, so the live "hello.ts" failure mode is impossible.
    expect(seenTools ?? []).toEqual([]);
    // Slim casual prompt, not the full charter prompt.
    expect(seenSystemPrompt).toContain('CASUAL TURN');
    expect(seenSystemPrompt).not.toContain('CONTENT ZONES');
    // The turn completes normally through the loop machinery.
    const payload = ssePayload(res as never);
    expect(payload.some((f) => f.includes('event: done'))).toBe(true);
    expect(payload.some((f) => f.includes('event: notice') && f.includes('TOOL_CALLS'))).toBe(false);
    // The bypass is audited for operator visibility.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'SMALLTALK_BYPASS' }));
  });

  it('still routes a greeting-prefixed ERP question with full tools', async () => {
    let seenTools: unknown[] | undefined;
    let seenSystemPrompt = '';
    gatewayStream.mockImplementationOnce(async ({ tools, systemPrompt }: any) => {
      seenTools = tools;
      seenSystemPrompt = systemPrompt;
      return { events: textOnly('Order status here.'), model: testModel, telemetry: {} };
    });

    const res = await postChat({ content: 'Hello, what is the status of order SO-123?' });
    expect(res.statusCode).toBe(200);
    expect((seenTools ?? []).length).toBeGreaterThan(0);
    expect(seenSystemPrompt).toContain('CONTENT ZONES');
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SMALLTALK_BYPASS' }));
  });

  it('does not bypass when document IDs are attached', async () => {
    gatewayStream.mockImplementationOnce(async () => ({
      events: textOnly('Summary here.'),
      model: testModel,
      telemetry: {},
    }));

    const res = await postChat({ content: 'hi', documentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
    expect(res.statusCode).toBe(200);
    // Attachments need the RAG path: retrieval runs, tools stay offered.
    expect(retrieveAuthorizedContext).toHaveBeenCalled();
    expect(gatewayStream).toHaveBeenCalledWith(expect.objectContaining({ tools: expect.any(Array) }));
    const tools = (gatewayStream.mock.calls[0]![0] as any).tools as unknown[];
    expect(tools.length).toBeGreaterThan(0);
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SMALLTALK_BYPASS' }));
  });

  it('does not bypass a bare acknowledgment (may continue a tool task)', async () => {
    let seenTools: unknown[] | undefined;
    gatewayStream.mockImplementationOnce(async ({ tools }: any) => {
      seenTools = tools;
      return { events: textOnly('On it.'), model: testModel, telemetry: {} };
    });

    const res = await postChat({ content: 'ok' });
    expect(res.statusCode).toBe(200);
    expect((seenTools ?? []).length).toBeGreaterThan(0);
    expect(recordAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'SMALLTALK_BYPASS' }));
  });
});
