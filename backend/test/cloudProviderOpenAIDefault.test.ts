/**
 * cloudProviderOpenAIDefault.test.ts — the OpenAI provider default is GPT-4o
 * (flagship, vision-capable), auto-selected when the user taps OpenAI.
 *
 * Same mock topology as cloudProviderServing.test.ts but with the OpenAI
 * key configured instead of the Anthropic key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
  withTenantTx: vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock())),
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      ANTHROPIC_API_KEY: '',
      CLAUDE_ENABLED: true,
      OPENAI_API_KEY: 'sk-openai-test-key-DO-NOT-LOG',
      OPENAI_ENABLED: true,
    },
  };
});

import { ensureCloudProviderModels, findServableVisionModelForGroup } from '../src/ai/gateway/modelRegistry.js';

let docs: any[] = [];
function getMockCollection() {
  return {
    findOne: vi.fn(async (filter: any) => {
      if (filter?.provider) return docs.find((d) => d.provider === filter.provider && d.enabled !== false) ?? null;
      return null;
    }),
    find: vi.fn((_filter: any) => ({
      sort: () => ({ toArray: async () => [...docs] }),
    })),
    insertOne: vi.fn(async (doc: any) => {
      docs.push(doc);
      return { insertedId: doc._id };
    }),
  };
}

beforeEach(() => {
  docs = [];
  getDbMock.mockReset();
  getDbMock.mockResolvedValue({ collection: () => getMockCollection() });
});

describe('OpenAI seeds', () => {
  it('seeds GPT-4o and GPT-4o Mini with GPT-4o as the provider default', async () => {
    await ensureCloudProviderModels();
    const seeds = docs.filter((d) => d.provider === 'openai');
    expect(seeds).toHaveLength(2);
    const defaults = seeds.filter((d) => d.isProviderDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].modelIdentifier).toBe('gpt-4o');
    expect(defaults[0].capabilities.vision).toBe(true);
  });

  it('resolves GPT-4o as the vision model for the openai group', async () => {
    await ensureCloudProviderModels();
    const vision = await findServableVisionModelForGroup('openai');
    expect(vision?.modelIdentifier).toBe('gpt-4o');
  });
});
