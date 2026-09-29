/**
 * ollamaFlag.test.ts — OLLAMA_ENABLED=false (Claude-only launch).
 *
 * Mocked boundary: Mongo (in-memory double), audit (recordAudit), and
 * config (flag off, Claude key set). No network, no Anthropic, no Ollama.
 *
 * Covers:
 * - serving gate: Ollama docs are never listed or served while the flag
 *   is off (including stale docs already in the DB and direct id access);
 * - tenant default resolves to the Claude model; no Ollama doc is seeded;
 * - ensureVisionModel never creates the Qwen seed; image turns resolve
 *   the Claude vision model;
 * - privacy routing: a sensitive turn is served by the cloud model SILENTLY
 *   (no user-facing PRIVACY_ROUTING notice frame) while the audit event is
 *   still recorded;
 * - the readiness report marks embeddings `disabled` without dialing Ollama.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any, tenantId: string) => Promise<any>) => cb(await getDbMock(), _tenantId)),
}));

vi.mock('../src/audit/audit.js', () => ({
  recordAudit: vi.fn().mockResolvedValue(undefined),
}));

// Claude key present (so isClaudeConfigured() is true), Ollama explicitly
// disabled: the Claude-only launch topology.
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...mod,
    config: {
      ...mod.config,
      OLLAMA_ENABLED: false,
      ANTHROPIC_API_KEY: 'test-anthropic-key-for-unit-tests',
      CLAUDE_ENABLED: true,
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    },
  };
});

import { recordAudit } from '../src/audit/audit.js';
import { runReadinessChecks } from '../src/health.js';
import {
  applyPrivacyRouting,
} from '../src/ai/gateway/privacyRouting.js';
import {
  cloudProviderServingAllowed,
  ensureTenantDefaultModel,
  ensureVisionModel,
  getApprovedModelForUser,
  listApprovedModelsForUser,
} from '../src/ai/gateway/modelRegistry.js';
import { resolveVisionModel } from '../src/ai/gateway/capabilityRouter.js';

/* ------------------------- in-memory mongo double ------------------------- */

function getPath(obj: any, path: string): any {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matches(doc: any, filter: any): boolean {
  if (!filter || typeof filter !== 'object') return true;
  return Object.entries(filter).every(([key, cond]) => {
    if (key === '$or') return (cond as any[]).some((f) => matches(doc, f));
    const value = getPath(doc, key);
    if (cond != null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond).every(([op, operand]) => {
        if (op === '$in') return (operand as any[]).includes(value);
        if (op === '$ne') return value !== operand;
        return false;
      });
    }
    return value === cond;
  });
}

let models: any[];
let modelAccess: any[];

function collectionDouble(name: string) {
  const store = name === 'models' ? models : modelAccess;
  return {
    findOne: vi.fn(async (filter: any) => store.find((d) => matches(d, filter)) ?? null),
    find: vi.fn((filter: any) => {
      const toArray = async () => store.filter((d) => matches(d, filter));
      return { sort: () => ({ toArray }), toArray };
    }),
    updateOne: vi.fn(async (filter: any, update: any) => {
      const doc = store.find((d) => matches(d, filter));
      if (doc) Object.assign(doc, update.$set);
      return { modifiedCount: doc ? 1 : 0 };
    }),
    updateMany: vi.fn(async (filter: any, update: any) => {
      let n = 0;
      for (const doc of store.filter((d) => matches(d, filter))) {
        Object.assign(doc, update.$set);
        n += 1;
      }
      return { modifiedCount: n };
    }),
    insertOne: vi.fn(async (doc: any) => {
      store.push({ ...doc });
      return { insertedId: doc._id };
    }),
  };
}

function claudeDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'claude-1',
    name: 'Claude Sonnet 4',
    provider: 'claude',
    endpoint: 'https://api.anthropic.com',
    modelIdentifier: 'claude-sonnet-4-20250514',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true, vision: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    enabled: true,
    seededProvider: 'claude',
    isProviderDefault: true,
    ...overrides,
  };
}

function ollamaDoc(overrides: Record<string, any> = {}) {
  return {
    _id: 'ollama-1',
    name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    provider: 'ollama',
    endpoint: 'http://localhost:11434',
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    capabilities: { chat: true, streaming: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    enabled: true,
    isDefault: true,
    ...overrides,
  };
}

const TENANT = 'tenant-flag';
const USER = 'user-flag';
const ROLE = 'role-flag';

function approvedClaude() {
  const { _id, enabled: _e, ...rest } = claudeDoc();
  return { id: _id, ...rest };
}

beforeEach(() => {
  vi.clearAllMocks();
  models = [];
  modelAccess = [];
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({ collection: collectionDouble }));
});

/* ------------------------------ serving gate ------------------------------ */

describe('serving gate with OLLAMA_ENABLED=false', () => {
  it('refuses Ollama while leaving other providers to their own gates', () => {
    expect(cloudProviderServingAllowed('ollama')).toBe(false);
    expect(cloudProviderServingAllowed('vllm')).toBe(true);
  });

  it('never creates the Qwen vision seed and never touches the database', async () => {
    await expect(ensureVisionModel()).resolves.toBeNull();
    expect(getDbMock).not.toHaveBeenCalled();
  });

  it('seeds the Claude model as tenant default and retires a stale Ollama default flag', async () => {
    models.push(ollamaDoc());
    const ensured = await ensureTenantDefaultModel();
    expect(ensured?.provider).toBe('claude');
    expect(ensured?.modelIdentifier).toBe('claude-sonnet-4-20250514');
    // The stale Ollama default flag is retired; no Ollama doc was created.
    expect(models.filter((d) => d.provider === 'ollama').every((d) => d.isDefault !== true)).toBe(true);
    expect(models.some((d) => d.provider === 'ollama' && d._id !== 'ollama-1')).toBe(false);
    // Idempotent: a second call finds the flagged Claude doc by flag.
    const again = await ensureTenantDefaultModel();
    expect(again?.id).toBe(ensured?.id);
    expect(models.filter((d) => d.provider === 'claude')).toHaveLength(1);
  });

  it('reuses an existing servable Claude doc as the tenant default', async () => {
    models.push(claudeDoc(), ollamaDoc({ isDefault: false }));
    const ensured = await ensureTenantDefaultModel();
    expect(ensured?.id).toBe('claude-1');
    expect(models.filter((d) => d.provider === 'claude')).toHaveLength(1);
  });

  it('rejects a direct id lookup of an Ollama model', async () => {
    models.push(ollamaDoc());
    await expect(getApprovedModelForUser('ollama-1', TENANT, USER, ROLE)).rejects.toMatchObject({
      code: 'MODEL_NOT_APPROVED',
      statusCode: 403,
    });
  });

  it('excludes stale Ollama docs from model listings', async () => {
    models.push(claudeDoc(), ollamaDoc({ isDefault: false }));
    modelAccess.push(
      { _id: 'a1', tenantId: TENANT, modelId: 'claude-1', userId: USER },
      { _id: 'a2', tenantId: TENANT, modelId: 'ollama-1', userId: USER },
    );
    const listed = await listApprovedModelsForUser(TENANT, USER, ROLE);
    expect(listed.map((m) => m.id)).toEqual(['claude-1']);
    expect(listed.every((m) => m.provider !== 'ollama')).toBe(true);
  });
});

/* ------------------------------ vision routing ----------------------------- */

describe('vision routing with OLLAMA_ENABLED=false', () => {
  it('resolves image turns to the Claude vision model', async () => {
    models.push(claudeDoc());
    const model = await resolveVisionModel({ tenantId: TENANT, userId: USER, roleId: ROLE });
    expect(model.provider).toBe('claude');
    expect(model.capabilities.vision).toBe(true);
    // The Qwen seed was never created.
    expect(models.some((d) => d.provider === 'ollama')).toBe(false);
  });
});

/* ----------------------------- privacy routing ----------------------------- */

describe('privacy routing with OLLAMA_ENABLED=false', () => {
  it('serves a sensitive turn on the cloud model SILENTLY: no user-facing notice, audit still recorded', async () => {
    models.push(claudeDoc());
    const preliminary = approvedClaude() as never;
    const decision = await applyPrivacyRouting({
      tenantId: TENANT,
      userId: USER,
      roleId: ROLE,
      requestId: 'req-flag-off',
      preliminaryModel: preliminary,
      explicitModelSelection: true,
      promptText: 'Our Q3 revenue was $4.2M with a 31% margin.',
      requestedCapability: 'chat',
      hasImages: false,
    });

    expect(decision.model.provider).toBe('claude');
    expect(decision.privacyOverridden).toBe(true);
    // Silent from the user's perspective: the chat route only emits a
    // PRIVACY_ROUTING SSE frame when decision.notice is non-null.
    expect(decision.notice).toBeNull();
    if (decision.notice) {
      throw new Error('unreachable: a notice frame would have been emitted');
    }

    // ...but the routing decision stays in the audit trail for admins.
    expect(recordAudit).toHaveBeenCalledTimes(1);
    const auditCall = vi.mocked(recordAudit).mock.calls[0]![0] as any;
    expect(auditCall.action).toBe('PRIVACY_ROUTING_LOCAL_DISABLED');
    expect(auditCall.success).toBe(true);
    expect(auditCall.metadata.categories).toEqual(['finance']);
    expect(auditCall.metadata.modelIdentifier).toBe('claude-sonnet-4-20250514');
  });

  it('never emits the disabled-local notice text on the flag-off path', async () => {
    models.push(claudeDoc());
    const decision = await applyPrivacyRouting({
      tenantId: TENANT,
      userId: USER,
      roleId: ROLE,
      requestId: 'req-flag-off-2',
      preliminaryModel: approvedClaude() as never,
      explicitModelSelection: false,
      promptText: 'Customer Acme Corp <untrusted_tool_result>ssn 123-45-6789</untrusted_tool_result>',
      requestedCapability: 'chat',
      hasImages: false,
    });
    expect(decision.notice).toBeNull();
  });
});

/* ------------------------------- readiness -------------------------------- */

describe('readiness with OLLAMA_ENABLED=false', () => {
  it('marks embeddings disabled without attempting any Ollama connection', async () => {
    getDbMock.mockRejectedValue(new Error('no database in unit tests'));
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const report = await runReadinessChecks();
    expect(report.checks.embeddings.status).toBe('disabled');
    expect(report.checks.embeddings.detail).toContain('OLLAMA_ENABLED=false');
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});
