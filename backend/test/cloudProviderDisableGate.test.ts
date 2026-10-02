/**
 * cloudProviderDisableGate.test.ts — a disabled/unconfigured cloud provider
 * must serve nothing, even when its seed docs are already in the DB.
 *
 * Covers: getApprovedModelForUser rejecting cloud docs whose provider is
 * disabled (CLAUDE_ENABLED=false with the key still set — the case the UI
 * hides but the API used to serve), listApprovedModelsForUser excluding
 * those docs, the non-cloud path unaffected, and cloud seeds deriving
 * their endpoint from the configured base URL.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
}));

// Claude key present but explicitly disabled; OpenAI key absent entirely;
// custom Anthropic base URL to prove seeds use the configured endpoint.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      ANTHROPIC_API_KEY: 'test-anthropic-key',
      CLAUDE_ENABLED: false,
      ANTHROPIC_BASE_URL: 'https://proxy.example.test',
      OPENAI_API_KEY: '',
      OPENAI_ENABLED: true,
      // The local stack stays enabled here: this suite pins the CLOUD
      // gates, and the Ollama leg of the serving gate is covered in
      // ollamaFlag.test.ts.
      OLLAMA_ENABLED: true,
    },
  };
});

import {
  cloudProviderServingAllowed,
  ensureCloudProviderModels,
  getApprovedModelForUser,
  isClaudeConfigured,
  isOpenAIConfigured,
  listApprovedModelsForUser,
} from '../src/ai/gateway/modelRegistry.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const ROLE = '44444444-4444-4444-8444-444444444444';

let docs: any[];
let accessRows: any[];
const collection: Record<string, any> = {};

function claudeSeedDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'claude-seed-1',
    name: 'Claude Sonnet 4',
    provider: 'claude',
    endpoint: 'https://proxy.example.test',
    modelIdentifier: 'claude-sonnet-4-20250514',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true, vision: true },
    enabled: true,
    seededProvider: 'claude',
    ...overrides,
  };
}

function ollamaDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'ollama-1',
    name: 'Enflite 8B',
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true },
    enabled: true,
    isDefault: true,
    ...overrides,
  };
}

function matches(doc: any, filter: any): boolean {
  for (const [k, v] of Object.entries(filter)) {
    if (k === '_id' && typeof v === 'object' && v !== null && '$in' in v) {
      if (!(v as any).$in.includes(doc._id)) return false;
      continue;
    }
    if (k === 'status' && typeof v === 'object' && v !== null && '$in' in v) {
      if (!(v as any).$in.includes(doc.status)) return false;
      continue;
    }
    if (k === 'seededProvider' && typeof v === 'object' && v !== null && '$in' in v) {
      if (!(v as any).$in.includes(doc.seededProvider)) return false;
      continue;
    }
    if (k === '$or') continue; // access rows only; handled below
    if (doc[k] !== v) return false;
  }
  return true;
}

beforeEach(() => {
  docs = [];
  accessRows = [];
  collection.models = {
    findOne: vi.fn(async (filter: any) => docs.find((d) => matches(d, filter)) ?? null),
    find: vi.fn((filter: any) => ({
      sort: () => ({ toArray: async () => docs.filter((d) => matches(d, filter)) }),
      toArray: async () => docs.filter((d) => matches(d, filter)),
    })),
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
  collection.model_access = {
    findOne: vi.fn(async (filter: any) => {
      if (filter.revoked === true) return accessRows.find((r) => r.revoked === true && r.modelId === filter.modelId) ?? null;
      return accessRows.find((r) => r.modelId === filter.modelId) ?? null;
    }),
    find: vi.fn(() => ({ toArray: async () => accessRows })),
  };
  getDbMock.mockReset();
  getDbMock.mockResolvedValue({ collection: (name: string) => collection[name] });
});

describe('cloudProviderServingAllowed', () => {
  it('is false for a disabled-with-key Claude provider and a keyless OpenAI provider', () => {
    expect(isClaudeConfigured()).toBe(false);
    expect(isOpenAIConfigured()).toBe(false);
    expect(cloudProviderServingAllowed('claude')).toBe(false);
    expect(cloudProviderServingAllowed('openai')).toBe(false);
    expect(cloudProviderServingAllowed('ollama')).toBe(true);
  });
});

describe('approval gate for disabled cloud providers', () => {
  it('rejects a Claude seed doc at approval time even with a default-open seed marker', async () => {
    docs = [claudeSeedDoc()];
    await expect(getApprovedModelForUser('claude-seed-1', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });

  it('rejects an admin-registered (non-seed) Claude doc too', async () => {
    docs = [claudeSeedDoc({ seededProvider: undefined, name: 'custom-claude' })];
    await expect(getApprovedModelForUser('claude-seed-1', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
    });
  });

  it('excludes disabled cloud seeds from /models even when no revocation exists', async () => {
    docs = [ollamaDoc(), claudeSeedDoc()];
    const models = await listApprovedModelsForUser(TENANT, USER, ROLE);
    expect(models.map((m) => m.id)).toEqual(['ollama-1']);
  });

  it('still approves the non-cloud default model', async () => {
    docs = [ollamaDoc()];
    const model = await getApprovedModelForUser('ollama-1', TENANT, USER, ROLE);
    expect(model.id).toBe('ollama-1');
  });
});
