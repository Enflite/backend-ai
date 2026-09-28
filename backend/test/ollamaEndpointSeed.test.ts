/**
 * ollamaEndpointSeed.test.ts — regression test for the hardcoded docker
 * Ollama endpoint.
 *
 * `defaultModelSeed` / `visionModelSeed` used to hardcode
 * `endpoint: 'http://ollama:11434'`, and the chat path serves from the model
 * doc's endpoint — so a native (non-docker) deployment could never reach
 * Ollama through chat no matter what OLLAMA_BASE_URL was set to, with no
 * admin API to fix it. Now seeds derive the endpoint from config, and the
 * ensure-on-read path refreshes a stale docker endpoint.
 *
 * Uses the real config (OLLAMA_BASE_URL defaults to
 * http://localhost:11434 in test) — no mocks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));

import {
  DEFAULT_MODEL_NAME,
  VISION_MODEL_NAME,
  ensureTenantDefaultModel,
  ensureVisionModel,
  isStaleOllamaEndpoint,
} from '../src/ai/gateway/modelRegistry.js';

const NATIVE_URL = 'http://localhost:11434';
const STALE_URL = 'http://ollama:11434';

let docs: any[];
let collection: any;
function getMockCollection() {
  return {
    findOne: vi.fn(async (filter: any) => {
      if (filter?.isDefault === true) return docs.find((d) => d.isDefault === true) ?? null;
      if (filter?.isVisionDefault === true) return docs.find((d) => d.isVisionDefault === true) ?? null;
      if (filter?.name) return docs.find((d) => d.name === filter.name) ?? null;
      return docs[0] ?? null;
    }),
    find: vi.fn(() => ({ sort: () => ({ toArray: async () => [...docs] }) })),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = docs.find((d) => d._id === filter._id);
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    }),
    insertOne: vi.fn(async (doc: any) => {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    }),
  };
}

function seedDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'doc-1',
    name: DEFAULT_MODEL_NAME,
    provider: 'ollama',
    endpoint: STALE_URL,
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true },
    enabled: true,
    isDefault: true,
    ...overrides,
  };
}

function visionDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'vision-1',
    name: VISION_MODEL_NAME,
    provider: 'ollama',
    endpoint: STALE_URL,
    modelIdentifier: 'qwen2.5vl:7b',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true, vision: true },
    enabled: true,
    isVisionDefault: true,
    ...overrides,
  };
}

beforeEach(() => {
  docs = [];
  collection = getMockCollection();
  getDbMock.mockReset();
  tenantOpMock.mockReset();
  getDbMock.mockResolvedValue({ collection: () => collection });
  tenantOpMock.mockImplementation(async (_tenantId: string, cb: (d: any) => Promise<any>) => cb(await getDbMock()));
});

describe('isStaleOllamaEndpoint', () => {
  it('flags the docker URL when config points elsewhere', () => {
    expect(isStaleOllamaEndpoint(STALE_URL)).toBe(true);
    expect(isStaleOllamaEndpoint(STALE_URL + '/')).toBe(true);
  });

  it('never flags admin-customized endpoints', () => {
    expect(isStaleOllamaEndpoint('http://gpu-box:11434')).toBe(false);
    expect(isStaleOllamaEndpoint(NATIVE_URL)).toBe(false);
    expect(isStaleOllamaEndpoint(null)).toBe(false);
    expect(isStaleOllamaEndpoint(undefined)).toBe(false);
  });
});

describe('seed endpoints come from config', () => {
  it('seeds the default model with the configured OLLAMA_BASE_URL', async () => {
    const model = await ensureTenantDefaultModel();
    expect(model).not.toBeNull();
    expect(model!.endpoint).toBe(NATIVE_URL);
    expect(docs).toHaveLength(1);
    expect(docs[0].endpoint).toBe(NATIVE_URL);
    expect(docs[0].endpoint).not.toBe(STALE_URL);
  });

  it('seeds the vision model with the configured OLLAMA_BASE_URL', async () => {
    const model = await ensureVisionModel();
    expect(model).not.toBeNull();
    expect(model!.endpoint).toBe(NATIVE_URL);
  });
});

describe('stale endpoint refresh on read', () => {
  it('refreshes a stale docker endpoint on the default model', async () => {
    docs = [seedDoc()];

    const model = await ensureTenantDefaultModel();
    expect(model!.endpoint).toBe(NATIVE_URL);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'doc-1' },
      { $set: { endpoint: NATIVE_URL } },
    );
    expect(docs[0].endpoint).toBe(NATIVE_URL);
  });

  it('refreshes a stale docker endpoint on the vision model', async () => {
    docs = [visionDoc()];

    const model = await ensureVisionModel();
    expect(model!.endpoint).toBe(NATIVE_URL);
    expect(collection.updateOne).toHaveBeenCalledWith(
      { _id: 'vision-1' },
      { $set: { endpoint: NATIVE_URL } },
    );
  });

  it('leaves an admin-customized endpoint alone', async () => {
    docs = [seedDoc({ endpoint: 'http://gpu-box:11434' })];

    const model = await ensureTenantDefaultModel();
    expect(model!.endpoint).toBe('http://gpu-box:11434');
    expect(collection.updateOne).not.toHaveBeenCalled();
  });

  it('does not write when the endpoint already matches config', async () => {
    docs = [seedDoc({ endpoint: NATIVE_URL })];

    const model = await ensureTenantDefaultModel();
    expect(model!.endpoint).toBe(NATIVE_URL);
    expect(collection.updateOne).not.toHaveBeenCalled();
  });
});
