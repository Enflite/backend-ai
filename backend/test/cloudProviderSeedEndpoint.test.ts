/**
 * cloudProviderSeedEndpoint.test.ts — cloud seeds persist the configured
 * base URL (CodeRabbit review follow-up).
 *
 * `CLOUD_SEEDS` used to hardcode the public API endpoints while the
 * provider factory prefers `model.endpoint` over the configured
 * `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` — so an operator pointing the
 * base URL at a proxy got seeds that silently ignored their own config.
 * Seeds now derive the endpoint from config.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
}));

// Claude configured, pointing at a proxy.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      ANTHROPIC_API_KEY: 'test-key',
      CLAUDE_ENABLED: true,
      ANTHROPIC_BASE_URL: 'https://proxy.example.test',
    },
  };
});

import { ensureCloudProviderModels } from '../src/ai/gateway/modelRegistry.js';

let docs: any[];
beforeEach(() => {
  docs = [];
  const collection = {
    findOne: vi.fn(async () => null), // no existing models -> seed
    insertOne: vi.fn(async (doc: any) => {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    }),
  };
  getDbMock.mockReset();
  getDbMock.mockResolvedValue({ collection: () => collection });
});

describe('cloud seed endpoints follow config', () => {
  it('persists the configured ANTHROPIC_BASE_URL on the seed, not a hardcoded value', async () => {
    await ensureCloudProviderModels();
    const seeds = docs.filter((d) => d.provider === 'claude');
    expect(seeds.length).toBeGreaterThan(0);
    for (const seed of seeds) {
      expect(seed.endpoint).toBe('https://proxy.example.test');
    }
  });
});
