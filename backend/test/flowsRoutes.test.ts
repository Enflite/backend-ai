/**
 * flowsRoutes.test.ts — Flows HTTP API (ADR-022).
 *
 * - FLOWS_ENABLED=false (default) → 403 FEATURE_DISABLED on every route
 * - permission denial without flows:run / flows:manage (real requirePermission)
 * - full HTTP lifecycle: create → publish → alias → run → get → list → cancel
 * - alias revision guard: stale expectedRevision → 412
 * - idempotency: Idempotency-Key header → same run; different inputs → 409
 * - ?sync=true executes the run inline
 * - GET /flows/:name/pull returns the live frozen definition
 * - POST /flows/ensure converges flows/*.flow.json from the repo root
 * - pollRunEvents yields snapshot/done/error (the SSE streaming core)
 *
 * The real requirePermission middleware is used; requireAuth (session),
 * the DB, the audit sink, the chat SSE sender, and the runner's live-auth
 * and tool seams are mocked. VALIDATED IN CI.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { runToolCallMock } = vi.hoisted(() => ({ runToolCallMock: vi.fn() }));
const { createSseSenderMock } = vi.hoisted(() => ({ createSseSenderMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-admin',
    tenantId: 'tenant-a',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'admin@example.test',
    displayName: 'Admin',
    roleName: 'Admin',
    clearance: 'INTERNAL',
    permissions: ['flows:manage', 'flows:run', 'tenant:manage'],
  } as Record<string, unknown>,
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/syteline/tasks/taskRunner.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/tools/gateway.js', () => ({ runToolCall: runToolCallMock }));
vi.mock('../src/chat/routes.js', () => ({ createSseSender: createSseSenderMock }));

import { AppError } from '../src/errors.js';
import { config } from '../src/config.js';
import { flowRoutes, pollRunEvents } from '../src/flows/routes.js';
import { overrideFlowToolExecutor } from '../src/flows/flowRunner.js';
import type { FlowRunDoc } from '../src/flows/flowTypes.js';

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in (same seams as flowsRunner.test.ts)
// ---------------------------------------------------------------------------

function getDotted(doc: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    return (obj as Record<string, unknown>)[key];
  }, doc);
}

function applyDotted(doc: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let target: Record<string, any> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = parts[i + 1]!;
    if (typeof target[part] !== 'object' || target[part] === null) {
      target[part] = /^\d+$/.test(next) ? [] : {};
    }
    target = target[part];
  }
  target[parts[parts.length - 1]!] = value;
}

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = key.includes('.') ? getDotted(doc, key) : doc[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ('$nin' in value) return !(value.$nin as unknown[]).includes(actual);
      if ('$in' in value) return (value.$in as unknown[]).includes(actual);
      return false;
    }
    return actual === value;
  });
}

function memoryCollection(uniqueKeys: string[][] = []) {
  const docs = new Map<string, Record<string, any>>();
  const clone = (doc: Record<string, any>): Record<string, any> => structuredClone(doc);
  const uniqueViolated = (doc: Record<string, any>): boolean => {
    for (const keys of uniqueKeys) {
      const values = keys.map((key) => getDotted(doc, key));
      // Sparse: skip when any key is missing/undefined (e.g. no idempotencyKey).
      if (values.some((value) => value === undefined)) continue;
      for (const other of docs.values()) {
        if (other._id !== doc._id && keys.every((key, i) => getDotted(other, key) === values[i])) {
          return true;
        }
      }
    }
    return false;
  };
  const applyUpdate = (doc: Record<string, any>, update: Record<string, any>): void => {
    for (const [key, value] of Object.entries(update.$set ?? {})) applyDotted(doc, key, value);
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      const current = (getDotted(doc, key) as number | undefined) ?? 0;
      applyDotted(doc, key, current + (value as number));
    }
    for (const [key, value] of Object.entries(update.$push ?? {})) {
      const arr = (getDotted(doc, key) as unknown[] | undefined) ?? [];
      arr.push(value);
      applyDotted(doc, key, arr);
    }
  };
  return {
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      if (docs.has(doc._id) || uniqueViolated(doc)) {
        const error = new Error('duplicate key') as Error & { code: number };
        error.code = 11000;
        throw error;
      }
      docs.set(doc._id, clone(doc));
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of docs.values()) if (matches(doc, filter)) return clone(doc);
      return null;
    }),
    findOneAndUpdate: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(id, doc);
          return clone(doc);
        }
      }
      return null;
    }),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(id, doc);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    deleteOne: vi.fn(async (filter: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          docs.delete(id);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    }),
    find: vi.fn((filter: Record<string, any>) => {
      let rows = [...docs.values()].filter((doc) => matches(doc, filter)).map(clone);
      const cursor: any = {
        sort: (spec: Record<string, 1 | -1>) => {
          const entries = Object.entries(spec);
          rows.sort((a, b) => {
            for (const [key, dir] of entries) {
              const av: any = getDotted(a, key);
              const bv: any = getDotted(b, key);
              if (av === bv) continue;
              if (av === undefined) return 1;
              if (bv === undefined) return -1;
              return (av < bv ? -1 : 1) * dir;
            }
            return 0;
          });
          return cursor;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    }),
    createIndex: vi.fn(async () => 'idx'),
  };
}

let flowsColl: ReturnType<typeof memoryCollection>;
let runsColl: ReturnType<typeof memoryCollection>;

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(flowRoutes);
  return app;
}

const FLOW_DEF = {
  name: 'http-flow',
  title: 'HTTP Flow',
  description: '',
  inputs: {},
  outputs: {},
  steps: [{ id: 's1', kind: 'tool', tool: 'test.echo', params: {} }],
  onError: 'stop',
};

/** Create + publish + alias-live a flow through the HTTP API. */
async function seedLiveFlowHttp(app: any, name = 'http-flow'): Promise<void> {
  const create = await app.inject({
    method: 'POST',
    url: '/flows',
    payload: { ...FLOW_DEF, name },
  });
  expect(create.statusCode).toBe(201);
  const published = await app.inject({ method: 'POST', url: `/flows/${name}/versions` });
  expect(published.statusCode).toBe(201);
  const flow = await app.inject({ method: 'GET', url: `/flows/${name}` });
  const revision = flow.json().flow.revision;
  const aliased = await app.inject({
    method: 'POST',
    url: `/flows/${name}/alias`,
    payload: { version: 1, expectedRevision: revision },
  });
  expect(aliased.statusCode).toBe(200);
}

beforeEach(() => {
  vi.clearAllMocks();
  flowsColl = memoryCollection([['tenantId', 'name']]);
  runsColl = memoryCollection([['tenantId', 'idempotencyKey']]);
  getDbMock.mockResolvedValue({
    collection: (name: string) => {
      if (name === 'flows') return flowsColl;
      if (name === 'flow_runs') return runsColl;
      throw new Error(`unexpected collection: ${name}`);
    },
  });
  recordAuditMock.mockResolvedValue(undefined);
  liveRequesterAuthMock.mockImplementation(async () => ({ ...currentAuth }));
  createSseSenderMock.mockReturnValue({
    send: vi.fn(async () => true),
    ping: vi.fn(),
    backpressureAborted: false,
    pendingBytes: () => 0,
  });
  currentAuth.permissions = ['flows:manage', 'flows:run', 'tenant:manage'];
  currentAuth.userId = 'user-admin';
  config.FLOWS_ENABLED = false;
  config.FLOW_RUNNER_ENABLED = false;
  overrideFlowToolExecutor(async () => ({ ok: true, data: { echoed: true } }));
});

describe('feature flag', () => {
  it('returns 403 FEATURE_DISABLED on every route when FLOWS_ENABLED=false', async () => {
    const app = await buildApp();
    const cases = [
      { method: 'POST', url: '/flows', payload: FLOW_DEF },
      { method: 'GET', url: '/flows' },
      { method: 'GET', url: '/flows/x' },
      { method: 'PUT', url: '/flows/x', payload: FLOW_DEF },
      { method: 'DELETE', url: '/flows/x' },
      { method: 'POST', url: '/flows/x/versions' },
      { method: 'GET', url: '/flows/x/versions' },
      { method: 'POST', url: '/flows/x/alias', payload: { version: 1, expectedRevision: 1 } },
      { method: 'POST', url: '/flows/ensure' },
      { method: 'GET', url: '/flows/x/pull' },
      { method: 'POST', url: '/flows/x/runs', payload: {} },
      { method: 'GET', url: '/flows/runs' },
      { method: 'GET', url: '/flows/runs/abc' },
      { method: 'POST', url: '/flows/runs/abc/cancel' },
    ];
    for (const c of cases) {
      const res = await app.inject({ method: c.method as any, url: c.url, payload: (c as any).payload });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(res.json().error.code, `${c.method} ${c.url}`).toBe('FEATURE_DISABLED');
    }
  });
});

describe('authorization', () => {
  it('denies run creation without flows:run', async () => {
    config.FLOWS_ENABLED = true;
    currentAuth.permissions = ['flows:manage'];
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/flows/x/runs', payload: {} });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });

  it('denies flow creation without flows:manage', async () => {
    config.FLOWS_ENABLED = true;
    currentAuth.permissions = ['flows:run'];
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/flows', payload: FLOW_DEF });
    expect(res.statusCode).toBe(403);
  });

  it('a run is visible only to its requester or an admin', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    await seedLiveFlowHttp(app);
    const created = await app.inject({ method: 'POST', url: '/flows/http-flow/runs', payload: {} });
    const runId = created.json().run.id;
    // Another non-admin user cannot see it (404, not 403 — no existence leak).
    currentAuth.userId = 'user-other';
    currentAuth.permissions = ['flows:run'];
    const res = await app.inject({ method: 'GET', url: `/flows/runs/${runId}` });
    expect(res.statusCode).toBe(404);
  });
});

describe('flow lifecycle over HTTP', () => {
  it('create → publish → alias → run → get → list → cancel', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();

    const created = await app.inject({ method: 'POST', url: '/flows', payload: FLOW_DEF });
    expect(created.statusCode).toBe(201);
    expect(created.json().flow.name).toBe('http-flow');

    const duplicate = await app.inject({ method: 'POST', url: '/flows', payload: FLOW_DEF });
    expect(duplicate.statusCode).toBe(409);

    const listed = await app.inject({ method: 'GET', url: '/flows' });
    expect(listed.json().flows).toHaveLength(1);

    const published = await app.inject({ method: 'POST', url: '/flows/http-flow/versions' });
    expect(published.statusCode).toBe(201);
    expect(published.json().version.version).toBe(1);
    expect(published.json().version.definitionHash).toMatch(/^[a-f0-9]{64}$/);

    // Publish requires an existing flow.
    const missing = await app.inject({ method: 'POST', url: '/flows/nope/versions' });
    expect(missing.statusCode).toBe(404);

    const flow = await app.inject({ method: 'GET', url: '/flows/http-flow' });
    const revision = flow.json().flow.revision;
    const aliased = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/alias',
      payload: { version: 1, expectedRevision: revision },
    });
    expect(aliased.statusCode).toBe(200);
    expect(aliased.json().flow.liveVersion).toBe(1);

    // Stale revision → 412.
    const stale = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/alias',
      payload: { version: 1, expectedRevision: revision },
    });
    expect(stale.statusCode).toBe(412);
    expect(stale.json().error.code).toBe('REVISION_MISMATCH');

    // Runs are async by default (202) while the runner is disabled.
    const runRes = await app.inject({ method: 'POST', url: '/flows/http-flow/runs', payload: { inputs: {} } });
    expect(runRes.statusCode).toBe(202);
    const runId = runRes.json().run.id;
    expect(runRes.json().run.status).toBe('queued');

    const fetched = await app.inject({ method: 'GET', url: `/flows/runs/${runId}` });
    expect(fetched.json().run.id).toBe(runId);

    const runs = await app.inject({ method: 'GET', url: '/flows/runs?flowName=http-flow' });
    expect(runs.json().runs).toHaveLength(1);

    const cancelled = await app.inject({ method: 'POST', url: `/flows/runs/${runId}/cancel` });
    expect(cancelled.statusCode).toBe(200);
    expect(cancelled.json().run.status).toBe('cancelled');

    const again = await app.inject({ method: 'POST', url: `/flows/runs/${runId}/cancel` });
    expect(again.statusCode).toBe(409);
  });

  it('rejects invalid definitions with 400', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/flows',
      payload: { ...FLOW_DEF, steps: [{ id: 's1', kind: 'teleport' }] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_FLOW_DEFINITION');
  });

  it('pull returns the live frozen definition', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    await seedLiveFlowHttp(app);
    const pulled = await app.inject({ method: 'GET', url: '/flows/http-flow/pull' });
    expect(pulled.statusCode).toBe(200);
    expect(pulled.json().version).toBe(1);
    expect(pulled.json().definition.steps).toHaveLength(1);
    expect(pulled.json().definitionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('pull on a flow with no live version is a 400', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/flows', payload: FLOW_DEF });
    await app.inject({ method: 'POST', url: '/flows/http-flow/versions' });
    const pulled = await app.inject({ method: 'GET', url: '/flows/http-flow/pull' });
    expect(pulled.statusCode).toBe(400);
    expect(pulled.json().error.code).toBe('NO_LIVE_VERSION');
  });
});

describe('run idempotency over HTTP', () => {
  it('repeating an Idempotency-Key returns the same run; different inputs → 409', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    await seedLiveFlowHttp(app);

    const first = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/runs',
      headers: { 'idempotency-key': 'idem-1' },
      payload: { inputs: {} },
    });
    expect(first.statusCode).toBe(202);
    const runId = first.json().run.id;

    const second = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/runs',
      headers: { 'idempotency-key': 'idem-1' },
      payload: { inputs: {} },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().duplicate).toBe(true);
    expect(second.json().run.id).toBe(runId);

    const conflict = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/runs',
      headers: { 'idempotency-key': 'idem-1' },
      payload: { inputs: { unexpected: true } },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });
});

describe('sync runs', () => {
  it('?sync=true executes the run inline to completion', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    await seedLiveFlowHttp(app);
    const res = await app.inject({
      method: 'POST',
      url: '/flows/http-flow/runs?sync=true',
      payload: { inputs: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().run.status).toBe('completed');
    expect(res.json().run.steps[0].status).toBe('ok');
    // Step logs carry shapes, never values.
    expect(res.json().run.steps[0].outputShape).toBe('object{keys:[echoed]}');
  });
});

describe('ensure from repo', () => {
  it('converges flows/*.flow.json: create, update on change, report errors', async () => {
    config.FLOWS_ENABLED = true;
    const app = await buildApp();
    // POST /flows/ensure reads <cwd>/flows/*.flow.json (first candidate).
    const dir = join(process.cwd(), 'flows');
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(
        join(dir, 'repo-flow.flow.json'),
        JSON.stringify({ ...FLOW_DEF, name: 'repo-flow', title: 'Repo Flow' }),
      );
      writeFileSync(join(dir, 'broken.flow.json'), '{ not json');
      const first = await app.inject({ method: 'POST', url: '/flows/ensure' });
      expect(first.statusCode).toBe(200);
      expect(first.json().created).toEqual(['repo-flow']);
      expect(first.json().errors).toHaveLength(1);
      expect(first.json().errors[0].file).toBe('broken.flow.json');

      const second = await app.inject({ method: 'POST', url: '/flows/ensure' });
      expect(second.json().unchanged).toEqual(['repo-flow']);

      writeFileSync(
        join(dir, 'repo-flow.flow.json'),
        JSON.stringify({ ...FLOW_DEF, name: 'repo-flow', title: 'Repo Flow v2' }),
      );
      const third = await app.inject({ method: 'POST', url: '/flows/ensure' });
      expect(third.json().updated).toEqual(['repo-flow']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('pollRunEvents', () => {
  it('yields snapshots on change and done at terminal', async () => {
    const states: Array<Partial<FlowRunDoc> & { _id: string }> = [
      { _id: 'r1', status: 'queued', steps: [] },
      { _id: 'r1', status: 'running', steps: [] },
      { _id: 'r1', status: 'completed', steps: [] },
    ];
    let calls = 0;
    const events: Array<{ type: string; payload: unknown }> = [];
    for await (const event of pollRunEvents(
      async () => {
        const state = states[Math.min(calls, states.length - 1)]!;
        calls += 1;
        return state as FlowRunDoc;
      },
      new AbortController().signal,
      1,
    )) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(['snapshot', 'snapshot', 'snapshot', 'done']);
    expect((events[3]!.payload as { status: string }).status).toBe('completed');
  });

  it('yields error when the run disappears', async () => {
    const events: Array<{ type: string }> = [];
    for await (const event of pollRunEvents(async () => null, new AbortController().signal, 1)) {
      events.push(event);
    }
    expect(events.map((e) => e.type)).toEqual(['error']);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const events: Array<{ type: string }> = [];
    for await (const event of pollRunEvents(
      async () => ({ _id: 'r1', status: 'running', steps: [] }) as unknown as FlowRunDoc,
      controller.signal,
      1,
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(0);
  });
});
