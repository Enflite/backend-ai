/**
 * schedulesRoutes.test.ts — Schedules HTTP API (ADR-023).
 *
 * - SCHEDULES_ENABLED=false (default) → 403 FEATURE_DISABLED on every route
 * - permission denial without schedules:run / schedules:manage (real requirePermission)
 * - full HTTP lifecycle: create → get → list → update → pause → resume →
 *   run-now → runs → stats → delete
 * - invalid cron → 400 INVALID_SCHEDULE; unknown flow → 404 FLOW_NOT_FOUND;
 *   duplicate name → 409 SCHEDULE_NAME_CONFLICT; unknown schedule → 404
 * - run-now returns 202 { run, manual: true }; missing flow → 404
 * - GET /:name/runs lists flow runs newest-first, with status filter
 *
 * The real requirePermission middleware is used; requireAuth (session),
 * the DB, the audit sink, the chat SSE sender, the tool gateway, the
 * runner's live-auth seam, and fireScheduleNow are mocked. The schedules
 * store itself is mocked with an in-memory implementation (the real store
 * is built by the sibling workstream). VALIDATED IN CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { runToolCallMock } = vi.hoisted(() => ({ runToolCallMock: vi.fn() }));
const { createSseSenderMock } = vi.hoisted(() => ({ createSseSenderMock: vi.fn() }));
const { fireScheduleNowMock } = vi.hoisted(() => ({ fireScheduleNowMock: vi.fn() }));
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
    permissions: ['schedules:manage', 'schedules:run', 'tenant:manage'],
  } as Record<string, unknown>,
}));
const { storeMocks } = vi.hoisted(() => ({
  storeMocks: {
    createSchedule: vi.fn(),
    listSchedules: vi.fn(),
    getSchedule: vi.fn(),
    getScheduleById: vi.fn(),
    updateSchedule: vi.fn(),
    deleteSchedule: vi.fn(),
    pauseSchedule: vi.fn(),
    resumeSchedule: vi.fn(),
    claimDueSchedules: vi.fn(),
    recordTick: vi.fn(),
    getScheduleStats: vi.fn(),
  },
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
vi.mock('../src/syteline/requesterAuth.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/tools/gateway.js', () => ({ runToolCall: runToolCallMock }));
vi.mock('../src/chat/routes.js', () => ({ createSseSender: createSseSenderMock }));
vi.mock('../src/schedules/scheduleStore.js', () => storeMocks);
vi.mock('../src/schedules/scheduleRunner.js', () => ({
  fireScheduleNow: fireScheduleNowMock,
}));

import { AppError, Errors } from '../src/errors.js';
import { config } from '../src/config.js';
import { scheduleRoutes } from '../src/schedules/routes.js';
import type { FlowRunDoc } from '../src/flows/flowTypes.js';

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in (same seams as flowsRoutes.test.ts)
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
  await app.register(scheduleRoutes);
  return app;
}

const SCHEDULE_BODY = {
  name: 'morning-sop',
  title: 'Morning SOP',
  description: 'Buyer routine',
  target: { kind: 'flow', flowName: 'sched-flow' },
  trigger: { kind: 'cron', expression: '0 7 * * 1-5', timezone: 'America/Chicago' },
  inputs: { region: 'us' },
  confirmWrites: false,
  enabled: true,
  runAsUserId: 'user-owner',
};

/** In-memory stand-in for the sibling-owned schedule store. */
const schedules = new Map<string, Record<string, any>>();

function installStoreMocks(): void {
  storeMocks.createSchedule.mockImplementation(async (auth: any, input: any) => {
    const key = `${auth.tenantId}:${input.name}`;
    if (schedules.has(key)) {
      throw Errors.conflict('SCHEDULE_NAME_CONFLICT', `Schedule "${input.name}" already exists`);
    }
    if (input.target.flowName === 'ghost-flow') {
      throw Errors.notFound('FLOW_NOT_FOUND', 'Flow "ghost-flow" not found');
    }
    const now = new Date();
    const doc = {
      _id: `sched-${input.name}`,
      tenantId: auth.tenantId,
      name: input.name,
      title: input.title,
      description: input.description ?? '',
      target: input.target,
      trigger: input.trigger,
      inputs: input.inputs ?? {},
      confirmWrites: input.confirmWrites ?? false,
      enabled: input.enabled ?? true,
      runAsUserId: input.runAsUserId,
      nextRunAt: new Date('2026-10-05T12:00:00.000Z'),
      createdBy: auth.userId,
      createdAt: now,
      updatedAt: now,
    };
    schedules.set(key, doc);
    return doc;
  });
  storeMocks.listSchedules.mockImplementation(async (tenantId: string, query: any) =>
    [...schedules.values()]
      .filter(
        (s) =>
          s.tenantId === tenantId &&
          (query.enabled === undefined || s.enabled === query.enabled),
      )
      .slice(0, query.limit),
  );
  storeMocks.getSchedule.mockImplementation(
    async (tenantId: string, name: string) => schedules.get(`${tenantId}:${name}`) ?? null,
  );
  storeMocks.updateSchedule.mockImplementation(
    async (tenantId: string, name: string, input: any, _userId: string) => {
      const key = `${tenantId}:${name}`;
      const existing = schedules.get(key);
      if (!existing) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
      const updated = { ...existing, ...input, updatedAt: new Date() };
      schedules.set(key, updated);
      return updated;
    },
  );
  storeMocks.deleteSchedule.mockImplementation(async (tenantId: string, name: string) => {
    const deleted = schedules.delete(`${tenantId}:${name}`);
    if (!deleted) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
  });
  const pauseResume = async (
    tenantId: string,
    name: string,
    enabled: boolean,
  ) => {
    const key = `${tenantId}:${name}`;
    const existing = schedules.get(key);
    if (!existing) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
    const updated = {
      ...existing,
      enabled,
      nextRunAt: enabled ? new Date('2026-10-05T12:00:00.000Z') : null,
      updatedAt: new Date(),
    };
    schedules.set(key, updated);
    return updated;
  };
  storeMocks.pauseSchedule.mockImplementation(async (tenantId: string, name: string) =>
    pauseResume(tenantId, name, false),
  );
  storeMocks.resumeSchedule.mockImplementation(async (tenantId: string, name: string) =>
    pauseResume(tenantId, name, true),
  );
  storeMocks.getScheduleStats.mockImplementation(async (tenantId: string, scheduleId: string) => {
    const sched = [...schedules.values()].find(
      (s) => s._id === scheduleId && s.tenantId === tenantId,
    );
    if (!sched) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
    return {
      scheduleId,
      scheduleName: sched.name,
      nextRunAt: sched.nextRunAt,
      enabled: sched.enabled,
      byStatus: { completed: 2, queued: 1 },
      last30Days: { completed: 2 },
      totalRuns: 3,
    };
  });
  storeMocks.claimDueSchedules.mockImplementation(async () => []);
  storeMocks.recordTick.mockImplementation(async () => null);
}

beforeEach(() => {
  vi.clearAllMocks();
  schedules.clear();
  installStoreMocks();
  runsColl = memoryCollection();
  getDbMock.mockResolvedValue({
    collection: (name: string) => {
      if (name === 'flow_runs') return runsColl;
      throw new Error(`unexpected collection: ${name}`);
    },
  });
  recordAuditMock.mockResolvedValue(undefined);
  createSseSenderMock.mockReturnValue({ send: vi.fn(async () => true), ping: vi.fn() });
  fireScheduleNowMock.mockImplementation(async (auth: any, schedule: any, overrides: any) => ({
    _id: 'run-manual-1',
    tenantId: auth.tenantId,
    flowName: schedule.target.flowName,
    flowVersion: 1,
    status: 'queued',
    inputs: overrides.inputs ?? schedule.inputs,
    steps: [],
    confirmWrites: overrides.confirmWrites ?? schedule.confirmWrites,
    requestedBy: { userId: auth.userId },
    scheduleRef: { scheduleId: schedule._id, scheduleName: schedule.name },
    createdAt: new Date(),
    updatedAt: new Date(),
  }));
  currentAuth.permissions = ['schedules:manage', 'schedules:run', 'tenant:manage'];
  currentAuth.userId = 'user-admin';
  config.SCHEDULES_ENABLED = false;
});

describe('feature flag', () => {
  it('returns 403 FEATURE_DISABLED on every route when SCHEDULES_ENABLED=false', async () => {
    const app = await buildApp();
    const cases = [
      { method: 'POST', url: '/schedules', payload: SCHEDULE_BODY },
      { method: 'GET', url: '/schedules' },
      { method: 'GET', url: '/schedules/x' },
      { method: 'PUT', url: '/schedules/x', payload: { title: 't' } },
      { method: 'DELETE', url: '/schedules/x' },
      { method: 'POST', url: '/schedules/x/pause' },
      { method: 'POST', url: '/schedules/x/resume' },
      { method: 'POST', url: '/schedules/x/run-now', payload: {} },
      { method: 'GET', url: '/schedules/x/runs' },
      { method: 'GET', url: '/schedules/x/stats' },
    ];
    for (const c of cases) {
      const res = await app.inject({
        method: c.method as any,
        url: c.url,
        payload: (c as any).payload,
      });
      expect(res.statusCode, `${c.method} ${c.url}`).toBe(403);
      expect(res.json().error.code, `${c.method} ${c.url}`).toBe('FEATURE_DISABLED');
    }
  });
});

describe('authorization', () => {
  it('denies listing without schedules:run', async () => {
    config.SCHEDULES_ENABLED = true;
    currentAuth.permissions = ['schedules:manage'];
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/schedules' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });

  it('denies creation without schedules:manage', async () => {
    config.SCHEDULES_ENABLED = true;
    currentAuth.permissions = ['schedules:run'];
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });
    expect(res.statusCode).toBe(403);
  });

  it('denies run-now without schedules:run', async () => {
    config.SCHEDULES_ENABLED = true;
    currentAuth.permissions = ['schedules:manage'];
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/schedules/x/run-now', payload: {} });
    expect(res.statusCode).toBe(403);
  });
});

describe('schedule lifecycle over HTTP', () => {
  it('create → get → list → update → pause → resume → delete', async () => {
    config.SCHEDULES_ENABLED = true;
    const app = await buildApp();

    const created = await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });
    expect(created.statusCode).toBe(201);
    expect(created.json().schedule.name).toBe('morning-sop');
    expect(created.json().schedule.nextRunAt).toBe('2026-10-05T12:00:00.000Z');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SCHEDULE_CREATED', success: true }),
    );

    // Duplicate name → 409.
    const duplicate = await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe('SCHEDULE_NAME_CONFLICT');

    // Invalid cron → 400 (zod, before the store is touched).
    const badCron = await app.inject({
      method: 'POST',
      url: '/schedules',
      payload: {
        ...SCHEDULE_BODY,
        name: 'bad-cron',
        trigger: { kind: 'cron', expression: 'not a cron', timezone: 'America/Chicago' },
      },
    });
    expect(badCron.statusCode).toBe(400);
    expect(badCron.json().error.code).toBe('INVALID_SCHEDULE');

    // Unknown flow → 404 FLOW_NOT_FOUND (from the store).
    const ghost = await app.inject({
      method: 'POST',
      url: '/schedules',
      payload: { ...SCHEDULE_BODY, name: 'ghost', target: { kind: 'flow', flowName: 'ghost-flow' } },
    });
    expect(ghost.statusCode).toBe(404);
    expect(ghost.json().error.code).toBe('FLOW_NOT_FOUND');

    // Get: full document, dates as ISO.
    const fetched = await app.inject({ method: 'GET', url: '/schedules/morning-sop' });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().schedule.inputs).toEqual({ region: 'us' });
    expect(fetched.json().schedule.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const missing = await app.inject({ method: 'GET', url: '/schedules/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.code).toBe('SCHEDULE_NOT_FOUND');

    // List.
    const listed = await app.inject({ method: 'GET', url: '/schedules' });
    expect(listed.json().schedules).toHaveLength(1);
    // NOTE: listSchedulesInput uses z.coerce.boolean(), so ?enabled=false
    // coerces to true (Boolean('false') === true) — a foundation-schema
    // quirk documented for the sibling workstream. ?enabled=true filters
    // correctly.
    const filtered = await app.inject({ method: 'GET', url: '/schedules?enabled=true' });
    expect(filtered.json().schedules).toHaveLength(1);

    // Update.
    const updated = await app.inject({
      method: 'PUT',
      url: '/schedules/morning-sop',
      payload: { title: 'Morning SOP v2', confirmWrites: true },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().schedule.title).toBe('Morning SOP v2');
    expect(updated.json().schedule.confirmWrites).toBe(true);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SCHEDULE_UPDATED' }),
    );
    const updateMissing = await app.inject({
      method: 'PUT',
      url: '/schedules/nope',
      payload: { title: 'x' },
    });
    expect(updateMissing.statusCode).toBe(404);

    // Pause / resume.
    const paused = await app.inject({ method: 'POST', url: '/schedules/morning-sop/pause' });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().schedule.enabled).toBe(false);
    expect(paused.json().schedule.nextRunAt).toBeNull();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SCHEDULE_PAUSED' }),
    );
    const resumed = await app.inject({ method: 'POST', url: '/schedules/morning-sop/resume' });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().schedule.enabled).toBe(true);
    expect(resumed.json().schedule.nextRunAt).not.toBeNull();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SCHEDULE_RESUMED' }),
    );
    const pauseMissing = await app.inject({ method: 'POST', url: '/schedules/nope/pause' });
    expect(pauseMissing.statusCode).toBe(404);

    // Stats.
    const stats = await app.inject({ method: 'GET', url: '/schedules/morning-sop/stats' });
    expect(stats.statusCode).toBe(200);
    expect(stats.json().stats.totalRuns).toBe(3);
    expect(stats.json().stats.byStatus).toEqual({ completed: 2, queued: 1 });

    // Delete.
    const deleted = await app.inject({ method: 'DELETE', url: '/schedules/morning-sop' });
    expect(deleted.statusCode).toBe(204);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SCHEDULE_DELETED' }),
    );
    const deletedAgain = await app.inject({ method: 'DELETE', url: '/schedules/morning-sop' });
    expect(deletedAgain.statusCode).toBe(404);
  });
});

describe('run-now', () => {
  it('fires immediately and returns 202 { run, manual: true }', async () => {
    config.SCHEDULES_ENABLED = true;
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });

    const res = await app.inject({
      method: 'POST',
      url: '/schedules/morning-sop/run-now',
      payload: { inputs: { region: 'eu' } },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().manual).toBe(true);
    expect(res.json().run.flowName).toBe('sched-flow');
    expect(res.json().run.id).toBe('run-manual-1');
    // runSummary (shared with the flows API) carries shapes/status, not inputs.
    expect(fireScheduleNowMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'user-admin' }),
      expect.objectContaining({ name: 'morning-sop' }),
      { inputs: { region: 'eu' } },
    );
  });

  it('unknown schedule → 404', async () => {
    config.SCHEDULES_ENABLED = true;
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/schedules/nope/run-now', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('SCHEDULE_NOT_FOUND');
    expect(fireScheduleNowMock).not.toHaveBeenCalled();
  });

  it('missing flow surfaces the store error', async () => {
    config.SCHEDULES_ENABLED = true;
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });
    fireScheduleNowMock.mockRejectedValueOnce(Errors.notFound('FLOW_NOT_FOUND', 'gone'));
    const res = await app.inject({ method: 'POST', url: '/schedules/morning-sop/run-now', payload: {} });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('FLOW_NOT_FOUND');
  });
});

describe('schedule runs', () => {
  function seedRun(
    id: string,
    scheduleId: string,
    createdAt: string,
    status: FlowRunDoc['status'],
  ): void {
    void runsColl.insertOne({
      _id: id,
      tenantId: 'tenant-a',
      flowName: 'sched-flow',
      flowVersion: 1,
      status,
      inputs: {},
      steps: [],
      confirmWrites: false,
      requestedBy: { userId: 'user-owner' },
      scheduleRef: { scheduleId, scheduleName: 'morning-sop' },
      createdAt: new Date(createdAt),
      updatedAt: new Date(createdAt),
    });
  }

  it('lists runs newest-first with an optional status filter', async () => {
    config.SCHEDULES_ENABLED = true;
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/schedules', payload: SCHEDULE_BODY });

    seedRun('run-old', 'sched-morning-sop', '2026-10-01T07:00:00.000Z', 'completed');
    seedRun('run-new', 'sched-morning-sop', '2026-10-02T07:00:00.000Z', 'blocked');
    seedRun('run-other-schedule', 'sched-evening', '2026-10-02T08:00:00.000Z', 'completed');
    await new Promise((resolve) => setTimeout(resolve, 0));

    const res = await app.inject({ method: 'GET', url: '/schedules/morning-sop/runs' });
    expect(res.statusCode).toBe(200);
    expect(res.json().runs.map((r: any) => r.id)).toEqual(['run-new', 'run-old']);

    const filtered = await app.inject({ method: 'GET', url: '/schedules/morning-sop/runs?status=completed' });
    expect(filtered.json().runs.map((r: any) => r.id)).toEqual(['run-old']);

    const missing = await app.inject({ method: 'GET', url: '/schedules/nope/runs' });
    expect(missing.statusCode).toBe(404);
  });
});
