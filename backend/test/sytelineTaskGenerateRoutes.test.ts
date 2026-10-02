/**
 * sytelineTaskGenerateRoutes.test.ts — POST /syteline-tasks/generate.
 *
 * - 200 breaks a goal into tasks via the model and creates each through the
 *   real createTask store path (runner picks them up identically)
 * - `count` caps how many tasks are created
 * - 502 with zero tasks created when the model output is malformed or fails
 *   schema validation (fail closed — never create from unparseable output)
 * - 403 AUTHORIZATION_FAILURE without the syteline:ui permission
 * - 403 FEATURE_DISABLED while SYTELINE_UI_ENABLED=false
 * - 400 for an invalid body
 * - unit tests for extractTaskListJson
 *
 * The model is replaced by overrideTaskGenerateFn; the DB is an in-memory
 * map behind the real createTask. VALIDATED IN CI; live generation
 * REQUIRES REAL INFRASTRUCTURE (a configured model).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {} as Record<string, unknown>,
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

import { config } from '../src/config.js';
import {
  extractTaskListJson,
  overrideTaskGenerateFn,
  sytelineTaskRoutes,
} from '../src/syteline/tasks/routes.js';
import type { SytelineTaskDoc } from '../src/syteline/tasks/taskTypes.js';

function authFor(userId: string, permissions: string[]): Record<string, unknown> {
  return {
    userId,
    tenantId: 'tenant-a',
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    roleId: 'role-1',
    roleName: 'User',
    permissions,
    sessionId: 'sess-1',
  };
}

const REQUESTER = () => authFor('user-req', ['syteline:ui']);
const NOPERM = () => authFor('user-basic', ['chat:create']);

let tasks: Map<string, SytelineTaskDoc>;

function collectionStub() {
  return {
    insertOne: async (doc: SytelineTaskDoc) => {
      tasks.set(doc._id, doc);
      return { acknowledged: true, insertedId: doc._id };
    },
  };
}

function setAuth(auth: Record<string, unknown>): void {
  for (const key of Object.keys(currentAuth)) delete currentAuth[key];
  Object.assign(currentAuth, auth);
}

async function buildServer() {
  const app = Fastify();
  await app.register(sytelineTaskRoutes);
  return app;
}

const GOOD_OUTPUT = JSON.stringify([
  { title: 'Inspect the PO form', goal: 'Open the purchase order form in TRN and record the current approval fields. Success: a written inventory of fields.' },
  { title: 'Verify the vendor list', goal: 'Check the vendor dropdown values against the approved vendor list. Success: every value matches.' },
]);

beforeEach(() => {
  tasks = new Map();
  getDbMock.mockReset();
  recordAuditMock.mockReset();
  overrideTaskGenerateFn(null);
  getDbMock.mockResolvedValue({ collection: (_name: string) => collectionStub() });
  (config as Record<string, unknown>).SYTELINE_UI_ENABLED = true;
  setAuth(REQUESTER());
});

describe('POST /syteline-tasks/generate', () => {
  it('creates one task per generated item through the real store path', async () => {
    overrideTaskGenerateFn(async () => GOOD_OUTPUT);
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Bring TRN purchase orders up to date' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tasks: Array<{ id: string; title: string }> };
    expect(body.tasks).toHaveLength(2);
    expect(body.tasks[0].title).toBe('Inspect the PO form');
    // Real path: docs carry tenant, requester, and the 'assigned' status the
    // runner claims.
    expect(tasks.size).toBe(2);
    for (const doc of tasks.values()) {
      expect(doc.tenantId).toBe('tenant-a');
      expect(doc.requesterUserId).toBe('user-req');
      expect(doc.status).toBe('assigned');
      expect(doc.authSnapshot.clearance).toBe('INTERNAL');
    }
    const createdAudits = recordAuditMock.mock.calls.filter(
      (c) => c[0].action === 'SYTELINE_TASK_CREATED',
    );
    expect(createdAudits).toHaveLength(2);
    const summary = recordAuditMock.mock.calls.find(
      (c) => c[0].action === 'SYTELINE_TASK_GENERATED',
    );
    expect(summary[0].metadata.created).toBe(2);
    await app.close();
  });

  it('caps created tasks at count', async () => {
    overrideTaskGenerateFn(async () =>
      JSON.stringify([
        { title: 'One', goal: 'First task goal.' },
        { title: 'Two', goal: 'Second task goal.' },
        { title: 'Three', goal: 'Third task goal.' },
      ]),
    );
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do three things', count: 2 },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(tasks.size).toBe(2);
    await app.close();
  });

  it('502s with zero tasks created when the model output is not JSON', async () => {
    overrideTaskGenerateFn(async () => 'Sure, here are some tasks: blah blah');
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things' },
    });
    expect(res.statusCode).toBe(502);
    expect(tasks.size).toBe(0);
    await app.close();
  });

  it('502s with zero tasks created when the output fails schema validation', async () => {
    overrideTaskGenerateFn(async () =>
      JSON.stringify([{ title: 'Missing the goal field' }]),
    );
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things' },
    });
    expect(res.statusCode).toBe(502);
    expect(tasks.size).toBe(0);
    await app.close();
  });

  it('502s when the model returns an empty array', async () => {
    overrideTaskGenerateFn(async () => '[]');
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things' },
    });
    expect(res.statusCode).toBe(502);
    expect(tasks.size).toBe(0);
    await app.close();
  });

  it('403s without the syteline:ui permission', async () => {
    setAuth(NOPERM());
    overrideTaskGenerateFn(async () => GOOD_OUTPUT);
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things' },
    });
    expect(res.statusCode).toBe(403);
    expect(tasks.size).toBe(0);
    await app.close();
  });

  it('403s while SYTELINE_UI_ENABLED=false', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_ENABLED = false;
    overrideTaskGenerateFn(async () => GOOD_OUTPUT);
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('FEATURE_DISABLED');
    await app.close();
  });

  it('400s for an invalid body', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: '' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400s for a count above the max', async () => {
    const app = await buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/syteline-tasks/generate',
      payload: { goal: 'Do things', count: 50 },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('extractTaskListJson', () => {
  it('extracts an array embedded in prose', () => {
    const out = extractTaskListJson(
      'Here you go:\n[{"title":"A","goal":"B"}]\nLet me know!',
    ) as Array<{ title: string }>;
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe('A');
  });

  it('throws 502 on non-JSON text', () => {
    expect(() => extractTaskListJson('no json here')).toThrowError(
      expect.objectContaining({ statusCode: 502 }),
    );
  });

  it('throws 502 on malformed JSON', () => {
    expect(() => extractTaskListJson('[{"title": oops]')).toThrowError(
      expect.objectContaining({ statusCode: 502 }),
    );
  });
});
