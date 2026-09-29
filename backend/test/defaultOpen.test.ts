/**
 * defaultOpen.test.ts — default-open model serving (tenant default is
 * implicit, no grant row required).
 *
 * Covers ensureTenantDefaultModel (create-on-read idempotency, disabled
 * default not resurrected, duplicate-key race), listApprovedModelsForUser
 * (default included without a grant, explicit revocation excluded), and
 * getApprovedModelForUser (default fail-open, non-default fail-closed,
 * explicit revocation wins).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Errors } from '../src/errors.js';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});

// These suites pin the local-stack behavior (Ollama seeds, Qwen vision
// seed): the local stack is on here; flag-off behavior is covered in
// ollamaFlag.test.ts.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return { ...mod, config: { ...mod.config, OLLAMA_ENABLED: true } };
});

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));

import {
  DEFAULT_MODEL_NAME,
  ensureTenantDefaultModel,
  getApprovedModelForUser,
  isDefaultModelDoc,
  listApprovedModelsForUser,
} from '../src/ai/gateway/modelRegistry.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const ROLE = '44444444-4444-4444-8444-444444444444';

function servableDefaultDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'default-model-id',
    name: DEFAULT_MODEL_NAME,
    version: '1.0',
    provider: 'ollama',
    endpoint: 'http://ollama:11434',
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    license: 'llama3.1',
    source: 'meta',
    sha256: null,
    contextWindow: 131072,
    capabilities: { chat: true, streaming: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    lifecycleUpdatedAt: new Date(),
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: new Date(),
    enabled: true,
    ...overrides,
  };
}

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        sort: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      })),
      updateOne: vi.fn().mockResolvedValue({ modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ insertedId: 'x' }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

beforeEach(() => {
  for (const name of Object.keys(mockCollections)) delete mockCollections[name];
  const db = { collection: (name: string) => getMockCollection(name) };
  getDbMock.mockReset();
  tenantOpMock.mockReset();
  getDbMock.mockResolvedValue(db);
  tenantOpMock.mockImplementation(async (_tenantId: string, cb: (d: any) => Promise<any>) => cb(db));
});

function modelsCollection() {
  return getMockCollection('models');
}
function accessCollection() {
  return getMockCollection('model_access');
}

describe('ensureTenantDefaultModel', () => {
  it('seeds the default model when the registry is empty', async () => {
    const models = modelsCollection();
    const model = await ensureTenantDefaultModel();
    expect(models.insertOne).toHaveBeenCalledTimes(1);
    const seed = models.insertOne.mock.calls[0][0];
    expect(seed.name).toBe(DEFAULT_MODEL_NAME);
    expect(seed.provider).toBe('ollama');
    expect(seed.status).toBe('ACTIVE');
    expect(seed.enabled).toBe(true);
    expect(seed.isDefault).toBe(true);
    expect(model).not.toBeNull();
    expect(model!.name).toBe(DEFAULT_MODEL_NAME);
    expect(model!.id).toBe(seed._id);
  });

  it('returns the existing servable default without seeding', async () => {
    const doc = servableDefaultDoc();
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.isDefault === true || filter.name === DEFAULT_MODEL_NAME) return doc; // servable-default lookup
      return null;
    });
    const model = await ensureTenantDefaultModel();
    expect(modelsCollection().insertOne).not.toHaveBeenCalled();
    expect(model!.id).toBe('default-model-id');
  });

  it('self-heals the isDefault flag on the canonical seed doc', async () => {
    const doc = servableDefaultDoc({ isDefault: false });
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.isDefault === true || filter.name === DEFAULT_MODEL_NAME) return doc;
      return null;
    });
    await ensureTenantDefaultModel();
    // The fixture carries the pre-fix docker endpoint while config points at
    // localhost: the self-heal refreshes it to the configured OLLAMA_BASE_URL.
    expect(modelsCollection().updateOne).toHaveBeenCalledWith(
      { _id: 'default-model-id' },
      { $set: { isDefault: true, endpoint: 'http://localhost:11434' } }
    );
  });

  it('prefers an operator-flagged default over the canonical seed name', async () => {
    const custom = servableDefaultDoc({
      _id: 'custom-default-id',
      name: 'operator/custom-model',
      isDefault: true,
    });
    const seed = servableDefaultDoc({ isDefault: false });
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.isDefault === true) return custom;
      if (filter.name === DEFAULT_MODEL_NAME && filter.status) return seed;
      return null;
    });
    const model = await ensureTenantDefaultModel();
    expect(model!.id).toBe('custom-default-id');
    // The operator-flagged doc keeps its identity, but its stale docker
    // endpoint is refreshed to the configured OLLAMA_BASE_URL so chat can
    // actually reach Ollama on a native deployment.
    expect(modelsCollection().updateOne).toHaveBeenCalledWith(
      { _id: 'custom-default-id' },
      { $set: { endpoint: 'http://localhost:11434' } }
    );
    expect(model!.endpoint).toBe('http://localhost:11434');
  });

  it('does NOT resurrect a default that an admin disabled', async () => {
    const doc = servableDefaultDoc({ enabled: false });
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.status) return null; // servable legs: the doc exists but is disabled
      return doc; // plain name lookup: the doc exists, just disabled
    });
    const model = await ensureTenantDefaultModel();
    expect(model).toBeNull();
    expect(modelsCollection().insertOne).not.toHaveBeenCalled();
  });

  it('recovers from a duplicate-key race by re-reading', async () => {
    const raced = servableDefaultDoc();
    let servableCalls = 0;
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      // Only the servable legs (flagged, then canonical name) participate;
      // the plain name lookup must stay empty so the insert is attempted.
      if (filter.status) {
        servableCalls += 1;
        // first read (2 legs): nothing; re-read after the race: the doc
        return servableCalls > 2 ? raced : null;
      }
      return null;
    });
    const err = new Error('dup') as any;
    err.code = 11000;
    modelsCollection().insertOne.mockRejectedValueOnce(err);
    const model = await ensureTenantDefaultModel();
    expect(model!.id).toBe('default-model-id');
  });

  it('re-throws non-duplicate insert errors', async () => {
    modelsCollection().insertOne.mockRejectedValueOnce(new Error('boom'));
    await expect(ensureTenantDefaultModel()).rejects.toThrow('boom');
  });
});

describe('listApprovedModelsForUser (default-open)', () => {
  it('includes the default model with no grant rows at all', async () => {
    const doc = servableDefaultDoc({ isDefault: true });
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.isDefault === true || filter.name === DEFAULT_MODEL_NAME) return doc;
      return null;
    });
    const find = accessCollection().find;
    find.mockImplementationOnce(() => ({
      toArray: vi.fn().mockResolvedValue([]), // no grants
      sort: vi.fn(),
    }));
    modelsCollection().find.mockImplementationOnce(() => ({
      sort: () => ({ toArray: vi.fn().mockResolvedValue([doc]) }),
    }));
    const models = await listApprovedModelsForUser(TENANT, USER, ROLE);
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe(DEFAULT_MODEL_NAME);
  });

  it('excludes the default model when explicitly revoked for the user', async () => {
    const doc = servableDefaultDoc({ isDefault: true });
    modelsCollection().findOne.mockImplementation(async (filter: any) => {
      if (filter.isDefault === true || filter.name === DEFAULT_MODEL_NAME) return doc;
      // revocation lookup: an explicit denial exists
      if (filter.revoked === true) return { _id: 'rev-1' };
      return null;
    });
    accessCollection().find.mockImplementationOnce(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn(),
    }));
    const models = await listApprovedModelsForUser(TENANT, USER, ROLE);
    expect(models).toHaveLength(0);
  });

  it('seeds the default model on read when the registry is empty (fresh tenant)', async () => {
    // Regression: /models must never come back empty just because no model
    // doc exists yet — the default is ensured on read, not only at chat time.
    const models = modelsCollection();
    let seeded: Record<string, any> | null = null;
    models.insertOne.mockImplementation(async (doc: any) => {
      seeded = doc;
      return { insertedId: doc._id };
    });
    models.findOne.mockImplementation(async (filter: any) => {
      // Servable legs see the seeded doc once it exists; before that the
      // registry is empty. The plain name lookup (no status leg) stays empty
      // so the seed insert is actually attempted.
      if (filter.status && seeded) return seeded;
      if (filter.isDefault === true && seeded) return seeded;
      return null;
    });
    accessCollection().find.mockImplementationOnce(() => ({
      toArray: vi.fn().mockResolvedValue([]), // no grants
      sort: vi.fn(),
    }));
    models.find.mockImplementationOnce(() => ({
      sort: () => ({ toArray: vi.fn().mockResolvedValue(seeded ? [seeded] : []) }),
    }));
    const result = await listApprovedModelsForUser(TENANT, USER, ROLE);
    expect(models.insertOne).toHaveBeenCalledTimes(1);
    expect(seeded!.name).toBe(DEFAULT_MODEL_NAME);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe(DEFAULT_MODEL_NAME);
  });
});

describe('getApprovedModelForUser (default-open)', () => {
  it('allows the default model with no grant row', async () => {
    const doc = servableDefaultDoc({ isDefault: true });
    modelsCollection().findOne.mockResolvedValue(doc);
    accessCollection().findOne.mockResolvedValue(null);
    const model = await getApprovedModelForUser('default-model-id', TENANT, USER, ROLE);
    expect(model.name).toBe(DEFAULT_MODEL_NAME);
  });

  it('allows the default model identified by canonical name (migration 029 not yet run)', async () => {
    const doc = servableDefaultDoc(); // no isDefault flag
    modelsCollection().findOne.mockResolvedValue(doc);
    accessCollection().findOne.mockResolvedValue(null);
    const model = await getApprovedModelForUser('default-model-id', TENANT, USER, ROLE);
    expect(model.name).toBe(DEFAULT_MODEL_NAME);
  });

  it('honors an explicit revocation of the default model', async () => {
    const doc = servableDefaultDoc({ isDefault: true });
    modelsCollection().findOne.mockResolvedValue(doc);
    accessCollection().findOne.mockResolvedValue({ _id: 'rev-1', revoked: true });
    await expect(getApprovedModelForUser('default-model-id', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });

  it('stays fail-closed for non-default models without a grant', async () => {
    const doc = servableDefaultDoc({
      _id: 'other-model-id',
      name: 'some/other-model',
      isDefault: false,
    });
    modelsCollection().findOne.mockResolvedValue(doc);
    accessCollection().findOne.mockResolvedValue(null);
    await expect(getApprovedModelForUser('other-model-id', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });

  it('allows a non-default model with an explicit grant', async () => {
    const doc = servableDefaultDoc({
      _id: 'other-model-id',
      name: 'some/other-model',
      isDefault: false,
    });
    modelsCollection().findOne.mockResolvedValue(doc);
    accessCollection().findOne.mockResolvedValue({ _id: 'grant-1' });
    const model = await getApprovedModelForUser('other-model-id', TENANT, USER, ROLE);
    expect(model.name).toBe('some/other-model');
  });

  it('refuses a disabled default model', async () => {
    const doc = servableDefaultDoc({ isDefault: true, enabled: false });
    modelsCollection().findOne.mockResolvedValue(doc);
    await expect(getApprovedModelForUser('default-model-id', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });
});

describe('isDefaultModelDoc', () => {
  it('treats the isDefault flag or canonical name as the default', () => {
    expect(isDefaultModelDoc({ name: 'anything', isDefault: true })).toBe(true);
    expect(isDefaultModelDoc({ name: DEFAULT_MODEL_NAME })).toBe(true);
    expect(isDefaultModelDoc({ name: 'other' })).toBe(false);
  });
});
