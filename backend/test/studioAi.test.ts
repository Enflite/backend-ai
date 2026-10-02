/**
 * studioAi.test.ts — Studio AI generation (Wave 3).
 *
 * - POST /studio/automations/generate: NL -> draft via the model gateway
 *   test seam; real-catalog validation; fail-closed 502 (malformed JSON,
 *   schema mismatch, unknown action) creates nothing; drafts are born
 *   `draft` with `deployment.status: 'never'` — never deployed, no
 *   trigger wired; destructive drafts still deploy only via the explicit
 *   confirm gate; prompt length + connection validation; studio:run
 *   permission; audited as STUDIO_AUTOMATION_GENERATED.
 * - POST /studio/automations/:id/explain: deterministic explanation derived
 *   from the stored definition — every step described, destructive steps
 *   get a prominent warning section; never invents steps.
 * - POST /studio/automations/:id/suggest: 1-3 catalog-grounded next steps
 *   returned only, never applied.
 *
 * The DB, audit sink, and auth session are mocked; the model gateway is
 * replaced by the override seam. VALIDATED IN CI. No live upstream.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { resolveChatDefaultMock } = vi.hoisted(() => ({
  resolveChatDefaultMock: vi.fn(async () => null),
}));
const { gatewayStreamMock } = vi.hoisted(() => ({ gatewayStreamMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-studio-1',
    tenantId: 'tenant-studio-a',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'studio@example.test',
    displayName: 'Studio User',
    roleName: 'Admin',
    clearance: 'INTERNAL',
    permissions: ['studio:manage', 'studio:run', 'tenant:manage', 'flows:run', 'flows:manage'],
  } as Record<string, unknown>,
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({
  resolveChatDefault: resolveChatDefaultMock,
}));
vi.mock('../src/ai/gateway/gateway.js', () => ({ gatewayStream: gatewayStreamMock }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));

import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { studioRoutes } from '../src/studio/routes.js';
import {
  overrideStudioGenerateFn,
  validateGeneratedDraft,
} from '../src/studio/ai/generate.js';
import { makeInMemoryDb } from './helpers/studioMongo.js';

const TEST_KEY = randomBytes(32).toString('hex');
const TENANT = 'tenant-studio-a';

let mem: ReturnType<typeof makeInMemoryDb>;
let app: ReturnType<typeof Fastify>;

const savedConfig = {
  CREDENTIAL_STORE_KEY: config.CREDENTIAL_STORE_KEY,
  FLOWS_ENABLED: config.FLOWS_ENABLED,
};

function modelDraft(draft: unknown): string {
  return `Here is your draft:\n${JSON.stringify(draft)}\nDone.`;
}

const GOOD_DRAFT = {
  name: 'late-po-watch',
  title: 'Late PO watch',
  description: 'Flags late purchase orders for an item.',
  trigger: { kind: 'manual' },
  steps: [
    {
      id: 'fetch-pos',
      kind: 'action',
      actionId: 'syteline.getOpenPurchaseOrders',
      connectionId: 'default',
      params: { item: '{{inputs.item}}' },
    },
    {
      id: 'announce',
      kind: 'log',
      message: 'Checked POs for {{inputs.item}}',
    },
  ],
};

const DESTRUCTIVE_DRAFT = {
  name: 'purge-old-items',
  title: 'Purge old items',
  description: 'Deletes stale item records.',
  trigger: { kind: 'manual' },
  steps: [
    {
      id: 'delete-item',
      kind: 'action',
      actionId: 'syteline.record.delete',
      connectionId: 'default',
      params: { collection: 'items', key: { item: '{{inputs.item}}' } },
    },
  ],
};

beforeEach(async () => {
  mem = makeInMemoryDb();
  getDbMock.mockImplementation((...args: unknown[]) => (mem.getDbMock as any)(...args));
  recordAuditMock.mockResolvedValue(undefined);
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
  (config as Record<string, unknown>).FLOWS_ENABLED = true;
  currentAuth.permissions = ['studio:manage', 'studio:run', 'tenant:manage', 'flows:run', 'flows:manage'];

  app = Fastify();
  app.setErrorHandler((error: unknown, _req: any, reply: any) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: { code: error.code, message: error.message, details: (error as any).details },
      });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  await app.register(studioRoutes, { prefix: '/api/v1' });
});

afterEach(async () => {
  overrideStudioGenerateFn(null);
  await app.close();
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = savedConfig.CREDENTIAL_STORE_KEY;
  (config as Record<string, unknown>).FLOWS_ENABLED = savedConfig.FLOWS_ENABLED;
});

function automationCount(): number {
  return (mem.store['studio_automations'] ?? []).length;
}

async function seedAutomation(name = 'seeded-auto'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/studio/automations',
    payload: {
      name,
      title: 'Seeded',
      description: '',
      trigger: { kind: 'manual' },
      steps: [
        {
          id: 's1',
          kind: 'action',
          actionId: 'syteline.getItem',
          connectionId: 'default',
          params: { item: 'A-1', site: 'MAIN' },
        },
      ],
    },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { id: string }).id;
}

/** The thrown AppError's code — vitest's toThrow(regex) only matches messages. */
function expectGenerateMismatch(fn: () => unknown): void {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('STUDIO_GENERATE_SCHEMA_MISMATCH');
    return;
  }
  expect.unreachable('validateGeneratedDraft should have thrown');
}

describe('validateGeneratedDraft', () => {
  it('accepts a schema-valid draft using only real catalog actions', () => {
    const parsed = validateGeneratedDraft(GOOD_DRAFT);
    expect(parsed.name).toBe('late-po-watch');
    expect(parsed.steps).toHaveLength(2);
  });

  it('rejects drafts that invent catalog actions', () => {
    expectGenerateMismatch(() =>
      validateGeneratedDraft({
        ...GOOD_DRAFT,
        steps: [
          { id: 'x', kind: 'action', actionId: 'syteline.teleport', connectionId: 'default', params: {} },
        ],
      }),
    );
  });

  it('rejects drafts that break the automation schema (dangling condition target)', () => {
    expectGenerateMismatch(() =>
      validateGeneratedDraft({
        ...GOOD_DRAFT,
        steps: [{ id: 'c1', kind: 'condition', when: 'x', then: 'nope', else: 'nada' }],
      }),
    );
  });
});

describe('POST /studio/automations/generate', () => {
  it('creates a draft from NL — draft status, never deployed, connection pinned', async () => {
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Watch for late purchase orders for an item' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, any>;
    expect(body.name).toBe('late-po-watch');
    expect(body.status).toBe('draft');
    expect(body.deployment.status).toBe('never');
    expect(body.steps).toHaveLength(2);
    expect(body.steps[0].connectionId).toBe('default');
    expect(body.destructiveSteps).toEqual([]);
    expect(automationCount()).toBe(1);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_AUTOMATION_GENERATED', success: true }),
    );
  });

  it('a destructive draft is still a draft: flagged, never deployed', async () => {
    overrideStudioGenerateFn(async () => modelDraft(DESTRUCTIVE_DRAFT));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Delete stale item records' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as Record<string, any>;
    expect(body.status).toBe('draft');
    expect(body.deployment.status).toBe('never');
    expect(body.destructiveSteps).toHaveLength(1);
    expect(body.destructiveSteps[0]).toMatchObject({
      stepId: 'delete-item',
      actionId: 'syteline.record.delete',
    });
    // The deploy gate is untouched: deploying this draft still needs the
    // explicit human confirmation.
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${body.id}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(409);
    expect(deploy.json().error.code).toBe('STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED');
  });

  it('502s on malformed model JSON and creates nothing', async () => {
    overrideStudioGenerateFn(async () => 'not json at all');
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STUDIO_GENERATE_SCHEMA_MISMATCH');
    expect(automationCount()).toBe(0);
  });

  it('502s on invented catalog actions and creates nothing', async () => {
    overrideStudioGenerateFn(async () =>
      modelDraft({
        ...GOOD_DRAFT,
        steps: [
          { id: 'x', kind: 'action', actionId: 'syteline.fake', connectionId: 'default', params: {} },
        ],
      }),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing' },
    });
    expect(res.statusCode).toBe(502);
    expect(automationCount()).toBe(0);
  });

  it('502s when no servable model exists (no override seam)', async () => {
    // resolveChatDefault is mocked to null: fail-closed, nothing created.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('NO_GENERATE_MODEL');
    expect(automationCount()).toBe(0);
  });

  it('drives the real gateway path when a model is servable', async () => {
    resolveChatDefaultMock.mockResolvedValueOnce({ id: 'model-1' } as never);
    gatewayStreamMock.mockResolvedValueOnce({
      events: (async function* () {
        yield { type: 'text', content: modelDraft(GOOD_DRAFT) };
      })(),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Watch for late purchase orders' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { name: string }).name).toBe('late-po-watch');
    expect(automationCount()).toBe(1);
    // The catalog reached the model as context.
    const call = gatewayStreamMock.mock.calls[0]?.[0] as { systemPrompt?: string } | undefined;
    expect(call?.systemPrompt).toContain('syteline.getItem');
    expect(call?.systemPrompt).toContain('destructive');
  });

  it('404s on an unknown connectionId', async () => {
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing', connectionId: 'nope' },
    });
    expect(res.statusCode).toBe(404);
    expect(automationCount()).toBe(0);
  });

  it('rejects empty and over-long prompts', async () => {
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const empty = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: '' },
    });
    expect(empty.statusCode).toBe(400);
    const long = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'x'.repeat(2001) },
    });
    expect(long.statusCode).toBe(400);
    expect(automationCount()).toBe(0);
  });

  it('requires studio:run', async () => {
    currentAuth.permissions = [];
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing' },
    });
    expect(res.statusCode).toBe(403);
    expect(automationCount()).toBe(0);
  });

  it('retries the name on collision instead of failing', async () => {
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'one' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'two' },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect((second.json() as any).name).not.toBe('late-po-watch');
    expect((second.json() as any).name.startsWith('late-po-watch-')).toBe(true);
    expect(automationCount()).toBe(2);
  });

  it('403s FEATURE_DISABLED when FLOWS_ENABLED=false', async () => {
    (config as Record<string, unknown>).FLOWS_ENABLED = false;
    overrideStudioGenerateFn(async () => modelDraft(GOOD_DRAFT));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/generate',
      payload: { prompt: 'Do the thing' },
    });
    expect(res.statusCode).toBe(403);
    expect(automationCount()).toBe(0);
  });
});

describe('POST /studio/automations/:id/explain', () => {
  it('explains every step from the stored definition', async () => {
    const id = await seedAutomation('explain-me');
    const res = await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${id}/explain` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.automationId).toBe(id);
    expect(body.summary).toMatch(/1 step/);
    expect(body.summary).toMatch(/no destructive steps/);
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].text).toContain('syteline.getItem');
    expect(body.steps[0].text).toContain('Get item');
    expect(body.steps[0].text).toContain('default');
    expect(body.trigger.kind).toBe('manual');
    expect(body.destructive).toEqual([]);
  });

  it('flags destructive steps with a prominent warning section', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: {
        name: 'explain-destructive',
        title: 'Destructive demo',
        trigger: { kind: 'manual' },
        steps: [
          {
            id: 'del',
            kind: 'action',
            actionId: 'syteline.record.delete',
            connectionId: 'default',
            params: { collection: 'items', key: { item: 'X' } },
          },
          { id: 'note', kind: 'log', message: 'deleted' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
    const id = (res.json() as { id: string }).id;
    const explained = await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${id}/explain` });
    expect(explained.statusCode).toBe(200);
    const body = explained.json() as Record<string, any>;
    expect(body.destructive).toHaveLength(1);
    expect(body.destructive[0]).toMatchObject({ stepId: 'del', actionId: 'syteline.record.delete' });
    expect(body.destructive[0].warning).toMatch(/confirmDestructive/);
    expect(body.steps[0].text).toMatch(/DESTRUCTIVE/);
  });

  it('404s on an unknown automation', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/studio/automations/nope/explain' });
    expect(res.statusCode).toBe(404);
  });

  it('requires studio:run', async () => {
    const id = await seedAutomation('explain-perm');
    currentAuth.permissions = [];
    const res = await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${id}/explain` });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /studio/automations/:id/suggest', () => {
  it('suggests foundational reads for an empty draft', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: { name: 'empty-draft', title: 'Empty', trigger: { kind: 'manual' }, steps: [] },
    });
    // The automation schema requires >=1 step; seed via the DB instead.
    expect(res.statusCode).toBe(400);
    mem.store['studio_automations'] = [
      {
        _id: 'empty-1',
        tenantId: TENANT,
        name: 'empty-draft',
        title: 'Empty',
        description: '',
        status: 'draft',
        trigger: { kind: 'manual' },
        steps: [],
        inputs: {},
        deployment: { status: 'never', flowName: 'studio-empty-1' },
        createdBy: 'user-studio-1',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ];
    const suggested = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations/empty-1/suggest',
    });
    expect(suggested.statusCode).toBe(200);
    const body = suggested.json() as Record<string, any>;
    expect(body.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(body.suggestions.length).toBeLessThanOrEqual(3);
    for (const s of body.suggestions) {
      expect(s.reason).toBeTruthy();
      expect(s.step).toBeTruthy();
      expect(s.step.kind).toBe('action');
    }
  });

  it('suggests verify + log + chained read after an action step, and applies nothing', async () => {
    const id = await seedAutomation('suggest-me');
    const before = JSON.stringify(mem.store['studio_automations']);
    const res = await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${id}/suggest` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Record<string, any>;
    expect(body.suggestions).toHaveLength(3);
    const kinds = body.suggestions.map((s: any) => s.step.kind);
    expect(kinds).toContain('verify');
    expect(kinds).toContain('log');
    expect(kinds).toContain('action');
    // The verify suggestion re-uses the draft's own action and connection.
    const verify = body.suggestions.find((s: any) => s.step.kind === 'verify');
    expect(verify.step.actionId).toBe('syteline.getItem');
    expect(verify.step.connectionId).toBe('default');
    // Nothing was applied: the stored draft is byte-identical.
    expect(JSON.stringify(mem.store['studio_automations'])).toBe(before);
  });

  it('404s on an unknown automation', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/studio/automations/nope/suggest' });
    expect(res.statusCode).toBe(404);
  });

  it('requires studio:run', async () => {
    const id = await seedAutomation('suggest-perm');
    currentAuth.permissions = [];
    const res = await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${id}/suggest` });
    expect(res.statusCode).toBe(403);
  });
});
