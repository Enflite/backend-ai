/**
 * chatDlp.test.ts — DLP outbound boundary at the chat route (Phase 5c).
 *
 * The unit tests in dlp.test.ts cover the guard itself; these tests prove
 * the route wiring:
 *  1. PII split across provider chunks never reaches SSE: the guard's
 *     holdback redacts the complete span before emission.
 *  2. The persisted transcript exactly equals the redacted streamed text.
 *  3. A mid-stream failure never leaks the guard's held-back tail into SSE
 *     or the transcript.
 *  4. DLP audits carry kinds/counts only — never matched text.
 */
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
import { DLP_MARKERS } from '../src/dlp/detectors.js';

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

/** Assistant message docs captured so tests can assert on persisted text. */
let persistedAssistantMessages: Array<{ content: string; metadata: any }> = [];

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
      insertOne: vi.fn().mockImplementation(async (doc: any) => {
        // Capture assistant messages for DLP assertions (content + metadata
        // are stored as native fields — no JSON.stringify, ADR-014).
        if (name === 'messages' && doc.role === 'assistant') {
          persistedAssistantMessages.push({ content: doc.content, metadata: doc.metadata });
        }
        return { acknowledged: true, insertedId: doc._id ?? 'mock-id' };
      }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetDbMocks() {
  persistedAssistantMessages = [];
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
    coll.insertOne.mockImplementation(async (doc: any) => {
      if (name === 'messages' && doc.role === 'assistant') {
        persistedAssistantMessages.push({ content: doc.content, metadata: doc.metadata });
      }
      return { acknowledged: true, insertedId: doc._id ?? 'mock-id' };
    });
    coll.deleteMany.mockReset();
    coll.deleteMany.mockResolvedValue({ deletedCount: 0 });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

function sseFrames(res: { rawPayload: Buffer }): string[] {
  return res.rawPayload.toString('utf8').split('\n\n').filter(Boolean);
}

/** Concatenates every `delta` frame's content, in order. */
function streamedText(frames: string[]): string {
  let out = '';
  for (const frame of frames) {
    if (!frame.includes('event: delta')) continue;
    const dataLine = frame.split('\n').find((line) => line.startsWith('data: '));
    if (dataLine) out += (JSON.parse(dataLine.slice('data: '.length)) as { content: string }).content;
  }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
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

async function postChat(body: Record<string, unknown>) {
  const app = Fastify();
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(chatRoutes, { prefix: '/api/v1' });
  return app.inject({ method: 'POST', url: '/api/v1/chat', payload: body });
}

describe('chat DLP outbound boundary', () => {
  it('redacts PII split across chunks: SSE and the transcript see only the marker', async () => {
    gatewayStream.mockImplementationOnce(async () => ({
      events: (async function* () {
        // The SSN is split mid-pattern across provider chunks.
        yield { type: 'text', content: 'Your SSN is 123-45-67' };
        yield { type: 'text', content: '89, keep it safe.' };
      })(),
      model: testModel,
      telemetry: {},
    }));

    const res = await postChat({ content: 'What is my SSN?' });
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res as never);
    const raw = frames.join('\n');

    // The raw digits never appear on the wire — not even in a held-back
    // chunk boundary.
    expect(raw).not.toContain('123-45-6789');
    expect(raw).not.toMatch(/\d{3}-\d{2}-\d{4}/);

    const streamed = streamedText(frames);
    expect(streamed).toBe(`Your SSN is ${DLP_MARKERS.ssn}, keep it safe.`);

    // The persisted transcript is exactly the redacted streamed text.
    expect(persistedAssistantMessages).toHaveLength(1);
    expect(persistedAssistantMessages[0]!.content).toBe(streamed);
    expect(persistedAssistantMessages[0]!.content).not.toContain('123-45-6789');
  });

  it('audits DLP detections with kinds/counts only, never matched text', async () => {
    gatewayStream.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield { type: 'text', content: 'SSN 123-45-6789 here.' };
      })(),
      model: testModel,
      telemetry: {},
    }));

    const res = await postChat({ content: 'hi' });
    expect(res.statusCode).toBe(200);
    const auditCall = recordAudit.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'DLP_DETECTION'
    );
    expect(auditCall).toBeDefined();
    const payload = auditCall![0] as { metadata: { counts: Record<string, number>; redactedSpans: number } };
    expect(payload.metadata.counts).toEqual({ ssn: 1 });
    expect(payload.metadata.redactedSpans).toBe(1);
    expect(JSON.stringify(auditCall![0])).not.toContain('123-45-6789');
  });

  it('never leaks the guard holdback when the stream fails mid-pattern', async () => {
    gatewayStream.mockImplementationOnce(async () => ({
      events: (async function* () {
        // The guard holds '123-45-67' back; then the provider dies.
        yield { type: 'text', content: 'Partial 123-45-67' };
        throw new Error('provider exploded');
      })(),
      model: testModel,
      telemetry: {},
    }));

    const res = await postChat({ content: 'hi' });
    expect(res.statusCode).toBe(200);
    const frames = sseFrames(res as never);
    const raw = frames.join('\n');

    // The held-back tail is dropped, not flushed into the error stream.
    expect(raw).not.toContain('123-45-67');
    expect(raw).not.toMatch(/\d{3}-\d{2}-\d{4}/);

    // …and not persisted either: the transcript holds only emitted text.
    // (The space before the digits is held back too — it may be a card
    // number separator — so nothing after 'Partial' is emitted.)
    expect(persistedAssistantMessages).toHaveLength(1);
    expect(persistedAssistantMessages[0]!.content).toBe('Partial');
    expect(persistedAssistantMessages[0]!.content).not.toContain('123-45-67');
    // The turn is marked interrupted, not completed (metadata is a native
    // subdocument in MongoDB — no JSON.stringify, ADR-014).
    expect(persistedAssistantMessages[0]!.metadata).toMatchObject({ stream_status: 'interrupted' });
  });
});
