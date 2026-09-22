import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Errors } from '../src/errors.js';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const { recordAudit, recordAuditInTx } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  recordAuditInTx: vi.fn(),
}));
const { resolveServingModel } = vi.hoisted(() => ({ resolveServingModel: vi.fn() }));
const { listApprovedModelsForUser } = vi.hoisted(() => ({
  listApprovedModelsForUser: vi.fn(),
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit, recordAuditInTx }));
vi.mock('../src/ai/gateway/modelLifecycle.js', () => ({
  resolveServingModel,
  KNOWN_CAPABILITIES: ['chat', 'syteline', 'coding', 'embeddings'],
}));
vi.mock('../src/ai/gateway/modelRegistry.js', () => ({ listApprovedModelsForUser }));

import {
  getRoutingPolicy,
  listRoutingPolicies,
  normalizeCapability,
  resolveCapabilityModel,
  setRoutingPolicy,
} from '../src/ai/gateway/capabilityRouter.js';

const chatModel = { id: 'chat-1', name: 'Chat Model', contextWindow: 8192, version: '1.0' };
const sytelineModel = { id: 'sy-1', name: 'SyteLine Model', contextWindow: 32768, version: '2.0' };

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
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1, upsertedCount: 0 }),
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
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1, upsertedCount: 0 });
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

beforeEach(() => {
  vi.clearAllMocks();
  resetDbMocks();
  recordAudit.mockResolvedValue(undefined);
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('normalizeCapability', () => {
  it('accepts the four slots, case-insensitively', () => {
    expect(normalizeCapability('chat')).toBe('chat');
    expect(normalizeCapability('Coding')).toBe('coding');
    expect(normalizeCapability(' SYTELINE ')).toBe('syteline');
    expect(normalizeCapability('embeddings')).toBe('embeddings');
  });
  it('rejects unknown capabilities', () => {
    expect(() => normalizeCapability('image-gen')).toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });
});

describe('routing policy storage', () => {
  it('returns the platform default when the tenant never configured one', async () => {
    getMockCollection('model_routing_policies').findOne.mockResolvedValue(null);
    const policy = await getRoutingPolicy('t1', 'coding');
    expect(policy).toMatchObject({ tenantId: 't1', capability: 'coding', strategy: 'quality', fallbackToChat: true });
  });
  it('lists configured policies', async () => {
    const policiesColl = getMockCollection('model_routing_policies');
    policiesColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'p1', tenantId: 't1', capability: 'syteline', strategy: 'latency', fallbackToChat: false, updatedBy: 'admin-1', updatedAt: new Date() },
      ]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    expect(await listRoutingPolicies('t1')).toHaveLength(1);
  });
  it('upserts a policy and audits it', async () => {
    const policiesColl = getMockCollection('model_routing_policies');
    const doc = {
      _id: 'p1',
      tenantId: 't1',
      capability: 'syteline',
      strategy: 'latency',
      fallbackToChat: false,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    };
    policiesColl.findOne.mockResolvedValue(doc);
    const saved = await setRoutingPolicy('t1', 'syteline', { strategy: 'latency', fallbackToChat: false }, 'admin-1', 'req-1');
    expect(saved).toMatchObject({ tenantId: 't1', capability: 'syteline', strategy: 'latency', fallbackToChat: false });
    // The upsert ran with upsert:true inside the tenant transaction.
    expect(policiesColl.updateOne).toHaveBeenCalledWith(
      { tenantId: 't1', capability: 'syteline' },
      expect.objectContaining({ $set: expect.objectContaining({ strategy: 'latency', fallbackToChat: false }) }),
      expect.objectContaining({ upsert: true })
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MODEL_ROUTING_POLICY_SET',
        resourceId: 't1:syteline',
        metadata: { capability: 'syteline', strategy: 'latency', fallbackToChat: false },
      })
    );
  });
  it('rejects unknown strategies and capabilities', async () => {
    await expect(
      setRoutingPolicy('t1', 'syteline', { strategy: 'rocket' as never, fallbackToChat: true }, 'admin-1')
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_STRATEGY' }));
    await expect(
      setRoutingPolicy('t1', 'nope', { strategy: 'cost', fallbackToChat: true }, 'admin-1')
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
  });
});

describe('resolveCapabilityModel', () => {
  function mockDefaultPolicy() {
    getMockCollection('model_routing_policies').findOne.mockResolvedValue(null); // getRoutingPolicy -> platform default
  }

  it('serves chat exactly as before: chat default, then first approved', async () => {
    mockDefaultPolicy();
    resolveServingModel.mockResolvedValue(chatModel);
    const res = await resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'chat' });
    expect(res).toMatchObject({ requested: 'chat', resolved: 'chat', fallbackUsed: false });
    expect(res.model.id).toBe('chat-1');
    expect(resolveServingModel).toHaveBeenCalledWith('t1', 'u1', 'r1', 'chat');
    // The fallback target never self-audits a fallback.
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('serves a capability from its own default when healthy', async () => {
    mockDefaultPolicy();
    resolveServingModel.mockResolvedValue(sytelineModel);
    const res = await resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'syteline' });
    expect(res).toMatchObject({ requested: 'syteline', resolved: 'syteline', fallbackUsed: false, strategy: 'quality' });
    expect(res.model.id).toBe('sy-1');
    expect(recordAudit).not.toHaveBeenCalled();
  });

  it('falls back to chat when the capability default is stale, audited once, before streaming', async () => {
    mockDefaultPolicy();
    // SyteLine default went stale (model deprecated / grant revoked): the
    // registry throws MODEL_NOT_APPROVED and the router falls back to chat.
    resolveServingModel.mockImplementation(async (_t: string, _u: string, _r: string, cap: string) => {
      if (cap === 'syteline') throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
      return chatModel;
    });
    const res = await resolveCapabilityModel({
      tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'syteline', requestId: 'req-9',
    });
    expect(res).toMatchObject({
      requested: 'syteline',
      resolved: 'chat',
      fallbackUsed: true,
      fallbackReason: 'Model is not approved for this user and tenant',
    });
    expect(res.model.id).toBe('chat-1');
    // Exactly one fallback audit, before streaming begins.
    const fallbacks = recordAudit.mock.calls.map((c) => c[0]).filter((e) => e.action === 'MODEL_CAPABILITY_FALLBACK');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({
      success: true,
      resourceId: 'chat-1',
      metadata: { capability: 'syteline', fallbackModelId: 'chat-1' },
    });
  });

  it('propagates unexpected resolution errors instead of falling back', async () => {
    mockDefaultPolicy();
    // A database outage (or any non-MODEL_NOT_APPROVED throw) must surface,
    // not masquerade as a healthy chat fallback.
    resolveServingModel.mockRejectedValueOnce(new Error('connection refused'));
    await expect(
      resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'syteline', requestId: 'req-10' })
    ).rejects.toThrow('connection refused');
    const fallbacks = recordAudit.mock.calls.map((c) => c[0]).filter((e) => e.action === 'MODEL_CAPABILITY_FALLBACK');
    expect(fallbacks).toHaveLength(0);
  });

  it('fails closed when the tenant disabled fallback', async () => {
    getMockCollection('model_routing_policies').findOne.mockResolvedValue({
      _id: 'p1',
      tenantId: 't1',
      capability: 'coding',
      strategy: 'cost',
      fallbackToChat: false,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    });
    resolveServingModel.mockResolvedValue(null);
    await expect(
      resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'coding' })
    ).rejects.toThrowError(expect.objectContaining({ code: 'NO_APPROVED_MODEL' }));
    const fallbacks = recordAudit.mock.calls.map((c) => c[0]).filter((e) => e.action === 'MODEL_CAPABILITY_FALLBACK');
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]).toMatchObject({ success: false });
  });

  it('routes an embeddings chat turn to the chat default, audited and honest', async () => {
    mockDefaultPolicy();
    resolveServingModel.mockResolvedValue(chatModel);
    const res = await resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'embeddings' });
    expect(res).toMatchObject({
      requested: 'embeddings',
      resolved: 'chat',
      fallbackUsed: true,
      fallbackReason: 'embeddings capability does not serve chat turns',
    });
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MODEL_CAPABILITY_FALLBACK', success: true })
    );
  });

  it('rejects unknown capabilities without touching the database for a policy', async () => {
    await expect(
      resolveCapabilityModel({ tenantId: 't1', userId: 'u1', roleId: 'r1', capability: 'nope' })
    ).rejects.toThrowError(expect.objectContaining({ code: 'INVALID_CAPABILITY' }));
    expect(getMockCollection('model_routing_policies').findOne).not.toHaveBeenCalled();
  });
});
