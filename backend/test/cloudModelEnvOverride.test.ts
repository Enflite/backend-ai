/**
 * cloudModelEnvOverride.test.ts — ANTHROPIC_MODEL / OPENAI_MODEL are the
 * source of truth for the provider-default chat seed's model ID.
 *
 * 1. The provider-default seed uses the env value as its modelIdentifier.
 * 2. A changed env value updates the stored seed in place on restart
 *    (identifier + name) instead of being silently ignored.
 * 3. An override never wears the wrong curated label (an Opus override is
 *    not called "Sonnet 4").
 *
 * VALIDATED IN CI with mocks; no live infrastructure.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
let anthropicModel = 'claude-sonnet-4-20250514';

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
}));

// Claude configured; the model ID is mutable per-test via anthropicModel.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    get config() {
      return {
        ...mod.config,
ANTHROPIC_API_KEY: 'test-key',
        CLAUDE_ENABLED: true,
        ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
        ANTHROPIC_MODEL: anthropicModel,
      };
    },
  };
});

import {
  ensureCloudProviderModels,
  providerDefaultModelIdentifier,
  providerDefaultSeedName,
} from '../src/ai/gateway/modelRegistry.js';

let docs: any[];
let updateOneMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  docs = [];
  anthropicModel = 'claude-sonnet-4-20250514';
  updateOneMock = vi.fn(async (filter: any, update: any) => {
    const doc = docs.find((d) => d._id === filter._id);
    if (doc) Object.assign(doc, update.$set);
    return { modifiedCount: doc ? 1 : 0 };
  });
  const collection = {
    findOne: vi.fn(async (query: any) => {
      // The provider-default lookup (seededProvider + isProviderDefault)…
      if (query?.seededProvider) {
        return docs.find((d) => d.provider === query.provider && d.isProviderDefault === true) ?? null;
      }
      // …the generic "anything servable" lookup.
      return docs.find((d) => d.provider === query.provider) ?? null;
    }),
    insertOne: vi.fn(async (doc: any) => {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    }),
    updateOne: updateOneMock,
  };
  getDbMock.mockReset();
  getDbMock.mockResolvedValue({ collection: () => collection });
});

describe('providerDefaultModelIdentifier / providerDefaultSeedName', () => {
  it('reads the env model ID', () => {
    anthropicModel = 'claude-opus-4-20250514';
    expect(providerDefaultModelIdentifier('claude')).toBe('claude-opus-4-20250514');
  });

  it('keeps the curated name when the env matches a known seed', () => {
    expect(providerDefaultSeedName('claude', 'claude-sonnet-4-20250514')).toBe('Claude Sonnet 4');
    expect(providerDefaultSeedName('openai', 'gpt-4o')).toBe('GPT-4o');
  });

  it('derives a sane name for an override — never the wrong curated label', () => {
    expect(providerDefaultSeedName('claude', 'claude-opus-4-20250514')).toBe('Claude Opus 4');
    expect(providerDefaultSeedName('openai', 'gpt-4.1')).toBe('GPT 4.1');
  });
});

describe('ensureCloudProviderModels honors ANTHROPIC_MODEL', () => {
  it('seeds the provider-default doc with the env model ID', async () => {
    anthropicModel = 'claude-opus-4-20250514';
    await ensureCloudProviderModels();
    const def = docs.find((d) => d.provider === 'claude' && d.isProviderDefault);
    expect(def).toBeDefined();
    expect(def.modelIdentifier).toBe('claude-opus-4-20250514');
    expect(def.name).toBe('Claude Opus 4');
  });

  it('updates the stored seed in place when the env changes on restart', async () => {
    // First boot with the default model.
    await ensureCloudProviderModels();
    const def = docs.find((d) => d.provider === 'claude' && d.isProviderDefault);
    expect(def.modelIdentifier).toBe('claude-sonnet-4-20250514');

    // Operator changes .env and restarts: the stored doc is updated in
    // place, not duplicated and not ignored.
    anthropicModel = 'claude-opus-4-20250514';
    await ensureCloudProviderModels();
    expect(updateOneMock).toHaveBeenCalledTimes(1);
    expect(def.modelIdentifier).toBe('claude-opus-4-20250514');
    expect(def.name).toBe('Claude Opus 4');
    expect(docs.filter((d) => d.provider === 'claude' && d.isProviderDefault)).toHaveLength(1);
  });

  it('leaves the stored seed alone when the env matches', async () => {
    await ensureCloudProviderModels();
    await ensureCloudProviderModels();
    expect(updateOneMock).not.toHaveBeenCalled();
  });
});
