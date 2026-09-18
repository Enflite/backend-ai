import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, withTx } = vi.hoisted(() => {
  const query = vi.fn();
  const withTx = vi.fn(async (callback: (client: { query: typeof query }) => Promise<unknown>) =>
    callback({ query }));
  return { query, withTx };
});
const { recordAuditInTx } = vi.hoisted(() => ({ recordAuditInTx: vi.fn() }));
const { getPromotionGate } = vi.hoisted(() => ({ getPromotionGate: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ query, withTx }));
vi.mock('../src/audit/audit.js', () => ({ recordAuditInTx }));
vi.mock('../src/eval/compare.js', () => ({ getPromotionGate }));

import { listServingDefaults, setServingDefault, transitionModel } from '../src/ai/gateway/modelLifecycle.js';

const MODEL_ID = '55555555-5555-4555-8555-555555555555';
const TENANT = '22222222-2222-4222-8222-222222222222';

function modelRow(status: string) {
  return {
    id: MODEL_ID,
    name: 'test/model',
    version: '1.0',
    provider: 'vllm',
    endpoint: 'http://vllm:8000/v1',
    model_identifier: 'test/model',
    status,
    license: null,
    source: null,
    sha256: null,
    context_window: 8192,
    capabilities: {},
    allowed_classifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    request_timeout_ms: null,
    max_tokens: null,
    temperature: null,
    fallback_model_id: null,
    enabled: true,
    created_at: new Date(),
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
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('transitionModel state machine', () => {
  it('walks a valid forward transition and writes the transition + audit atomically', async () => {
    query
      .mockResolvedValueOnce({ rows: [modelRow('REGISTERED')], rowCount: 1 }) // FOR UPDATE lock
      .mockResolvedValueOnce({ rows: [modelRow('DOWNLOADING')], rowCount: 1 }); // UPDATE
    const result = await transitionModel(baseArgs('DOWNLOADING'));
    expect(result).toMatchObject({ modelId: MODEL_ID, fromStatus: 'REGISTERED', toStatus: 'DOWNLOADING' });
    // Both statements ran inside one transaction: withTx was entered once and
    // the audit was recorded through the transaction client.
    expect(withTx).toHaveBeenCalledTimes(1);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_LIFECYCLE_TRANSITION', resourceId: MODEL_ID })
    );
  });

  it('rejects an illegal jump (REGISTERED -> ACTIVE)', async () => {
    query.mockResolvedValueOnce({ rows: [modelRow('REGISTERED')], rowCount: 1 });
    await expect(transitionModel(baseArgs('ACTIVE'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    // No UPDATE and no audit happened after the failed transition.
    expect(query).toHaveBeenCalledTimes(1);
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('rejects a transition to the current state', async () => {
    query.mockResolvedValueOnce({ rows: [modelRow('CANARY')], rowCount: 1 });
    await expect(transitionModel(baseArgs('CANARY'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown model id', async () => {
    query.mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(transitionModel(baseArgs('DOWNLOADING'))).rejects.toMatchObject({ code: 'MODEL_NOT_FOUND' });
  });

  it('rejects an unknown target status via the state machine', async () => {
    query.mockResolvedValueOnce({ rows: [modelRow('REGISTERED')], rowCount: 1 });
    await expect(transitionModel(baseArgs('BOGUS'))).rejects.toMatchObject({
      code: 'MODEL_TRANSITION_INVALID',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('gates PENDING_APPROVAL -> APPROVED on the Phase 2 eval promotion gate', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: true, latestRunId: 'run-1' });
    query
      .mockResolvedValueOnce({ rows: [modelRow('PENDING_APPROVAL')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('APPROVED')], rowCount: 1 });
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
    query.mockResolvedValueOnce({ rows: [modelRow('PENDING_APPROVAL')], rowCount: 1 });
    await expect(transitionModel(baseArgs('APPROVED'))).rejects.toMatchObject({
      code: 'MODEL_PROMOTION_GATE_FAILED',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('blocks approval when no completed eval run exists', async () => {
    getPromotionGate.mockResolvedValueOnce({ eligible: false, reason: 'no completed eval run' });
    query.mockResolvedValueOnce({ rows: [modelRow('PENDING_APPROVAL')], rowCount: 1 });
    await expect(transitionModel(baseArgs('APPROVED'))).rejects.toMatchObject({
      code: 'MODEL_PROMOTION_GATE_FAILED',
    });
  });

  it('reactivates a deprecated model via DEPRECATED -> ACTIVE', async () => {
    query
      .mockResolvedValueOnce({ rows: [modelRow('DEPRECATED')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('ACTIVE')], rowCount: 1 });
    const result = await transitionModel(baseArgs('ACTIVE'));
    expect(result).toMatchObject({ fromStatus: 'DEPRECATED', toStatus: 'ACTIVE' });
  });

  it('walks the full happy path REGISTERED -> ... -> ACTIVE', async () => {
    const path = ['DOWNLOADING', 'VALIDATING', 'EVALUATING', 'PENDING_APPROVAL'] as const;
    let current = 'REGISTERED';
    for (const next of path) {
      query
        .mockResolvedValueOnce({ rows: [modelRow(current)], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [modelRow(next)], rowCount: 1 });
      const result = await transitionModel(baseArgs(next));
      expect(result.toStatus).toBe(next);
      current = next;
    }
    getPromotionGate.mockResolvedValueOnce({ eligible: true, latestRunId: 'run-9' });
    query
      .mockResolvedValueOnce({ rows: [modelRow('PENDING_APPROVAL')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('APPROVED')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('APPROVED')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('CANARY')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('CANARY')], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [modelRow('ACTIVE')], rowCount: 1 });
    expect((await transitionModel(baseArgs('APPROVED'))).toStatus).toBe('APPROVED');
    expect((await transitionModel(baseArgs('CANARY'))).toStatus).toBe('CANARY');
    expect((await transitionModel(baseArgs('ACTIVE'))).toStatus).toBe('ACTIVE');
  });
});

describe('serving defaults', () => {
  it('sets a default only for a servable (ACTIVE) model and audits it', async () => {
    query
      .mockResolvedValueOnce({ rows: [modelRow('ACTIVE')], rowCount: 1 }) // servability check
      .mockResolvedValueOnce({ rows: [{ tenantId: TENANT, capability: 'chat', modelId: MODEL_ID, updatedBy: 'admin-1', updatedAt: new Date() }], rowCount: 1 }); // upsert
    const def = await setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1');
    expect(def).toMatchObject({ tenantId: TENANT, capability: 'chat', modelId: MODEL_ID });
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'MODEL_SERVING_DEFAULT_SET', resource: 'model_serving_default' })
    );
  });

  it('refuses to point a default at a non-servable (APPROVED) model', async () => {
    query.mockResolvedValueOnce({ rows: [modelRow('APPROVED')], rowCount: 1 });
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_SERVABLE',
    });
    expect(recordAuditInTx).not.toHaveBeenCalled();
  });

  it('refuses a default for a disabled model', async () => {
    query.mockResolvedValueOnce({ rows: [{ ...modelRow('ACTIVE'), enabled: false }], rowCount: 1 });
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_SERVABLE',
    });
  });

  it('returns 404 for an unknown model', async () => {
    query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    await expect(setServingDefault(TENANT, 'chat', MODEL_ID, 'admin-1', 'req-1', '127.0.0.1')).rejects.toMatchObject({
      code: 'MODEL_NOT_FOUND',
    });
  });

  it('lists a tenant\'s serving defaults', async () => {
    query.mockResolvedValueOnce({
      rows: [{ tenantId: TENANT, capability: 'chat', modelId: MODEL_ID, updatedBy: 'admin-1', updatedAt: new Date('2026-01-01T00:00:00Z') }],
      rowCount: 1,
    });
    await expect(listServingDefaults(TENANT)).resolves.toEqual([
      { tenantId: TENANT, capability: 'chat', modelId: MODEL_ID, updatedBy: 'admin-1', updatedAt: new Date('2026-01-01T00:00:00Z') },
    ]);
    // Scoped to the tenant in SQL: no cross-tenant leakage.
    expect(query.mock.calls[0]![1]).toEqual([TENANT]);
  });
});
