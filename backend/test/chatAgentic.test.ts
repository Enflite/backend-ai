import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
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
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser, getApprovedModelForUser }));
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
import { toolRegistry } from '../src/tools/gateway.js';

const sytelineTool = toolRegistry.find((tool) => tool.name === 'syteline.getItem')!;

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
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
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
    coll.findOneAndUpdate.mockReset();
    coll.findOneAndUpdate.mockResolvedValue(null);
    coll.updateOne.mockReset();
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset();
    coll.updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
    coll.insertOne.mockReset();
    coll.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' });
    coll.deleteMany.mockReset();
    coll.deleteMany.mockResolvedValue({ deletedCount: 0 });
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

function ssePayload(res: { rawPayload: Buffer }): string[] {
  return res.rawPayload.toString('utf8').split('\n\n').filter(Boolean);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
  sytelineTool.execute = vi.fn(async () => ({ item: 'ABC', price: 42 })) as never;
  listApprovedModelsForUser.mockResolvedValue([testModel]);
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

describe('chat agentic loop', () => {
  it('executes a model-requested tool and feeds the delimited result back', async () => {
    const seenMessages: unknown[][] = [];
    gatewayStream
      .mockImplementationOnce(async ({ messages }: any) => {
        seenMessages.push(messages);
        return {
          events: (async function* () {
            yield { type: 'tool_call', id: 'call_1', name: 'syteline.getItem', arguments: '{"item":"ABC","site":"MAIN"}' };
          })(),
          model: testModel,
          telemetry: {},
        };
      })
      .mockImplementationOnce(async ({ messages }: any) => {
        seenMessages.push(messages);
        return { events: textOnly('The price is 42.'), model: testModel, telemetry: {} };
      });

    const res = await postChat({ content: 'What is the price of ABC?' });
    expect(res.statusCode).toBe(200);
    const payload = ssePayload(res as never);
    expect(payload.some((frame) => frame.includes('event: notice') && frame.includes('TOOL_CALLS'))).toBe(true);
    expect(payload.some((frame) => frame.includes('event: delta') && frame.includes('The price is 42.'))).toBe(true);

    // The second provider round received the assistant tool_calls turn plus a
    // delimited, untrusted tool result.
    const secondRound = seenMessages[1] as Array<{ role: string; content: string | null }>;
    const assistantTurn = secondRound.find((m) => m.role === 'assistant' && (m as any).tool_calls);
    expect(assistantTurn).toBeDefined();
    const toolResult = secondRound.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    expect(String(toolResult!.content)).toContain('<untrusted_tool_result name="syteline.getItem">');
    expect(String(toolResult!.content)).toContain('"price":42');

    // The tool execution was audited with the request correlation ID.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TOOL_EXECUTION', requestId: 'req-1' }));
  });

  it('stops the loop at the max iteration guard', async () => {
    gatewayStream.mockImplementation(async () => ({
      events: (async function* () {
        yield { type: 'tool_call', id: 'call_x', name: 'syteline.getItem', arguments: '{"item":"A","site":"MAIN"}' };
      })(),
      model: testModel,
      telemetry: {},
    }));
    const res = await postChat({ content: 'loop forever please' });
    expect(res.statusCode).toBe(200);
    // Default AI_MAX_TOOL_ITERATIONS=5: the gateway is invoked 6 times total
    // (initial + 5 tool rounds), then the turn ends without a 7th call.
    expect(gatewayStream).toHaveBeenCalledTimes(6);
    expect(ssePayload(res as never).some((f) => f.includes('event: done'))).toBe(true);
  });

  it('does not offer tools to callers without the tool:use permission', async () => {
    // Genuinely drop tool:use from the caller's permissions.
    currentAuth.permissions = ['chat:create', 'conversation:read', 'conversation:update'];
    try {
      gatewayStream.mockImplementationOnce(async (input: any) => {
        expect(input.tools ?? []).toEqual([]);
        return { events: textOnly('no tools'), model: testModel, telemetry: {} };
      });
      const res = await postChat({ content: 'hi' });
      expect(res.statusCode).toBe(200);
      expect(gatewayStream).toHaveBeenCalledTimes(1);
    } finally {
      currentAuth.permissions = ['chat:create', 'conversation:read', 'conversation:update', 'tool:use'];
    }
  });

  it('truncates streamed output at AI_MAX_RESPONSE_CHARS', async () => {
    const huge = 'x'.repeat(70000);
    gatewayStream.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'text', content: huge };
      })(),
      model: testModel,
      telemetry: {},
    }));
    const res = await postChat({ content: 'say a lot' });
    const payload = ssePayload(res as never);
    const done = payload.find((f) => f.includes('event: done'));
    expect(done).toContain('"finishReason":"length"');
    const deltas = payload.filter((f) => f.includes('event: delta'));
    const total = deltas.reduce((sum, f) => sum + (JSON.parse(f.split('\ndata: ')[1]!).content as string).length, 0);
    expect(total).toBeLessThanOrEqual(65536);
  });

  it('instructs the model not to hallucinate when retrieval returns nothing', async () => {
    let seenMessages: Array<{ role: string; content: string | null }> = [];
    gatewayStream.mockImplementationOnce(async ({ messages }: any) => {
      seenMessages = messages;
      return { events: textOnly('I found nothing.'), model: testModel, telemetry: {} };
    });
    const res = await postChat({ content: 'summarize doc', documentIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'] });
    expect(res.statusCode).toBe(200);
    const instruction = seenMessages.find((m) => String(m.content).includes('DOCUMENT RETRIEVAL RESULT'));
    expect(instruction).toBeDefined();
    expect(String(instruction!.content)).toContain('Do not invent document contents');
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'RAG_RETRIEVAL' }));
  });

  it('feeds tool authorization failures back to the model instead of crashing', async () => {
    gatewayStream
      .mockImplementationOnce(async () => ({
        events: (async function* () {
          // No such tool: exercises the denial path inside the loop.
          yield { type: 'tool_call', id: 'call_9', name: 'nope.notreal', arguments: '{}' };
        })(),
        model: testModel,
        telemetry: {},
      }))
      .mockImplementationOnce(async ({ messages }: any) => {
        const toolResult = (messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool');
        expect(String(toolResult!.content)).toContain('TOOL_NOT_FOUND');
        return { events: textOnly('that tool does not exist'), model: testModel, telemetry: {} };
      });
    const res = await postChat({ content: 'use the nope tool' });
    expect(res.statusCode).toBe(200);
    expect(ssePayload(res as never).some((f) => f.includes('that tool does not exist'))).toBe(true);
  });

  it('emits usage and timing in the done event', async () => {
    gatewayStream.mockImplementationOnce(async (input: any) => {
      // The real gateway fills the caller-provided telemetry object in place.
      Object.assign(input.telemetry, {
        timeToFirstTokenMs: 123,
        usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
      });
      return {
        events: (async function* () {
          yield { type: 'text', content: 'hi' };
        })(),
        model: testModel,
        telemetry: input.telemetry,
      };
    });
    const res = await postChat({ content: 'hi' });
    const done = ssePayload(res as never).find((f) => f.includes('event: done'));
    expect(done).toContain('"promptTokens":10');
    expect(done).toContain('"timeToFirstTokenMs":123');
  });
});
