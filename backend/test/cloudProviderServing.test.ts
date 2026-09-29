/**
 * cloudProviderServing.test.ts — cloud provider seeds and the /providers
 * endpoint (ADR-018).
 *
 * Mock HTTP/mongo only. Covers: ensure-on-read seeding when a cloud key is
 * configured (and only then), GPT-4o as the OpenAI provider default,
 * per-group vision resolution, the /providers response shape (never carries
 * keys), and the Enflite fallback when a cloud group has no vision model.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, TEST_ANTHROPIC_KEY } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  TEST_ANTHROPIC_KEY: 'sk-ant-test-key-DO-NOT-LOG',
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
  withTenantTx: vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock())),
}));

// Config with only the Claude key set: Claude configured, OpenAI not.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      ANTHROPIC_API_KEY: TEST_ANTHROPIC_KEY,
      CLAUDE_ENABLED: true,
      OPENAI_API_KEY: '',
      OPENAI_ENABLED: true,
      // All three provider groups are listed here; the flag-off omission
      // is covered in ollamaFlag.test.ts.
      OLLAMA_ENABLED: true,
    },
  };
});

const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'user@example.test',
    displayName: 'User',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['model:use', 'chat:create'],
  },
}));

vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (permission: string) => async (req: any, _reply: any) => {
    if (!req.auth?.permissions?.includes(permission)) throw new Error(`missing ${permission}`);
  },
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit: vi.fn(), recordAuditInTx: vi.fn() }));

import {
  ensureCloudProviderModels,
  findServableVisionModelForGroup,
  isClaudeConfigured,
  isOpenAIConfigured,
} from '../src/ai/gateway/modelRegistry.js';
import { modelRoutes } from '../src/ai/gateway/routes.js';

// In-memory "models" collection with filter-aware reads.
let docs: any[] = [];
function getMockCollection() {
  return {
    findOne: vi.fn(async (filter: any) => {
      if (filter?.provider) {
        return docs.find((d) => d.provider === filter.provider && d.enabled !== false) ?? null;
      }
      if (filter?.seededProvider) {
        return docs.find((d) => filter.seededProvider.$in.includes(d.seededProvider)) ?? null;
      }
      return null;
    }),
    find: vi.fn((filter: any) => ({
      sort: () => ({
        toArray: async () => {
          if (filter?.seededProvider) {
            return docs.filter((d) => filter.seededProvider.$in.includes(d.seededProvider));
          }
          return [...docs];
        },
      }),
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

describe('cloud provider configuration', () => {
  it('reports Claude configured and OpenAI not when only the Anthropic key is set', () => {
    expect(isClaudeConfigured()).toBe(true);
    expect(isOpenAIConfigured()).toBe(false);
  });
});

describe('ensureCloudProviderModels', () => {
  it('seeds the Claude model when the key is configured', async () => {
    await ensureCloudProviderModels();
    const claude = docs.filter((d) => d.provider === 'claude');
    expect(claude).toHaveLength(1);
    expect(claude[0]).toMatchObject({
      modelIdentifier: 'claude-sonnet-4-20250514',
      isProviderDefault: true,
      seededProvider: 'claude',
    });
    // INTERNAL cap: prompts leave the operator's infrastructure.
    expect(claude[0].allowedClassifications).toEqual(['PUBLIC', 'INTERNAL']);
    expect(claude[0].capabilities.vision).toBe(true);
  });

  it('does not seed OpenAI without a key', async () => {
    await ensureCloudProviderModels();
    expect(docs.some((d) => d.provider === 'openai')).toBe(false);
  });

  it('is idempotent: a second call inserts nothing', async () => {
    await ensureCloudProviderModels();
    await ensureCloudProviderModels();
    expect(docs.filter((d) => d.provider === 'claude')).toHaveLength(1);
  });
});

describe('findServableVisionModelForGroup', () => {
  it('resolves the Claude vision seed for the claude group', async () => {
    await ensureCloudProviderModels();
    const vision = await findServableVisionModelForGroup('claude');
    expect(vision?.modelIdentifier).toBe('claude-sonnet-4-20250514');
  });

  it('returns null for an unconfigured group (caller falls back to Enflite)', async () => {
    const vision = await findServableVisionModelForGroup('openai');
    expect(vision).toBeNull();
  });
});

describe('GET /providers', () => {
  async function getProviders() {
    const app = Fastify();
    await app.register(modelRoutes);
    const response = await app.inject({ method: 'GET', url: '/providers' });
    await app.close();
    return response;
  }

  it('lists all three groups with residency notes and no key material', async () => {
    const response = await getProviders();
    expect(response.statusCode).toBe(200);
    const { providers } = response.json();
    expect(providers.map((p: any) => p.key)).toEqual(['enflite', 'claude', 'openai']);

    const enflite = providers.find((p: any) => p.key === 'enflite');
    expect(enflite).toMatchObject({ label: 'Enflite', configured: true, enabled: true });

    const claude = providers.find((p: any) => p.key === 'claude');
    expect(claude).toMatchObject({ label: 'Claude', configured: true, enabled: true });

    const openai = providers.find((p: any) => p.key === 'openai');
    expect(openai).toMatchObject({ label: 'OpenAI', configured: false, enabled: false });
    expect(typeof openai.hint).toBe('string');

    // Key redaction: the raw response must never contain the API key.
    expect(response.body).not.toContain(TEST_ANTHROPIC_KEY);
    for (const p of providers) {
      expect(JSON.stringify(p)).not.toContain('sk-ant');
    }
  });
});
