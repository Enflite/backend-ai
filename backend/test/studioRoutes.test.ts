/**
 * studioRoutes.test.ts — Studio HTTP API.
 *
 * - permission denial without studio:run / studio:manage (real requirePermission)
 * - connection lifecycle: create (+ probe on save) → get → list → test → patch → delete
 * - the token never appears in any response or audit payload
 * - catalog listing with per-connection support evaluation
 * - single-action test: real request shape, truncated body, duration, audit
 * - honest failures: unknown connection → 409, unknown action → 404,
 *   unprobed action → 409, write action → 409 without ever executing
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
    permissions: ['studio:manage', 'studio:run', 'tenant:manage'],
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
import { makeInMemoryDb } from './helpers/studioMongo.js';

const TEST_KEY = randomBytes(32).toString('hex');
const UPSTREAM = 'https://upstream.test';

let mem: ReturnType<typeof makeInMemoryDb>;
let app: ReturnType<typeof Fastify>;
let fetchCalls: Array<{ url: string; method: string; auth: string | null }>;

const savedConfig = {
  CREDENTIAL_STORE_KEY: config.CREDENTIAL_STORE_KEY,
  SYTELINE_BASE_URL: config.SYTELINE_BASE_URL,
  SYTELINE_API_TOKEN: config.SYTELINE_API_TOKEN,
};

function fakeUpstream() {
  fetchCalls = [];
  return vi.fn(async (url: string, init?: RequestInit) => {
    fetchCalls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      auth: new Headers(init?.headers).get('authorization'),
    });
    const method = String(init?.method ?? 'GET');
    if (method === 'OPTIONS') return new Response('{}', { status: 405 });
    if (String(url).startsWith(`${UPSTREAM}/api/`)) {
      return new Response(JSON.stringify({ ok: true, echoed: String(url) }), { status: 200 });
    }
    return new Response('not found', { status: 404 });
  });
}

beforeEach(async () => {
  mem = makeInMemoryDb();
  getDbMock.mockImplementation((...args: unknown[]) => (mem.getDbMock as any)(...args));
  recordAuditMock.mockResolvedValue(undefined);
  vi.stubGlobal('fetch', fakeUpstream());
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
  (config as Record<string, unknown>).SYTELINE_BASE_URL = '';
  (config as Record<string, unknown>).SYTELINE_API_TOKEN = '';
  currentAuth.permissions = ['studio:manage', 'studio:run', 'tenant:manage'];

  app = Fastify();
  app.setErrorHandler((error: unknown, _req: any, reply: any) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  await app.register(studioRoutes, { prefix: '/api/v1' });
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.close();
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = savedConfig.CREDENTIAL_STORE_KEY;
  (config as Record<string, unknown>).SYTELINE_BASE_URL = savedConfig.SYTELINE_BASE_URL;
  (config as Record<string, unknown>).SYTELINE_API_TOKEN = savedConfig.SYTELINE_API_TOKEN;
});

async function createConn(name = 'TRN') {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/studio/connections',
    payload: { name, environment: 'TRN', baseUrl: UPSTREAM, token: 'conn-token-1' },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('permissions', () => {
  it('denies reads without studio:run', async () => {
    currentAuth.permissions = [];
    const res = await app.inject({ method: 'GET', url: '/api/v1/studio/actions' });
    expect(res.statusCode).toBe(403);
  });

  it('denies connection writes without studio:manage', async () => {
    currentAuth.permissions = ['studio:run'];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/connections',
      payload: { name: 'X', environment: 'TRN', baseUrl: UPSTREAM, token: 't' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('connections', () => {
  it('creates with a probe on save and never leaks the token', async () => {
    const body = await createConn();
    expect(body.id).toBeDefined();
    expect(body.name).toBe('TRN');
    expect(body.probeSummary.reachable).toBe(true);
    expect(body.probeSummary.ok).toBe(7);
    expect(body.probeSummary.unsupported).toBe(4);
    // 11 probe requests went out (7 GET + 4 OPTIONS).
    expect(fetchCalls).toHaveLength(11);
    expect(fetchCalls.every((c) => c.auth === 'Bearer conn-token-1')).toBe(true);
    // No token in the response or in audit payloads.
    expect(JSON.stringify(body)).not.toContain('conn-token-1');
    for (const call of recordAuditMock.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('conn-token-1');
    }
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_CONNECTION_CREATED', success: true })
    );
    // And the probe persisted on the doc.
    const docs = mem.store['studio_connections']!;
    expect(docs[0]!.probe.operations).toHaveLength(11);
    expect(JSON.stringify(docs[0]!)).not.toContain('conn-token-1');
  });

  it('409s on duplicate names', async () => {
    await createConn();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/connections',
      payload: { name: 'trn', environment: 'PRD', baseUrl: UPSTREAM, token: 't2' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('lists the env-backed default first when configured', async () => {
    (config as Record<string, unknown>).SYTELINE_BASE_URL = UPSTREAM;
    (config as Record<string, unknown>).SYTELINE_API_TOKEN = 'env-token';
    await createConn();
    const res = await app.inject({ method: 'GET', url: '/api/v1/studio/connections' });
    const items = res.json().items;
    expect(items).toHaveLength(2);
    expect(items[0].id).toBe('default');
    expect(items[0].envBacked).toBe(true);
    expect(JSON.stringify(items)).not.toContain('env-token');
  });

  it('gets one connection and 404s on unknown', async () => {
    const created = await createConn();
    const res = await app.inject({ method: 'GET', url: `/api/v1/studio/connections/${created.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().name).toBe('TRN');
    const missing = await app.inject({ method: 'GET', url: '/api/v1/studio/connections/nope' });
    expect(missing.statusCode).toBe(404);
  });

  it('tests a connection and persists the probe', async () => {
    const created = await createConn();
    // Wipe the stored probe to prove /test re-probes.
    mem.store['studio_connections']![0]!.probe = undefined;
    const before = fetchCalls.length;
    const res = await app.inject({ method: 'POST', url: `/api/v1/studio/connections/${created.id}/test` });
    expect(res.statusCode).toBe(200);
    expect(res.json().probeSummary.reachable).toBe(true);
    expect(fetchCalls.length - before).toBe(11);
    expect(mem.store['studio_connections']![0]!.probe.operations).toHaveLength(11);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_CONNECTION_TESTED', success: true })
    );
  });

  it('409s the test on an unknown connection id', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/studio/connections/nope/test' });
    expect(res.statusCode).toBe(409);
  });

  it('patches and deletes', async () => {
    const created = await createConn();
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/v1/studio/connections/${created.id}`,
      payload: { environment: 'PRD' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().environment).toBe('PRD');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_CONNECTION_UPDATED' })
    );

    const deleted = await app.inject({ method: 'DELETE', url: `/api/v1/studio/connections/${created.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_CONNECTION_DELETED' })
    );
    const again = await app.inject({ method: 'DELETE', url: `/api/v1/studio/connections/${created.id}` });
    expect(again.statusCode).toBe(404);
  });
});

describe('catalog', () => {
  it('lists all actions without a connection (all reads unprobed)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/studio/actions' });
    expect(res.statusCode).toBe(200);
    const items = res.json().items;
    expect(items).toHaveLength(11);
    const read = items.find((i: any) => i.id === 'syteline.getItem');
    expect(read.supported).toBe(false);
    expect(read.supportReason).toMatch(/test the connection/i);
    const write = items.find((i: any) => i.id === 'syteline.record.create');
    expect(write.supported).toBe(false);
    expect(write.destructive).toBe(true);
  });

  it('evaluates support against a probed connection', async () => {
    const created = await createConn();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/studio/actions?connectionId=${created.id}`,
    });
    const items = res.json().items;
    const read = items.find((i: any) => i.id === 'syteline.getItem');
    expect(read.supported).toBe(true);
    const write = items.find((i: any) => i.id === 'syteline.record.create');
    expect(write.supported).toBe(false);
    expect(write.supportReason).toMatch(/pending upstream support/);
  });

  it('evaluates the env-backed default with a live probe', async () => {
    (config as Record<string, unknown>).SYTELINE_BASE_URL = UPSTREAM;
    (config as Record<string, unknown>).SYTELINE_API_TOKEN = 'env-token';
    const res = await app.inject({ method: 'GET', url: '/api/v1/studio/actions?connectionId=default' });
    const items = res.json().items;
    expect(items.find((i: any) => i.id === 'syteline.getItem').supported).toBe(true);
    expect(items.find((i: any) => i.id === 'syteline.ido.invoke').supported).toBe(false);
  });
});

describe('single-action test', () => {
  it('executes against the real upstream and returns request/response inspection', async () => {
    const created = await createConn();
    fetchCalls = [];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: {
        connectionId: created.id,
        actionId: 'syteline.getItem',
        params: { item: 'WIDGET-1', site: 'MAIN' },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.connectionId).toBe(created.id);
    expect(body.actionId).toBe('syteline.getItem');
    expect(body.request.method).toBe('GET');
    expect(body.request.url).toBe(`${UPSTREAM}/api/items?item=WIDGET-1&site=MAIN`);
    expect(body.request.params).toEqual({ item: 'WIDGET-1', site: 'MAIN' });
    expect(body.response.status).toBe(200);
    expect(body.response.bodyTruncated.truncated).toBe(false);
    expect(body.response.bodyTruncated.preview).toContain('WIDGET-1');
    expect(typeof body.response.durationMs).toBe('number');
    expect(body.executedAt).toBeDefined();
    // Exactly one upstream request: the action itself. The token rode the header.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]!.auth).toBe('Bearer conn-token-1');
    // No token anywhere in the response or audit.
    expect(JSON.stringify(body)).not.toContain('conn-token-1');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'STUDIO_ACTION_TESTED', success: true })
    );
  });

  it('truncates large response bodies', async () => {
    const created = await createConn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        fetchCalls.push({ url: String(url), method: String(init?.method ?? 'GET'), auth: null });
        return new Response('x'.repeat(100000), { status: 200 });
      })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: created.id, actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json().response.bodyTruncated;
    expect(preview.truncated).toBe(true);
    expect(preview.preview.length).toBe(16 * 1024);
  });

  it('409s on an unknown connection', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: 'nope', actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
    });
    expect(res.statusCode).toBe(409);
  });

  it('404s on an unknown action', async () => {
    const created = await createConn();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: created.id, actionId: 'syteline.nope', params: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('409s on an unprobed connection without executing', async () => {
    const created = await createConn();
    mem.store['studio_connections']![0]!.probe = undefined;
    fetchCalls = [];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: created.id, actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STUDIO_ACTION_UNPROBED');
    expect(fetchCalls).toHaveLength(0);
  });

  it('409s on a write action without ever executing it', async () => {
    const created = await createConn();
    fetchCalls = [];
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: {
        connectionId: created.id,
        actionId: 'syteline.record.create',
        params: { collection: 'items', fields: { item: 'X' } },
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('STUDIO_ACTION_UNSUPPORTED');
    // No upstream request was made — a fake "success" is impossible.
    expect(fetchCalls).toHaveLength(0);
  });

  it('400s on invalid params', async () => {
    const created = await createConn();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: created.id, actionId: 'syteline.getItem', params: { item: 'A' } },
    });
    expect(res.statusCode).toBe(400);
  });

  it('502s honestly when the upstream is unreachable', async () => {
    const created = await createConn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/studio/actions/test',
      payload: { connectionId: created.id, actionId: 'syteline.getItem', params: { item: 'A', site: 'MAIN' } },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('STUDIO_UPSTREAM_UNREACHABLE');
  });
});
