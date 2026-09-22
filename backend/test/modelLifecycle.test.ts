import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock, withTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTxMock = vi.fn(async (cb: (session: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTxMock };
});
const { recordAuditInTx } = vi.hoisted(() => ({ recordAuditInTx: vi.fn() }));
const { getPromotionGate } = vi.hoisted(() => ({ getPromotionGate: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock, withTx: withTxMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAuditInTx }));
vi.mock('../src/eval/compare.js', () => ({ getPromotionGate }));

import { listServingDefaults, setServingDefault, transitionModel } from '../src/ai/gateway/modelLifecycle.js';

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
}

function modelDoc(status: string) {
  return {
    _id: MODEL_ID,
    name: 'test/model',
    version: '1.0',
    provider: 'vllm',
    endpoint: 'http://vllm:8000/v1',
    modelIdentifier: 'test/model',
    status,
    license: null,
    source: null,
    sha256: null,
    contextWindow: 8192,
    capabilities: {},
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    enabled: true,
    createdAt: new Date(),
  };
}

function baseArgs(toStatus: string) {
  return {
    modelId: MODEL_ID,
    toStatus: toStatus as never,
    actorUserId: 'admin-1',
    tenantId: TENANT,
    requestId: 'req-1',
    ip: '127.0.0.1',
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('transitionModel state machine', () => {
  it('walks a valid forward transition and writes the transition + audit atomically', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('REGISTERED'));
    modelsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });

    const result = await transitionModel(baseArgs('DOWNLOADING'));
    expect(result).toMatchObject({ modelId: MODEL_ID, fromStatus: 'REGISTERED', toStatus: 'DOWNLOADING' });
    // Both statements ran inside one transaction: withTx was entered once and
    // the audit was recorded through the transaction session.
    expect(withTxMock).toHaveBeenCalledTimes(1);
    expect(modelsColl.findOne).toHaveBeenCalledWith({ _id: MODEL_ID }, expect.objectContaining({ session: expect.anything() }));
    expect(modelsColl.updateOne).toHaveBeenCalledWith(
      { _id: MODEL_ID },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'DOWNLOADING' }) }),
      expect.objectContaining({ session: expect.anything() })
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_LIFECYCLE_TRANSITION', resourceId: MODEL_ID })
    );
  });

  it('rejects an illegal jump (REGISTERED -> ACTIVE)', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('REGISTERED'));
    await expect(transitionModel(baseArgs('ACTIVE'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    // No UPDATE and no audit happened after the failed transition.
    expect(modelsColl.findOne).toHaveBeenCalledTimes(1);
    expect(modelsColl.updateOne).not.toHaveBeenCalled();
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('rejects a transition to the current state', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('CANARY'));
    await expect(transitionModel(baseArgs('CANARY'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    expect(modelsColl.findOne).toHaveBeenCalledTimes(1);
    expect(modelsColl.updateOne).not.toHaveBeenCalled();
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown model id', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(null);
    await expect(transitionModel(baseArgs('DOWNLOADING'))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('rejects an unknown target status via the state machine', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('REGISTERED'));
    await expect(transitionModel(baseArgs('BOGUS'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('gates PENDING_APPROVAL -> APPROVED on the Phase 2 eval promotion gate', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: true, latestRunId: 'run-1' });
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('PENDING_APPROVAL'));
    modelsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });

    const result = await transitionModel(baseArgs('APPROVED'));
    expect(result.toStatus).toBe('APPROVED');
    expect(result.gateRunId).toBe('run-1');
    expect(getPromotionGate).toHaveBeenCalledWith(MODEL_ID);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'MODEL_LIFECYCLE_TRANSITION',
        metadata: expect.objectContaining({ gateRunId: 'run-1', gatePassed: true }),
      })
    );
  });

  it('blocks approval when the promotion gate fails — there is no skip', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: false, reason: 'P0 failures: 2' });
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('PENDING_APPROVAL'));
    await expect(transitionModel(baseArgs('APPROVED'))).rejects.toMatchObject({
      code: 'MODEL_PROMOTION_GATE_FAILED',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('blocks approval when no completed eval run exists', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: false, reason: 'no completed eval run' });
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('PENDING_APPROVAL'));
    await expect(transitionModel(baseArgs('APPROVED'))).rejects.toMatchObject({
      code: 'MODEL_PROMOTION_GATE_FAILED',
    });
  });

  it('reactivates a deprecated model via DEPRECATED -> ACTIVE', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('DEPRECATED'));
    modelsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });

    const result = await transitionModel(baseArgs('ACTIVE'));
    expect(result).toMatchObject({ fromStatus: 'DEPRECATED', toStatus: 'ACTIVE' });
  });

  it('walks the full happy path REGISTERED -> ... -> ACTIVE', async () => {
    const modelsColl = getMockCollection('models');
    const path = ['DOWNLOADING', 'VALIDATING', 'EVALUATING', 'PENDING_APPROVAL'] as const;
    let current = 'REGISTERED';
    for (const next of path) {
      modelsColl.findOne.mockResolvedValueOnce(modelDoc(current));
      const result = await transitionModel(baseArgs(next));
      expect(result.toStatus).toBe(next);
      current = next;
    }
    getPromotionGate.mockResolvedValueOnce({ eligible: true, latestRunId: 'run-9' });
    modelsColl.findOne.mockResolvedValueOnce(modelDoc('PENDING_APPROVAL'));
    expect((await transitionModel(baseArgs('APPROVED'))).toStatus).toBe('APPROVED');
    modelsColl.findOne.mockResolvedValueOnce(modelDoc('APPROVED'));
    expect((await transitionModel(baseArgs('CANARY'))).toStatus).toBe('CANARY');
    modelsColl.findOne.mockResolvedValueOnce(modelDoc('CANARY'));
    expect((await transitionModel(baseArgs('ACTIVE'))).toStatus).toBe('ACTIVE');
  });
});

describe('serving defaults', () => {
  it('sets a default only for a servable (ACTIVE) model and audits it', async () => {
    const modelsColl = getMockCollection('models');
    const defaultsColl = getMockCollection('model_serving_defaults');
    modelsColl.findOne.mockResolvedValue(modelDoc('ACTIVE'));
    const upsertedDoc = {
      _id: `${TENANT}:chat`,
      tenantId: TENANT,
      capability: 'chat',
      modelId: MODEL_ID,
      updatedBy: 'admin-1',
      updatedAt: new Date(),
    };
    defaultsColl.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1, upsertedId: upsertedDoc._id });
    defaultsColl.findOne.mockResolvedValue(upsertedDoc);

    const def = await setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1');
    expect(def).toMatchObject({ tenantId: TENANT, capability: 'chat', modelId: MODEL_ID });
    expect(defaultsColl.updateOne).toHaveBeenCalledWith(
      { tenantId: TENANT, capability: 'chat' },
      expect.objectContaining({ $set: expect.objectContaining({ modelId: MODEL_ID }) }),
      expect.objectContaining({ upsert: true })
    );
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_SERVING_DEFAULT_SET', resource: 'model_serving_default' })
    );
  });

  it('refuses to point a default at a non-servable (APPROVED) model', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(modelDoc('APPROVED'));
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_SERVABLE',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('refuses a default for a disabled model', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue({ ...modelDoc('ACTIVE'), enabled: false });
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_SERVABLE',
    });
  });

  it('returns 404 for an unknown model', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValue(null);
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('lists a tenant\'s serving defaults', async () => {
    const defaultsColl = getMockCollection('model_serving_defaults');
    const doc = {
      _id: `${TENANT}:chat`,
      tenantId: TENANT,
      capability: 'chat',
      modelId: MODEL_ID,
      updatedBy: 'admin-1',
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    };
    defaultsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([doc]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));

    await expect(listServingDefaults(TENANT)).resolves.toEqual([
      { tenantId: TENANT, capability: 'chat', modelId: MODEL_ID, updatedBy: 'admin-1', updatedAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    // Scoped to the tenant in MongoDB: no cross-tenant leakage.
    expect(defaultsColl.find).toHaveBeenCalledWith({ tenantId: TENANT });
    expect(tenantOpMock).toHaveBeenCalledWith(TENANT, expect.any(Function));
  });
});
