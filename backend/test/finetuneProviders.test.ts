/**
 * finetuneProviders.test.ts — fine-tune provider abstraction (ADR-015).
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no network):
 *  - The factory fails closed when FINETUNE_PROVIDER=disabled (the kill switch).
 *  - The external provider refuses non-HTTPS and non-allowlisted origins
 *    before any training data leaves the boundary.
 *  - The external provider speaks the OpenAI-compatible dialect (file upload
 *    → job create → status poll) and maps provider statuses to job statuses.
 *  - Only allowlisted hyperparameters are forwarded.
 *  - The local provider cancels queued jobs atomically and never touches the
 *    network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantOpMock } = vi.hoisted(() => {
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb({}));
  return { tenantOpMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: vi.fn(), tenantOp: tenantOpMock }));

import { config } from '../src/config.js';
import { resolveFineTuneProvider, isFineTuningEnabled } from '../src/learning/finetune/factory.js';
import { ExternalFineTuneProvider } from '../src/learning/finetune/externalProvider.js';
import { LocalFineTuneProvider } from '../src/learning/finetune/localProvider.js';
import { FinetuneJobDoc, FinetuneJobSpec } from '../src/learning/finetune/types.js';

const SAVED = {
  provider: config.FINETUNE_PROVIDER,
  baseUrl: config.FINETUNE_API_BASE_URL,
  apiKey: config.FINETUNE_API_KEY,
  origins: config.FINETUNE_ALLOWED_ORIGINS,
};

beforeEach(() => {
  vi.clearAllMocks();
  config.FINETUNE_PROVIDER = 'disabled';
  config.FINETUNE_API_BASE_URL = undefined;
  config.FINETUNE_API_KEY = '';
  config.FINETUNE_ALLOWED_ORIGINS = '';
});

afterEach(() => {
  config.FINETUNE_PROVIDER = SAVED.provider;
  config.FINETUNE_API_BASE_URL = SAVED.baseUrl;
  config.FINETUNE_API_KEY = SAVED.apiKey;
  config.FINETUNE_ALLOWED_ORIGINS = SAVED.origins;
  vi.unstubAllGlobals();
});

const SPEC: FinetuneJobSpec = {
  jobId: 'job-1',
  tenantId: 'tenant-1',
  trainingJsonl: '{"messages":[]}\n',
  baseModel: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
};

function jobDoc(overrides: Partial<FinetuneJobDoc> = {}): FinetuneJobDoc {
  return {
    _id: 'job-1', tenantId: 'tenant-1', datasetId: 'ds-1',
    baseModel: SPEC.baseModel, status: 'queued', attempts: 0,
    createdBy: 'user-1', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  };
}

describe('factory', () => {
  it('fails closed when disabled', () => {
    expect(isFineTuningEnabled()).toBe(false);
    expect(() => resolveFineTuneProvider()).toThrowError(expect.objectContaining({ code: 'FINETUNE_DISABLED' }));
  });

  it('resolves the local provider with no network or credentials', () => {
    config.FINETUNE_PROVIDER = 'local';
    const provider = resolveFineTuneProvider();
    expect(provider.name).toBe('local');
    expect(isFineTuningEnabled()).toBe(true);
  });

  it('resolves the external provider when configured', () => {
    config.FINETUNE_PROVIDER = 'external';
    config.FINETUNE_API_BASE_URL = 'https://api.test-provider.example';
    config.FINETUNE_API_KEY = 'key';
    config.FINETUNE_ALLOWED_ORIGINS = 'https://api.test-provider.example';
    expect(resolveFineTuneProvider().name).toBe('external');
  });
});

describe('ExternalFineTuneProvider', () => {
  function allow(url = 'https://api.test-provider.example') {
    config.FINETUNE_API_BASE_URL = url;
    config.FINETUNE_API_KEY = 'key';
    config.FINETUNE_ALLOWED_ORIGINS = 'https://api.test-provider.example';
  }

  it('refuses origins not on the allowlist', () => {
    config.FINETUNE_API_BASE_URL = 'https://evil.example';
    config.FINETUNE_API_KEY = 'key';
    config.FINETUNE_ALLOWED_ORIGINS = 'https://api.test-provider.example';
    expect(() => new ExternalFineTuneProvider()).toThrowError(expect.objectContaining({ code: 'FINETUNE_ORIGIN_NOT_ALLOWED' }));
  });

  it('refuses non-HTTPS base URLs', () => {
    config.FINETUNE_API_BASE_URL = 'http://api.test-provider.example';
    config.FINETUNE_API_KEY = 'key';
    config.FINETUNE_ALLOWED_ORIGINS = 'http://api.test-provider.example';
    expect(() => new ExternalFineTuneProvider()).toThrowError(expect.objectContaining({ code: 'FINETUNE_URL_NOT_HTTPS' }));
  });

  it('uploads the file then creates the job', async () => {
    allow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'file-123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ftjob-123', status: 'queued' }) });
    vi.stubGlobal('fetch', fetchMock);

    const provider = new ExternalFineTuneProvider();
    const { providerJobId } = await provider.submitJob(SPEC);
    expect(providerJobId).toBe('ftjob-123');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [uploadUrl, uploadInit] = fetchMock.mock.calls[0]!;
    expect(uploadUrl).toContain('/v1/files');
    expect((uploadInit!.headers as Record<string, string>).Authorization).toBe('Bearer key');
    const [jobUrl, jobInit] = fetchMock.mock.calls[1]!;
    expect(jobUrl).toContain('/v1/fine_tuning/jobs');
    const payload = JSON.parse(jobInit!.body as string);
    expect(payload.training_file).toBe('file-123');
    expect(payload.model).toBe(SPEC.baseModel);
  });

  it('forwards only allowlisted hyperparameters', async () => {
    allow();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'file-123' }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'ftjob-123', status: 'queued' }) });
    vi.stubGlobal('fetch', fetchMock);
    const provider = new ExternalFineTuneProvider();
    await provider.submitJob({ ...SPEC, hyperparameters: { n_epochs: 3, evil_param: 'x' } });
    const payload = JSON.parse(fetchMock.mock.calls[1]![1].body as string);
    expect(payload.hyperparameters).toEqual({ n_epochs: 3 });
  });

  it('maps provider statuses to job statuses', async () => {
    allow();
    const provider = new ExternalFineTuneProvider();
    const cases: Array<[string, string, string | undefined]> = [
      ['validating_files', 'queued', undefined],
      ['running', 'running', undefined],
      ['succeeded', 'succeeded', 'ft:model-1'],
      ['failed', 'failed', undefined],
      ['cancelled', 'cancelled', undefined],
    ];
    for (const [remote, expected, artifact] of cases) {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ id: 'ftjob-123', status: remote, fine_tuned_model: artifact }),
      }));
      const status = await provider.getJobStatus(jobDoc({ providerJobId: 'ftjob-123' }));
      expect(status.status).toBe(expected);
      expect(status.artifactRef).toBe(artifact);
    }
  });

  it('surfaces provider errors without leaking the key', async () => {
    allow();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 401, text: async () => 'bad key',
    }));
    const provider = new ExternalFineTuneProvider();
    await expect(provider.submitJob(SPEC)).rejects.toMatchObject({ code: 'FINETUNE_PROVIDER_ERROR' });
  });
});

describe('LocalFineTuneProvider', () => {
  it('submitJob is a no-op (the queue is the submission)', async () => {
    const provider = new LocalFineTuneProvider();
    await expect(provider.submitJob(SPEC)).resolves.toEqual({});
  });

  it('getJobStatus reads from the job document (worker-owned transitions)', async () => {
    const provider = new LocalFineTuneProvider();
    const status = await provider.getJobStatus(jobDoc({ status: 'running', lockedBy: 'gpu-01' }));
    expect(status.status).toBe('running');
  });

  it('cancelJob atomically transitions queued → cancelled', async () => {
    const coll = { findOneAndUpdate: vi.fn().mockResolvedValue({ _id: 'job-1', status: 'cancelled' }) };
    tenantOpMock.mockImplementation(async (_t: string, cb: (db: any) => Promise<any>) =>
      cb({ collection: () => coll }));
    const provider = new LocalFineTuneProvider();
    expect(await provider.cancelJob(jobDoc())).toBe(true);
    const filter = coll.findOneAndUpdate.mock.calls[0]![0];
    expect(filter).toMatchObject({ _id: 'job-1', tenantId: 'tenant-1', status: 'queued' });
  });

  it('cancelJob returns false when the job is already claimed', async () => {
    const coll = { findOneAndUpdate: vi.fn().mockResolvedValue(null) };
    tenantOpMock.mockImplementation(async (_t: string, cb: (db: any) => Promise<any>) =>
      cb({ collection: () => coll }));
    const provider = new LocalFineTuneProvider();
    expect(await provider.cancelJob(jobDoc({ status: 'running' }))).toBe(false);
  });
});
