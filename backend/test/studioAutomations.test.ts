/**
 * studioAutomations.test.ts — Studio automation model, compile-to-Flow,
 * triggers, deploy gate, dry-run, and runs.
 *
 * - compileAutomation: action/condition/verify/log lowering, verify
 *   assert-chain with jump-over fail step, input scanning, validation
 *   (duplicate ids, dangling condition targets, unknown actions, missing
 *   connections)
 * - routes: CRUD + permissions, deploy destructive gate (409 without
 *   confirmDestructive), manual/scheduled/webhook/event deploys, webhook
 *   fire + rotation (token shown once, stored hashed, never in audit),
 *   undeploy, delete teardown
 * - dry-run: real reads against the fake upstream, destructive steps
 *   skipped (never executed)
 * - runs: listing filtered to studio flows + run detail
 * - FEATURE_DISABLED when FLOWS_ENABLED=false
 *
 * The DB, audit sink, and auth session are mocked; HTTP to the fake
 * upstream is mocked at the global fetch seam. VALIDATED IN CI.
 */
import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
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
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));

import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { studioRoutes } from '../src/studio/routes.js';
import { compileAutomation, compileWatcherFlow } from '../src/studio/automations/compile.js';
import { automationFlowName } from '../src/studio/automations/store.js';
import { hashWebhookToken } from '../src/studio/automations/webhooks.js';
import type { StudioAutomationDoc } from '../src/studio/automations/types.js';
import { makeInMemoryDb } from './helpers/studioMongo.js';

const TEST_KEY = randomBytes(32).toString('hex');
const UPSTREAM = 'https://upstream.test';
const TENANT = 'tenant-studio-a';
const USER = 'user-studio-1';

let mem: ReturnType<typeof makeInMemoryDb>;
let app: ReturnType<typeof Fastify>;
let fetchCalls: Array<{ url: string; method: string }>;

const savedConfig = {
  CREDENTIAL_STORE_KEY: config.CREDENTIAL_STORE_KEY,
  FLOWS_ENABLED: config.FLOWS_ENABLED,
  SCHEDULES_ENABLED: config.SCHEDULES_ENABLED,
  FLOW_RUNNER_ENABLED: config.FLOW_RUNNER_ENABLED,
};

function fakeUpstream() {
  fetchCalls = [];
  return vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url: String(url), method: String(init?.method ?? 'GET') });
    const method = String(init?.method ?? 'GET');
    if (method === 'OPTIONS') return new Response('{}', { status: 405 });
    if (String(url).startsWith(`${UPSTREAM}/api/`)) {
      return new Response(JSON.stringify({ ok: true, status: 'open', echoed: String(url) }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  });
}

function seedIdentity(): void {
  mem.store['users'] = [
    {
      _id: USER,
      email: 'studio@example.test',
      passwordHash: 'x',
      displayName: 'Studio User',
      isActive: true,
      clearance: 'INTERNAL',
    },
  ];
  mem.store['memberships'] = [{ _id: 'm1', userId: USER, tenantId: TENANT, roleId: 'role-1' }];
  mem.store['tenants'] = [{ _id: TENANT, name: 'Studio Tenant' }];
  mem.store['roles'] = [{ _id: 'role-1', name: 'Admin' }];
}

beforeEach(async () => {
  mem = makeInMemoryDb();
  getDbMock.mockImplementation((...args: unknown[]) => (mem.getDbMock as any)(...args));
  recordAuditMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fakeUpstream());
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
  (config as Record<string, unknown>).FLOWS_ENABLED = true;
  (config as Record<string, unknown>).SCHEDULES_ENABLED = true;
  (config as Record<string, unknown>).FLOW_RUNNER_ENABLED = false;
  currentAuth.permissions = [
    'studio:manage',
    'studio:run',
    'tenant:manage',
    'flows:run',
    'flows:manage',
  ];
  seedIdentity();

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
  vi.unstubAllGlobals();
  await app.close();
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = savedConfig.CREDENTIAL_STORE_KEY;
  (config as Record<string, unknown>).FLOWS_ENABLED = savedConfig.FLOWS_ENABLED;
  (config as Record<string, unknown>).SCHEDULES_ENABLED = savedConfig.SCHEDULES_ENABLED;
  (config as Record<string, unknown>).FLOW_RUNNER_ENABLED = savedConfig.FLOW_RUNNER_ENABLED;
});

async function createConn(name = 'TRN') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/studio/connections',
    payload: { name, environment: 'TRN', baseUrl: UPSTREAM, token: 'conn-token-1' },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

function automationPayload(connId: string, trigger: unknown = { kind: 'manual' }, name = 'Nightly check') {
  return {
    name,
    title: 'Nightly availability check',
    description: 'Checks item availability on a schedule.',
    trigger,
    steps: [
      {
        id: 'fetch-item',
        kind: 'action',
        actionId: 'syteline.getItem',
        connectionId: connId,
        params: { item: '{{inputs.item}}', site: 'MAIN' },
      },
      {
        id: 'check-stock',
        kind: 'verify',
        actionId: 'syteline.getItemAvailability',
        connectionId: connId,
        params: { item: '{{inputs.item}}', site: 'MAIN' },
        assertions: [{ path: 'status', operator: '==', value: 'open' }],
      },
      { id: 'note', kind: 'log', message: 'Checked {{inputs.item}}' },
    ],
  };
}

async function createAutomation(connId: string, trigger?: unknown, name?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/studio/automations',
    payload: automationPayload(connId, trigger, name),
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; name: string; deployment: { flowName: string } };
}

function makeDoc(connId: string, steps: any[], trigger: any = { kind: 'manual' }): StudioAutomationDoc {
  const now = new Date();
  return {
    _id: 'auto-1',
    tenantId: TENANT,
    name: 'compile-test',
    title: 'Compile test',
    description: '',
    status: 'draft',
    trigger,
    steps,
    inputs: {},
    deployment: { status: 'never', flowName: automationFlowName('auto-1') },
    createdBy: USER,
    createdAt: now,
    updatedAt: now,
  };
}

// ---------------------------------------------------------------------------
// compileAutomation
// ---------------------------------------------------------------------------

describe('compileAutomation', () => {
  it('lowers action steps to studio.executeAction tool steps', async () => {
    const conn = await createConn();
    const doc = makeDoc(conn.id, [
      {
        id: 'get',
        kind: 'action',
        actionId: 'syteline.getItem',
        connectionId: conn.id,
        params: { item: 'A', site: 'MAIN' },
        retries: 2,
        continueOnError: true,
      },
    ]);
    const compiled = await compileAutomation(TENANT, doc);
    expect(compiled.flowName).toBe('studio-auto-1');
    expect(compiled.destructiveSteps).toEqual([]);
    const step = compiled.definition.steps.find((s) => s.id === 'get');
    expect(step).toMatchObject({
      kind: 'tool',
      tool: 'studio.executeAction',
      retries: 2,
      continueOnError: true,
    });
    expect((step as any).params).toEqual({
      connectionId: conn.id,
      actionId: 'syteline.getItem',
      params: { item: 'A', site: 'MAIN' },
    });
    // Terminal log step is always appended.
    const last = compiled.definition.steps[compiled.definition.steps.length - 1]!;
    expect(last.kind).toBe('tool');
    expect((last as any).tool).toBe('studio.log');
  });

  it('routes destructive actions to studio.executeWriteAction and flags them', async () => {
    const conn = await createConn();
    const doc = makeDoc(conn.id, [
      {
        id: 'wipe',
        kind: 'action',
        actionId: 'syteline.record.delete',
        connectionId: conn.id,
        params: { collection: 'items', key: { item: 'A' } },
      },
    ]);
    const compiled = await compileAutomation(TENANT, doc);
    const step = compiled.definition.steps.find((s) => s.id === 'wipe');
    expect((step as any).tool).toBe('studio.executeWriteAction');
    expect(compiled.destructiveSteps).toEqual([
      { stepId: 'wipe', actionId: 'syteline.record.delete', title: 'Delete record' },
    ]);
  });

  it('rewires condition targets and compiles verify to fetch + asserts + fail', async () => {
    const conn = await createConn();
    const doc = makeDoc(conn.id, [
      {
        id: 'get',
        kind: 'action',
        actionId: 'syteline.getItem',
        connectionId: conn.id,
        params: { item: 'A', site: 'MAIN' },
      },
      {
        id: 'v',
        kind: 'verify',
        actionId: 'syteline.getItemAvailability',
        connectionId: conn.id,
        params: { item: 'A', site: 'MAIN' },
        assertions: [
          { path: 'status', operator: '==', value: 'open' },
          { path: 'available', operator: '!=', value: '0' },
        ],
      },
      { id: 'done-note', kind: 'log', message: 'done' },
    ]);
    const compiled = await compileAutomation(TENANT, doc);
    const byId = new Map(compiled.definition.steps.map((s) => [s.id, s] as const));

    // fetch step
    expect(byId.get('v_fetch')).toMatchObject({ kind: 'tool', tool: 'studio.executeAction' });

    // assert chain: then → next assert / next automation step, else → fail step
    const a0 = byId.get('v_assert_0') as any;
    const a1 = byId.get('v_assert_1') as any;
    const fail = byId.get('v_failed') as any;
    expect(a0.kind).toBe('condition');
    expect(a0.when).toBe(`{{steps.v_fetch.output.data.status}} == 'open'`);
    expect(a0.then).toBe('v_assert_1');
    expect(a0.else).toBe('v_failed');
    expect(a1.when).toBe(`{{steps.v_fetch.output.data.available}} != '0'`);
    // Last assert jumps OVER the fail step to the next automation step.
    expect(a1.then).toBe('done-note');
    expect(a1.else).toBe('v_failed');
    expect(fail).toMatchObject({ kind: 'tool', tool: 'studio.fail' });

    // Step order: the fail step sits directly after the last assertion.
    const ids = compiled.definition.steps.map((s) => s.id);
    expect(ids.indexOf('v_failed')).toBe(ids.indexOf('v_assert_1') + 1);
    expect(ids.indexOf('done-note')).toBe(ids.indexOf('v_failed') + 1);
  });

  it('scans {{inputs.x}} references into flow inputs (declared wins)', async () => {
    const conn = await createConn();
    const doc = makeDoc(conn.id, [
      {
        id: 'get',
        kind: 'action',
        actionId: 'syteline.getItem',
        connectionId: conn.id,
        params: { item: '{{inputs.item}}', site: 'MAIN' },
      },
      { id: 'c', kind: 'condition', when: `{{inputs.flag}} == 'yes'`, then: 'get', else: 'get' },
    ]);
    doc.inputs = { item: { type: 'string', required: true, description: 'The item' } };
    const compiled = await compileAutomation(TENANT, doc);
    expect(compiled.definition.inputs.item).toMatchObject({ type: 'string', required: true });
    expect(compiled.definition.inputs.flag).toMatchObject({ type: 'string', required: false });
  });

  it('rejects duplicate step ids, dangling condition targets, unknown actions, missing connections', async () => {
    const conn = await createConn();
    const base = {
      id: 'get',
      kind: 'action',
      actionId: 'syteline.getItem',
      connectionId: conn.id,
      params: { item: 'A', site: 'MAIN' },
    };
    await expect(
      compileAutomation(TENANT, makeDoc(conn.id, [base, { ...base }]))
    ).rejects.toMatchObject({ code: 'STUDIO_AUTOMATION_BAD_STEP' });

    await expect(
      compileAutomation(
        TENANT,
        makeDoc(conn.id, [
          base,
          { id: 'c', kind: 'condition', when: 'x', then: 'get', else: 'nope' },
        ])
      )
    ).rejects.toThrow(/unknown step id/);

    await expect(
      compileAutomation(
        TENANT,
        makeDoc(conn.id, [{ ...base, id: 'bad', actionId: 'nope.nope' }])
      )
    ).rejects.toMatchObject({ code: 'STUDIO_AUTOMATION_BAD_STEP' });

    await expect(
      compileAutomation(
        TENANT,
        makeDoc(conn.id, [{ ...base, id: 'bad', connectionId: 'missing-conn' }])
      )
    ).rejects.toMatchObject({ code: 'STUDIO_AUTOMATION_BAD_STEP' });
  });

  it('builds a watcher flow that refuses destructive watched actions', async () => {
    const conn = await createConn();
    const doc = makeDoc(conn.id, [
      {
        id: 'get',
        kind: 'action',
        actionId: 'syteline.getItem',
        connectionId: conn.id,
        params: { item: 'A', site: 'MAIN' },
      },
    ]);
    const compiled = await compileAutomation(TENANT, doc);
    const watcher = compileWatcherFlow('auto-1', compiled, {
      connectionId: conn.id,
      actionId: 'syteline.getItemAvailability',
      params: { item: 'A', site: 'MAIN' },
      watchPath: 'available',
    });
    expect(watcher.name).toBe('studio-auto-1-watch');
    const ids = watcher.steps.map((s) => s.id);
    expect(ids).toEqual(['fetch', 'check', 'decide', 'fire', 'done']);
    const decide = watcher.steps.find((s) => s.id === 'decide') as any;
    expect(decide.then).toBe('fire');
    expect(decide.else).toBe('done');
    const fire = watcher.steps.find((s) => s.id === 'fire') as any;
    expect(fire.flow).toBe('studio-auto-1');

    expect(() =>
      compileWatcherFlow('auto-1', compiled, {
        connectionId: conn.id,
        actionId: 'syteline.record.delete',
        params: {},
        watchPath: '',
      })
    ).toThrow(/destructive/);
  });
});

// ---------------------------------------------------------------------------
// Routes: CRUD + permissions
// ---------------------------------------------------------------------------

describe('automation routes: CRUD', () => {
  it('denies reads without studio:run and writes without studio:manage', async () => {
    currentAuth.permissions = [];
    expect((await app.inject({ method: 'GET', url: '/api/v1/studio/automations' })).statusCode).toBe(403);

    currentAuth.permissions = ['studio:run'];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: {
        name: 'x',
        title: 'x',
        description: '',
        trigger: { kind: 'manual' },
        steps: [{ id: 'l', kind: 'log', message: 'hi' }],
      },
    });
    expect(res.statusCode).toBe(403);
  });

  it('creates, reads, lists, updates, and deletes an automation', async () => {
    const conn = await createConn();
    const created = await createAutomation(conn.id);
    expect(created.id).toBeDefined();

    const got = await app.inject({ method: 'GET', url: `/api/v1/studio/automations/${created.id}` });
    expect(got.statusCode).toBe(200);
    const gotBody = got.json();
    expect(gotBody.name).toBe('Nightly check');
    expect(gotBody.status).toBe('draft');
    expect(gotBody.destructiveSteps).toEqual([]);
    expect(gotBody.deployment.status).toBe('never');
    // No secret material in the view.
    expect(JSON.stringify(gotBody)).not.toContain('conn-token-1');

    const listed = await app.inject({ method: 'GET', url: '/api/v1/studio/automations' });
    expect(listed.json().items).toHaveLength(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/studio/automations/${created.id}`,
      payload: { title: 'Renamed' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().title).toBe('Renamed');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/studio/automations/${created.id}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/studio/automations/${created.id}` })).statusCode
    ).toBe(404);
  });

  it('rejects unknown catalog actions and duplicate names at authoring time', async () => {
    const conn = await createConn();
    const bad = automationPayload(conn.id);
    (bad.steps[0] as any).actionId = 'nope.nope';
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: bad,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('STUDIO_AUTOMATION_BAD_STEP');

    await createAutomation(conn.id, { kind: 'manual' }, 'Dup');
    const dup = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: automationPayload(conn.id, { kind: 'manual' }, 'dup'),
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error.code).toBe('STUDIO_AUTOMATION_NAME_TAKEN');
  });

  it('403s everything when FLOWS_ENABLED=false', async () => {
    (config as Record<string, unknown>).FLOWS_ENABLED = false;
    const res = await app.inject({ method: 'GET', url: '/api/v1/studio/automations' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_DISABLED');
  });
});

// ---------------------------------------------------------------------------
// Deploy: the destructive gate
// ---------------------------------------------------------------------------

function destructivePayload(connId: string) {
  return {
    name: 'Danger zone',
    title: 'Danger zone',
    description: '',
    trigger: { kind: 'manual' },
    steps: [
      {
        id: 'wipe',
        kind: 'action',
        actionId: 'syteline.record.delete',
        connectionId: connId,
        params: { collection: 'items', key: { item: 'A' } },
      },
    ],
  };
}

describe('deploy: destructive gate', () => {
  it('409s without confirmDestructive, listing the destructive steps', async () => {
    const conn = await createConn();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: destructivePayload(conn.id),
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/deploy`,
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED');
    expect(res.json().error.details.destructiveSteps).toEqual([
      { stepId: 'wipe', actionId: 'syteline.record.delete', title: 'Delete record' },
    ]);
    // Still a draft: nothing was published or wired.
    const got = await app.inject({ method: 'GET', url: `/api/v1/studio/automations/${id}` });
    expect(got.json().status).toBe('draft');
    expect(mem.store['flows'] ?? []).toHaveLength(0);
  });

  it('deploys with confirmDestructive: publishes the flow and sets the live alias', async () => {
    const conn = await createConn();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: destructivePayload(conn.id),
    });
    const id = created.json().id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/deploy`,
      payload: { confirmDestructive: true },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('active');
    expect(body.deployment.status).toBe('deployed');
    expect(body.deployment.flowName).toBe(`studio-${id}`);
    expect(body.deployment.flowVersion).toBe(1);
    expect(body.deployment.triggerKind).toBe('manual');
    expect(body.deployment.confirmWrites).toBe(true);

    const flows = mem.store['flows'] ?? [];
    expect(flows).toHaveLength(1);
    const flow = flows[0]!;
    expect(flow.name).toBe(`studio-${id}`);
    expect(flow.liveVersion).toBe(1);
    expect(flow.versions).toHaveLength(1);
    const step = flow.versions[0].definition.steps.find((s: any) => s.id === 'wipe');
    expect(step.tool).toBe('studio.executeWriteAction');
  });
});

// ---------------------------------------------------------------------------
// Deploy: triggers
// ---------------------------------------------------------------------------

describe('deploy: triggers', () => {
  it('deploys a manual automation and fires it on demand', async () => {
    const conn = await createConn();
    const created = await createAutomation(conn.id);
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(200);
    expect(deploy.json().deployment.confirmWrites).toBe(false);

    // Manual run with inputs (the automation references {{inputs.item}}).
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/run`,
      payload: { inputs: { item: 'WIDGET-1' } },
    });
    expect(run.statusCode).toBe(202);
    expect(run.json().runId).toBeDefined();
    expect(run.json().flowVersion).toBe(1);

    // The run shows up in the studio runs listing.
    const runs = await app.inject({ method: 'GET', url: '/api/v1/studio/runs' });
    expect(runs.statusCode).toBe(200);
    expect(runs.json().items).toHaveLength(1);
    expect(runs.json().items[0].flowName).toBe(`studio-${created.id}`);
    expect(runs.json().items[0].automationId).toBe(created.id);

    const detail = await app.inject({
      method: 'GET',
      url: `/api/v1/studio/runs/${run.json().runId}`,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().steps.map((s: any) => s.stepId)).toEqual([
      'fetch-item',
      'check-stock_fetch',
      'check-stock_assert_0',
      'check-stock_failed',
      'note',
      '__complete',
    ]);
  });

  it('409s a manual run of a destructive automation without confirmWrites', async () => {
    const conn = await createConn();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: destructivePayload(conn.id),
    });
    const id = created.json().id;
    await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/deploy`,
      payload: { confirmDestructive: true },
    });
    const run = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/run`,
      payload: {},
    });
    expect(run.statusCode).toBe(409);
    expect(run.json().error.code).toBe('STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED');
  });

  it('deploys a scheduled trigger via the Schedules API and pauses it on undeploy', async () => {
    const conn = await createConn();
    const created = await createAutomation(
      conn.id,
      { kind: 'scheduled', cron: '0 7 * * 1-5', timezone: 'America/Chicago', inputs: { item: 'A' } },
      'Sched'
    );
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(200);
    expect(deploy.json().deployment.scheduleName).toBe(`studio-${created.id}`);

    const schedules = mem.store['schedules'] ?? [];
    expect(schedules).toHaveLength(1);
    const schedule = schedules[0]!;
    expect(schedule.target.flowName).toBe(`studio-${created.id}`);
    expect(schedule.trigger).toMatchObject({
      kind: 'cron',
      expression: '0 7 * * 1-5',
      timezone: 'America/Chicago',
    });
    expect(schedule.enabled).toBe(true);
    expect(schedule.confirmWrites).toBe(false);
    expect(schedule.runAsUserId).toBe(USER);

    const undeploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/undeploy`,
    });
    expect(undeploy.statusCode).toBe(200);
    expect(undeploy.json().status).toBe('paused');
    expect(undeploy.json().deployment.status).toBe('undeployed');
    expect((mem.store['schedules'] ?? [])[0]!.enabled).toBe(false);
  });

  it('issues a webhook token once, fires runs with it, and rotates it', async () => {
    const conn = await createConn();
    const created = await createAutomation(conn.id, { kind: 'webhook' }, 'Hook');
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(200);
    const token = deploy.json().webhookToken as string;
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(deploy.json().webhookUrl).toBe(`/api/v1/studio/hooks/${token}`);

    // Stored hashed, never the raw token.
    const stored = (mem.store['studio_automations'] ?? []).find((d: any) => d._id === created.id);
    expect(stored).toBeDefined();
    expect(stored!.deployment.webhookTokenHash).toBe(hashWebhookToken(token));
    expect(JSON.stringify(stored)).not.toContain(token);

    // Redeploy keeps the token (does not reissue).
    const redeploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    expect(redeploy.json().webhookToken).toBeUndefined();

    // Fire with the token (no session auth needed).
    const fire = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/hooks/${token}`,
      payload: { item: 'WIDGET-9' },
    });
    expect(fire.statusCode).toBe(202);
    expect(fire.json().automationId).toBe(created.id);

    // Unknown token → 404, and the token never appears in audit payloads.
    const bad = await app.inject({ method: 'POST', url: '/api/v1/studio/hooks/nope', payload: {} });
    expect(bad.statusCode).toBe(404);
    for (const call of recordAuditMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain(token);
    }

    // Rotate: the old token dies, the new one works.
    const rotated = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/webhook/rotate`,
    });
    expect(rotated.statusCode).toBe(200);
    const token2 = rotated.json().webhookToken as string;
    expect(token2).not.toBe(token);
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/studio/hooks/${token}`, payload: {} }))
        .statusCode
    ).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/studio/hooks/${token2}`, payload: {} }))
        .statusCode
    ).toBe(202);

    // Undeploy invalidates the token.
    await app.inject({ method: 'POST', url: `/api/v1/studio/automations/${created.id}/undeploy` });
    expect(
      (await app.inject({ method: 'POST', url: `/api/v1/studio/hooks/${token2}`, payload: {} }))
        .statusCode
    ).toBe(404);
  });

  it('deploys an event trigger as a watcher flow plus a polling schedule', async () => {
    const conn = await createConn();
    const created = await createAutomation(
      conn.id,
      {
        kind: 'event',
        connectionId: conn.id,
        actionId: 'syteline.getItemAvailability',
        params: { item: 'A', site: 'MAIN' },
        watchPath: 'available',
        pollCron: '*/15 * * * *',
        timezone: 'America/Chicago',
      },
      'Watcher auto'
    );
    const deploy = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    expect(deploy.statusCode).toBe(200);
    expect(deploy.json().deployment.scheduleName).toBe(`studio-${created.id}-watch`);

    const flows = mem.store['flows'] ?? [];
    const watcher = flows.find((f: any) => f.name === `studio-${created.id}-watch`);
    expect(watcher).toBeDefined();
    expect(watcher!.liveVersion).toBe(1);
    const watcherSchedules = mem.store['schedules'] ?? [];
    expect(watcherSchedules).toHaveLength(1);
    const watcherSchedule = watcherSchedules[0]!;
    expect(watcherSchedule.name).toBe(`studio-${created.id}-watch`);
    expect(watcherSchedule.target.flowName).toBe(`studio-${created.id}-watch`);
  });

  it('deleting a deployed automation tears down its triggers and flows', async () => {
    const conn = await createConn();
    const created = await createAutomation(
      conn.id,
      { kind: 'scheduled', cron: '0 7 * * *', timezone: 'America/Chicago' },
      'Doomed'
    );
    await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/deploy`,
      payload: {},
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/studio/automations/${created.id}`,
    });
    expect(del.statusCode).toBe(204);
    expect((mem.store['schedules'] ?? [])[0]!.enabled).toBe(false);
    expect((mem.store['flows'] ?? []).find((f: any) => f.name === `studio-${created.id}`)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Dry-run: real reads, destructive steps skipped
// ---------------------------------------------------------------------------

describe('dry-run', () => {
  it('executes reads for real and skips destructive steps without executing them', async () => {
    const conn = await createConn();
    const payload = automationPayload(conn.id);
    payload.steps.push({
      id: 'wipe',
      kind: 'action',
      actionId: 'syteline.record.delete',
      connectionId: conn.id,
      params: { collection: 'items', key: { item: 'A' } },
    } as any);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload,
    });
    const id = created.json().id;

    const callsBefore = fetchCalls.length;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/test`,
      payload: { inputs: { item: 'WIDGET-1' } },
    });
    expect(res.statusCode).toBe(200);
    const report = res.json();
    expect(report.dryRun).toBe(true);
    expect(report.automationId).toBe(id);

    const byId = new Map(report.steps.map((s: any) => [s.stepId, s]));
    // The read action ran for real against the fake upstream.
    const fetch = byId.get('fetch-item') as any;
    expect(fetch.status).toBe('ok');
    expect(fetch.skipped).toBe(false);
    expect(fetch.request.method).toBe('GET');
    expect(fetch.request.url).toContain('/api/items');
    expect(fetch.request.url).toContain('item=WIDGET-1');
    expect(fetch.response.status).toBe(200);
    expect(fetch.durationMs).toBeGreaterThanOrEqual(0);

    // The verify step re-fetched and asserted for real.
    const verify = byId.get('check-stock') as any;
    expect(verify.status).toBe('ok');
    expect(verify.detail.assertions).toEqual([
      {
        path: 'status',
        operator: '==',
        expected: 'open',
        actual: 'open',
        passed: true,
      },
    ]);

    // The destructive step was skipped — and never hit the network.
    const wipe = byId.get('wipe') as any;
    expect(wipe.status).toBe('skipped');
    expect(wipe.skipped).toBe(true);
    const writeCalls = fetchCalls
      .slice(callsBefore)
      .filter((c) => !['GET', 'OPTIONS'].includes(c.method));
    expect(writeCalls).toHaveLength(0);
  });

  it('stops at a failed verify and reports the assertion results', async () => {
    const conn = await createConn();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: {
        name: 'Failing verify',
        title: 'Failing verify',
        description: '',
        trigger: { kind: 'manual' },
        steps: [
          {
            id: 'v',
            kind: 'verify',
            actionId: 'syteline.getItemAvailability',
            connectionId: conn.id,
            params: { item: 'A', site: 'MAIN' },
            assertions: [{ path: 'status', operator: '==', value: 'closed' }],
          },
          { id: 'note', kind: 'log', message: 'never reached' },
        ],
      },
    });
    const id = created.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${id}/test`,
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    const steps = res.json().steps;
    expect(steps[0].status).toBe('failed');
    expect(steps[0].detail.assertions[0].passed).toBe(false);
    expect(steps[0].detail.assertions[0].actual).toBe('open');
    expect(steps[1].status).toBe('skipped');
  });

  it('400s on inputs that violate the compiled input spec', async () => {
    const conn = await createConn();
    const created = await createAutomation(conn.id);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.id}/test`,
      payload: { inputs: { item: 'A', bogus: 1 } },
    });
    expect(res.statusCode).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tools: the catalog's tool binding
// ---------------------------------------------------------------------------

describe('studio tools', () => {
  const toolAuth = () => ({ tenantId: TENANT, userId: USER });

  async function seedProbedConnection() {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/connections',
      payload: { name: 'TRN', environment: 'TRN', baseUrl: UPSTREAM, token: 'conn-token-1' },
    });
    return (res.json() as { id: string }).id;
  }

  it('studio.executeAction runs reads for real and refuses destructive actions', async () => {
    const { studioAutomationToolDefinitions } = await import(
      '../src/studio/automations/tools.js'
    );
    const connId = await seedProbedConnection();
    const readTool = studioAutomationToolDefinitions.find((t) => t.name === 'studio.executeAction')!;

    const out = (await readTool.execute(
      { connectionId: connId, actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
      { auth: toolAuth(), requestId: 'req-1' } as any,
      AbortSignal.timeout(5000)
    )) as any;
    expect(out.status).toBe(200);
    expect(out.data).toMatchObject({ ok: true, status: 'open' });

    await expect(
      readTool.execute(
        {
          connectionId: connId,
          actionId: 'syteline.record.delete',
          params: { collection: 'x', key: {} },
        },
        { auth: toolAuth(), requestId: 'req-1' } as any,
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'STUDIO_WRITE_ACTION_MISMATCH' });
    // The refused write never hit the network.
    expect(
      fetchCalls.filter((c) => !['GET', 'OPTIONS'].includes(c.method))
    ).toHaveLength(0);
  });

  it('studio.executeWriteAction is the only path for destructive actions', async () => {
    const { studioAutomationToolDefinitions } = await import(
      '../src/studio/automations/tools.js'
    );
    const connId = await seedProbedConnection();
    const writeTool = studioAutomationToolDefinitions.find(
      (t) => t.name === 'studio.executeWriteAction'
    )!;
    expect(writeTool.destructive).toBe(true);

    // Refuses non-destructive actions (defense in depth).
    await expect(
      writeTool.execute(
        { connectionId: connId, actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
        { auth: toolAuth(), requestId: 'req-1' } as any,
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'STUDIO_WRITE_ACTION_MISMATCH' });

    // A destructive action the upstream lacks is never executed.
    await expect(
      writeTool.execute(
        {
          connectionId: connId,
          actionId: 'syteline.record.delete',
          params: { collection: 'items', key: { item: 'A' } },
        },
        { auth: toolAuth(), requestId: 'req-1' } as any,
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'STUDIO_ACTION_UNSUPPORTED' });
    expect(
      fetchCalls.filter((c) => !['GET', 'OPTIONS'].includes(c.method))
    ).toHaveLength(0);
  });

  it('studio.snapshotCheck detects changes without spurious first-run fires', async () => {
    const { studioAutomationToolDefinitions } = await import(
      '../src/studio/automations/tools.js'
    );
    const check = studioAutomationToolDefinitions.find(
      (t) => t.name === 'studio.snapshotCheck'
    )!;
    const run = (value: unknown) =>
      check.execute(
        { snapshotKey: 'studio:auto-1:event', value },
        { auth: toolAuth(), requestId: 'req-1' } as any,
        AbortSignal.timeout(5000)
      ) as Promise<{ changed: boolean; firstRun: boolean }>;

    // First observation stores the baseline: no change, no fire.
    expect(await run({ available: 5 })).toEqual({ changed: false, firstRun: true });
    // Same value: no change.
    expect(await run({ available: 5 })).toEqual({ changed: false, firstRun: false });
    // Changed value: fires.
    expect(await run({ available: 3 })).toEqual({ changed: true, firstRun: false });
    // And the new baseline sticks.
    expect(await run({ available: 3 })).toEqual({ changed: false, firstRun: false });

    const snapshots = mem.store['studio_snapshots'] ?? [];
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.key).toBe('studio:auto-1:event');
    expect(snapshot.valueHash).toHaveLength(64);
  });

  it('studio.fail always fails and studio.log audits', async () => {
    const { studioAutomationToolDefinitions } = await import(
      '../src/studio/automations/tools.js'
    );
    const fail = studioAutomationToolDefinitions.find((t) => t.name === 'studio.fail')!;
    await expect(
      fail.execute(
        { message: 'boom', automationId: 'a', stepId: 's' },
        { auth: toolAuth(), requestId: 'req-1' } as any,
        AbortSignal.timeout(5000)
      )
    ).rejects.toMatchObject({ code: 'STUDIO_VERIFY_FAILED' });

    const log = studioAutomationToolDefinitions.find((t) => t.name === 'studio.log')!;
    const out = (await log.execute(
      { message: 'hello', automationId: 'a', stepId: 's' },
      { auth: toolAuth(), requestId: 'req-1' } as any,
      AbortSignal.timeout(5000)
    )) as any;
    expect(out).toEqual({ logged: true });
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_AUTOMATION_LOG' })
    );
  });
});

  it('terminates a backward-jumping condition instead of looping forever', async () => {
    const conn = await createConn();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/automations',
      payload: {
        name: 'Looper',
        title: 'Looper',
        description: '',
        trigger: { kind: 'manual' },
        steps: [
          { id: 'l', kind: 'log', message: 'round' },
          { id: 'c', kind: 'condition', when: `{{inputs.x}} == 'y'`, then: 'l', else: 'l' },
        ],
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/studio/automations/${created.json().id}/test`,
      payload: { inputs: { x: 'y' } },
    });
    expect(res.statusCode).toBe(200);
    const steps = res.json().steps as any[];
    const last = steps[steps.length - 1];
    expect(last.status).toBe('failed');
    expect(last.detail.errorCode).toBe('STEP_LIMIT_EXCEEDED');
    // Bounded: 2 steps * 10 + 10, plus the limit marker.
    expect(steps.length).toBeLessThan(40);
  });
