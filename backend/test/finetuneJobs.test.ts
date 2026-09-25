/**
 * finetuneJobs.test.ts — fine-tune job orchestration (ADR-015).
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - createJob fails closed when fine-tuning is disabled (kill switch).
 *  - createJob requires a ready dataset from the caller's tenant.
 *  - Provider submission failures mark the job failed (never stuck queued).
 *  - syncJob is idempotent on terminal jobs and registers succeeded
 *    artifacts as DRAFT models with enabled=false (never servable until
 *    eval-gated promotion).
 *  - requeueStaleJobs recovers worker-held jobs past the stale timeout.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantOpMock, isEnabledMock, resolveProviderMock, fakeProvider } = vi.hoisted(() => {
  const tenantOpMock = vi.fn();
  const isEnabledMock = vi.fn(() => true);
  const fakeProvider = {
    name: 'external',
    submitJob: vi.fn(async (_spec: any) => ({ providerJobId: 'ftjob-1' })),
    getJobStatus: vi.fn(
      async (): Promise<{ status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled'; artifactRef?: string; error?: string }> =>
        ({ status: 'queued' })
    ),
    cancelJob: vi.fn(async () => true),
  };
  const resolveProviderMock = vi.fn(() => fakeProvider);
  return { tenantOpMock, isEnabledMock, resolveProviderMock, fakeProvider };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: vi.fn(), tenantOp: tenantOpMock }));
vi.mock('../src/learning/finetune/factory.js', () => ({
  isFineTuningEnabled: isEnabledMock,
  resolveFineTuneProvider: resolveProviderMock,
}));

import { createJob, getJob, requeueStaleJobs, syncJob } from '../src/learning/finetune/jobs.js';
import { FinetuneJobDoc } from '../src/learning/finetune/types.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
const CTX = { tenantId: TENANT_A, userId: USER_A1, clearance: 'CONFIDENTIAL' as const };

const DATASET = {
  _id: 'ds-1', tenantId: TENANT_A, name: 'v1', status: 'ready',
  examples: [
    { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], sourceFeedbackId: 'f1', classification: 'INTERNAL' },
  ],
  exampleCount: 1, skippedCount: 0, createdBy: USER_A1, createdAt: new Date(),
};

const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
    };
  }
  return mockCollections[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  isEnabledMock.mockReturnValue(true);
  resolveProviderMock.mockReturnValue(fakeProvider);
  fakeProvider.submitJob.mockReset().mockResolvedValue({ providerJobId: 'ftjob-1' });
  fakeProvider.getJobStatus.mockReset().mockResolvedValue({ status: 'queued' });
  tenantOpMock.mockImplementation(async (_t: string, cb: (db: any) => Promise<any>) =>
    cb({ collection: (name: string) => getMockCollection(name) }));
  for (const coll of Object.values(mockCollections)) {
    coll.findOne.mockReset().mockResolvedValue(null);
    coll.findOneAndUpdate.mockReset().mockResolvedValue(null);
    coll.insertOne.mockReset().mockResolvedValue({ acknowledged: true });
    coll.updateOne.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 0 });
    coll.find.mockReset().mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    }));
  }
  getMockCollection('finetune_datasets').findOne.mockResolvedValue(DATASET);
});

function storedJob(overrides: Partial<FinetuneJobDoc> = {}): FinetuneJobDoc {
  return {
    _id: 'job-1', tenantId: TENANT_A, datasetId: 'ds-1',
    baseModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct', status: 'running',
    attempts: 1, createdBy: USER_A1, createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('createJob', () => {
  it('fails closed when fine-tuning is disabled', async () => {
    isEnabledMock.mockReturnValue(false);
    await expect(createJob(CTX, { datasetId: 'ds-1' })).rejects.toMatchObject({ code: 'FINETUNE_DISABLED' });
    expect(getMockCollection('finetune_jobs').insertOne).not.toHaveBeenCalled();
  });

  it('requires a ready dataset in the caller tenant', async () => {
    getMockCollection('finetune_datasets').findOne.mockResolvedValue(null);
    await expect(createJob(CTX, { datasetId: 'nope' })).rejects.toMatchObject({ code: 'DATASET_NOT_FOUND' });
  });

  it('creates a queued job and stores the provider job id', async () => {
    const job = await createJob(CTX, { datasetId: 'ds-1' });
    expect(job.status).toBe('queued');
    expect(job.providerJobId).toBe('ftjob-1');
    expect(job.tenantId).toBe(TENANT_A);
    const spec = fakeProvider.submitJob.mock.calls[0]![0];
    expect(spec.trainingJsonl).toContain('"messages"');
    expect(spec.tenantId).toBe(TENANT_A);
  });

  it('marks the job failed when provider submission throws', async () => {
    fakeProvider.submitJob.mockRejectedValue(new Error('boom'));
    const job = await createJob(CTX, { datasetId: 'ds-1' });
    expect(job.status).toBe('failed');
    expect(job.error).toContain('boom');
  });

  it('sanitizes hyperparameters', async () => {
    const job = await createJob(CTX, { datasetId: 'ds-1', hyperparameters: { n_epochs: 3 } });
    expect(job.hyperparameters).toEqual({ n_epochs: 3 });
  });
});

describe('syncJob', () => {
  it('returns terminal jobs without calling the provider', async () => {
    const terminal = storedJob({ status: 'failed', error: 'boom' });
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(terminal);
    const result = await syncJob(CTX, 'job-1');
    expect(result.status).toBe('failed');
    expect(fakeProvider.getJobStatus).not.toHaveBeenCalled();
  });

  it('registers the draft model for worker-reported successes (local path)', async () => {
    // The worker set succeeded+artifactRef directly; syncJob must still
    // register the DRAFT model exactly once.
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(
      storedJob({ status: 'succeeded', artifactRef: 'ft:model-1' })
    );
    getMockCollection('models').findOne.mockResolvedValue(null);
    const result = await syncJob(CTX, 'job-1');
    expect(result.status).toBe('succeeded');
    const modelDoc = getMockCollection('models').insertOne.mock.calls[0]![0];
    expect(modelDoc.status).toBe('DRAFT');
    expect(modelDoc.enabled).toBe(false);
  });

  it('does not duplicate the draft model on re-sync', async () => {
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(
      storedJob({ status: 'succeeded', artifactRef: 'ft:model-1' })
    );
    getMockCollection('models').findOne.mockResolvedValue({ _id: 'model-1' });
    await syncJob(CTX, 'job-1');
    expect(getMockCollection('models').insertOne).not.toHaveBeenCalled();
  });

  it('persists provider status changes', async () => {
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(storedJob());
    fakeProvider.getJobStatus.mockResolvedValue({ status: 'running' });
    getMockCollection('finetune_jobs').findOneAndUpdate.mockResolvedValue(storedJob({ status: 'running' }));
    const result = await syncJob(CTX, 'job-1');
    expect(result.status).toBe('running');
  });

  it('registers succeeded artifacts as DRAFT models that cannot serve', async () => {
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(storedJob());
    fakeProvider.getJobStatus.mockResolvedValue({ status: 'succeeded', artifactRef: 'ft:model-1' });
    getMockCollection('finetune_jobs').findOneAndUpdate.mockResolvedValue(
      storedJob({ status: 'succeeded', artifactRef: 'ft:model-1' })
    );
    const result = await syncJob(CTX, 'job-1');
    expect(result.status).toBe('succeeded');
    const modelDoc = getMockCollection('models').insertOne.mock.calls[0][0];
    expect(modelDoc.status).toBe('DRAFT');
    expect(modelDoc.enabled).toBe(false);
    expect(modelDoc.tenantId).toBe(TENANT_A);
    expect(modelDoc.modelIdentifier).toBe('ft:model-1');
  });

  it('throws for unknown jobs', async () => {
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(null);
    await expect(syncJob(CTX, 'nope')).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});

describe('getJob', () => {
  it('scopes reads to the caller tenant', async () => {
    getMockCollection('finetune_jobs').findOne.mockResolvedValue(storedJob());
    await getJob(CTX, 'job-1');
    expect(getMockCollection('finetune_jobs').findOne.mock.calls[0][0]).toMatchObject({
      _id: 'job-1', tenantId: TENANT_A,
    });
  });
});

describe('requeueStaleJobs', () => {
  it('resets stale running jobs to queued and bumps attempts', async () => {
    getMockCollection('finetune_jobs').updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 2 });
    const count = await requeueStaleJobs(TENANT_A);
    expect(count).toBe(2);
    const [filter, update] = getMockCollection('finetune_jobs').updateMany.mock.calls[0];
    expect(filter).toMatchObject({ tenantId: TENANT_A, status: 'running' });
    expect(filter.lockedAt.$lte).toBeInstanceOf(Date);
    expect(update.$set.status).toBe('queued');
    expect(update.$inc.attempts).toBe(1);
    expect(update.$unset).toMatchObject({ lockedAt: '', lockedBy: '' });
  });
});
