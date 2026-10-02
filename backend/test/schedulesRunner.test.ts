/**
 * schedulesRunner.test.ts — schedule execution layer (ADR-023).
 *
 * - fireDueSchedules: claims a due schedule and creates a flow run with the
 *   `sched:<id>:<tick>` idempotency key and a scheduleRef; skips disabled
 *   schedules, demoted runAs owners (liveRequesterAuth → null), runAs
 *   owners who lost flows:run, and missing flows; never throws; a second
 *   fire with the same tick does not double-create (idempotent retry).
 * - fireScheduleNow: creates a run as the caller with overrides applied,
 *   records the tick, audits SCHEDULE_RUN_NOW, and returns the run;
 *   missing flow → FLOW_NOT_FOUND.
 * - scheduleSweeper: start/stop test seam, idempotent start, no-op sweeps
 *   while SCHEDULES_ENABLED=false, and sweeps that claim while enabled.
 *
 * The real scheduleRunner + flowStore run against in-memory mongo; the
 * schedules store (claimDueSchedules/recordTick), the live-auth seam, the
 * audit sink, and the tool gateway are mocked. The sweeper's kick of the
 * flow runner is real but a no-op with FLOW_RUNNER_ENABLED=false.
 * VALIDATED IN CI.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { runToolCallMock } = vi.hoisted(() => ({ runToolCallMock: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-owner',
    tenantId: 'tenant-a',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'owner@example.test',
    displayName: 'Owner',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['flows:run'],
  } as Record<string, unknown>,
}));
const { storeMocks } = vi.hoisted(() => ({
  storeMocks: {
    claimDueSchedules: vi.fn(),
    recordTick: vi.fn(),
  },
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));
vi.mock('../src/syteline/requesterAuth.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/tools/gateway.js', () => ({ runToolCall: runToolCallMock }));
vi.mock('../src/schedules/scheduleStore.js', () => storeMocks);

import { config } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createFlow, getFlow, publishVersion, setLiveAlias } from '../src/flows/flowStore.js';
import { fireDueSchedules, fireScheduleNow } from '../src/schedules/scheduleRunner.js';
import {
  isScheduleSweeperRunning,
  kickScheduleSweeper,
  startScheduleSweeper,
  stopScheduleSweeper,
} from '../src/schedules/scheduleSweeper.js';
import type { ClaimedSchedule } from '../src/schedules/scheduleStore.js';
import type { ScheduleDoc } from '../src/schedules/scheduleTypes.js';

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in (same seams as flowsRoutes.test.ts)
// ---------------------------------------------------------------------------

function getDotted(doc: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    return (obj as Record<string, unknown>)[key];
  }, doc);
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
  const applyDotted = (doc: Record<string, any>, path: string, value: unknown): void => {
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
  };
  const applyUpdate = (doc: Record<string, any>, update: Record<string, any>): void => {
    for (const [key, value] of Object.entries(update.$set ?? {})) {
      if (key.includes('.')) applyDotted(doc, key, value);
      else doc[key] = value;
    }
    for (const [key, value] of Object.entries(update.$push ?? {})) {
      const arr = (getDotted(doc, key) as unknown[] | undefined) ?? [];
      arr.push(value);
      if (key.includes('.')) applyDotted(doc, key, arr);
      else doc[key] = arr;
    }
  };
  return {
    docs,
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
    find: vi.fn((filter: Record<string, any>) => {
      const rows = [...docs.values()].filter((doc) => matches(doc, filter)).map(clone);
      const cursor: any = {
        sort: () => cursor,
        limit: () => cursor,
        toArray: async () => rows,
      };
      return cursor;
    }),
    createIndex: vi.fn(async () => 'idx'),
  };
}

let flowsColl: ReturnType<typeof memoryCollection>;
let runsColl: ReturnType<typeof memoryCollection>;

const FLOW_DEF = {
  name: 'sched-flow',
  title: 'Scheduled Flow',
  description: '',
  inputs: {},
  outputs: {},
  steps: [{ id: 's1', kind: 'tool', tool: 'test.echo', params: {} }],
  onError: 'stop',
};

function makeSchedule(overrides: Partial<ScheduleDoc> = {}): ScheduleDoc {
  const now = new Date();
  return {
    _id: 'sched-1',
    tenantId: 'tenant-a',
    name: 'morning-sop',
    title: 'Morning SOP',
    description: '',
    target: { kind: 'flow', flowName: 'sched-flow', alias: 'live' },
    trigger: { kind: 'cron', expression: '0 7 * * 1-5', timezone: 'America/Chicago' },
    inputs: { region: 'us' },
    confirmWrites: false,
    enabled: true,
    runAsUserId: 'user-owner',
    nextRunAt: new Date('2026-10-02T12:00:00.000Z'),
    createdBy: 'user-owner',
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function claimOf(schedule: ScheduleDoc, tickIso: string): ClaimedSchedule {
  return { ...schedule, tick: new Date(tickIso) };
}

async function seedLiveFlow(): Promise<void> {
  const auth = { ...currentAuth } as any;
  await createFlow(auth, FLOW_DEF);
  await publishVersion('tenant-a', 'sched-flow', 'user-owner');
  const flow = await getFlow('tenant-a', 'sched-flow');
  await setLiveAlias('tenant-a', 'sched-flow', 1, flow!.revision);
}

beforeEach(async () => {
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
  recordTickMockReset();
  storeMocks.claimDueSchedules.mockResolvedValue([]);
  liveRequesterAuthMock.mockImplementation(async () => ({ ...currentAuth }));
  runToolCallMock.mockResolvedValue({ ok: true, data: {} });
  config.SCHEDULES_ENABLED = false;
  config.FLOW_RUNNER_ENABLED = false;
  await seedLiveFlow();
});

function recordTickMockReset(): void {
  storeMocks.recordTick.mockImplementation(async () => null);
}

afterEach(() => {
  stopScheduleSweeper();
  vi.useRealTimers();
});

describe('fireDueSchedules', () => {
  it('claims a due schedule and creates a flow run with the tick idempotency key', async () => {
    const tickIso = '2026-10-02T07:00:00.000Z';
    const now = new Date('2026-10-02T07:00:01.000Z');
    storeMocks.claimDueSchedules.mockResolvedValue([claimOf(makeSchedule(), tickIso)]);

    const result = await fireDueSchedules(now, 10);

    expect(result).toEqual({ claimed: 1, triggered: 1, skipped: 0 });
    expect(runsColl.docs.size).toBe(1);
    const run = [...runsColl.docs.values()][0]!;
    expect(run.flowName).toBe('sched-flow');
    expect(run.flowVersion).toBe(1);
    expect(run.status).toBe('queued');
    expect(run.idempotencyKey).toBe(`sched:sched-1:${tickIso}`);
    expect(run.scheduleRef).toEqual({ scheduleId: 'sched-1', scheduleName: 'morning-sop' });
    expect(run.inputs).toEqual({ region: 'us' });
    expect(run.confirmWrites).toBe(false);
    expect(storeMocks.recordTick).toHaveBeenCalledWith('tenant-a', 'sched-1', {
      lastRunAt: now,
      lastRunId: run._id,
      lastTickStatus: 'triggered',
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_RUN_TRIGGERED',
        success: true,
        metadata: expect.objectContaining({
          scheduleName: 'morning-sop',
          flowName: 'sched-flow',
          version: 1,
          runId: run._id,
          confirmWrites: false,
        }),
      }),
    );
  });

  it('resolves a pinned version instead of the live alias', async () => {
    const tickIso = '2026-10-02T07:00:00.000Z';
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(
        makeSchedule({ target: { kind: 'flow', flowName: 'sched-flow', version: 1, alias: 'live' } }),
        tickIso,
      ),
    ]);
    const result = await fireDueSchedules(new Date(), 10);
    expect(result.triggered).toBe(1);
    const run = [...runsColl.docs.values()][0]!;
    expect(run.flowVersion).toBe(1);
  });

  it('skips a disabled schedule without firing', async () => {
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(makeSchedule({ enabled: false }), '2026-10-02T07:00:00.000Z'),
    ]);
    const result = await fireDueSchedules(new Date(), 10);
    expect(result).toEqual({ claimed: 1, triggered: 0, skipped: 1 });
    expect(runsColl.docs.size).toBe(0);
    expect(storeMocks.recordTick).not.toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_TRIGGER_SKIPPED',
        metadata: expect.objectContaining({ reason: 'schedule-disabled' }),
      }),
    );
  });

  it('skips when the runAs owner is gone (liveRequesterAuth → null)', async () => {
    liveRequesterAuthMock.mockResolvedValueOnce(null);
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(makeSchedule(), '2026-10-02T07:00:00.000Z'),
    ]);
    const now = new Date();
    const result = await fireDueSchedules(now, 10);
    expect(result).toEqual({ claimed: 1, triggered: 0, skipped: 1 });
    expect(runsColl.docs.size).toBe(0);
    expect(storeMocks.recordTick).toHaveBeenCalledWith('tenant-a', 'sched-1', {
      lastRunAt: now,
      lastTickStatus: 'skipped-auth',
    });
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_TRIGGER_SKIPPED',
        metadata: expect.objectContaining({ reason: 'requester-lost-permission' }),
      }),
    );
  });

  it('skips when the runAs owner lost flows:run', async () => {
    liveRequesterAuthMock.mockResolvedValueOnce({ ...currentAuth, permissions: [] });
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(makeSchedule(), '2026-10-02T07:00:00.000Z'),
    ]);
    const result = await fireDueSchedules(new Date(), 10);
    expect(result).toEqual({ claimed: 1, triggered: 0, skipped: 1 });
    expect(runsColl.docs.size).toBe(0);
    expect(storeMocks.recordTick).toHaveBeenCalledWith(
      'tenant-a',
      'sched-1',
      expect.objectContaining({ lastTickStatus: 'skipped-auth' }),
    );
  });

  it('skips when the target flow is missing', async () => {
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(
        makeSchedule({ target: { kind: 'flow', flowName: 'ghost-flow', alias: 'live' } }),
        '2026-10-02T07:00:00.000Z',
      ),
    ]);
    const result = await fireDueSchedules(new Date(), 10);
    expect(result).toEqual({ claimed: 1, triggered: 0, skipped: 1 });
    expect(runsColl.docs.size).toBe(0);
    expect(storeMocks.recordTick).toHaveBeenCalledWith(
      'tenant-a',
      'sched-1',
      expect.objectContaining({ lastTickStatus: 'skipped-flow-missing' }),
    );
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_TRIGGER_SKIPPED',
        metadata: expect.objectContaining({ reason: 'flow-missing' }),
      }),
    );
  });

  it('a second fire with the same tick does not double-create', async () => {
    const tickIso = '2026-10-02T07:00:00.000Z';
    storeMocks.claimDueSchedules.mockResolvedValue([claimOf(makeSchedule(), tickIso)]);
    const first = await fireDueSchedules(new Date(), 10);
    const second = await fireDueSchedules(new Date(), 10);
    expect(first.triggered).toBe(1);
    expect(second.triggered).toBe(1);
    expect(runsColl.docs.size).toBe(1);
    const run = [...runsColl.docs.values()][0]!;
    expect(run.idempotencyKey).toBe(`sched:sched-1:${tickIso}`);
  });

  it('never throws: a failing claim yields an empty result', async () => {
    storeMocks.claimDueSchedules.mockRejectedValueOnce(new Error('db down'));
    const result = await fireDueSchedules(new Date(), 10);
    expect(result).toEqual({ claimed: 0, triggered: 0, skipped: 0 });
  });

  it('never throws: a failing recordTick is contained per schedule', async () => {
    storeMocks.claimDueSchedules.mockResolvedValue([
      claimOf(makeSchedule(), '2026-10-02T07:00:00.000Z'),
    ]);
    storeMocks.recordTick.mockRejectedValueOnce(new Error('db down'));
    const result = await fireDueSchedules(new Date(), 10);
    expect(result.triggered).toBe(1);
    expect(runsColl.docs.size).toBe(1);
  });
});

describe('fireScheduleNow', () => {
  it('creates a run as the caller with overrides applied', async () => {
    const caller = { ...currentAuth, userId: 'user-admin' } as any;
    const run = await fireScheduleNow(caller, makeSchedule(), {
      inputs: { region: 'eu' },
      confirmWrites: true,
    });
    expect(run.flowName).toBe('sched-flow');
    expect(run.flowVersion).toBe(1);
    expect(run.inputs).toEqual({ region: 'eu' });
    expect(run.confirmWrites).toBe(true);
    expect(run.idempotencyKey).toMatch(/^sched:sched-1:manual:/);
    expect(run.scheduleRef).toEqual({ scheduleId: 'sched-1', scheduleName: 'morning-sop' });
    expect(storeMocks.recordTick).toHaveBeenCalledWith(
      'tenant-a',
      'sched-1',
      expect.objectContaining({ lastTickStatus: 'triggered', lastRunId: run._id }),
    );
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SCHEDULE_RUN_NOW',
        success: true,
        userId: 'user-admin',
        metadata: expect.objectContaining({ manual: true, runId: run._id }),
      }),
    );
  });

  it('falls back to the schedule inputs and confirmWrites', async () => {
    const caller = { ...currentAuth } as any;
    const run = await fireScheduleNow(caller, makeSchedule(), {});
    expect(run.inputs).toEqual({ region: 'us' });
    expect(run.confirmWrites).toBe(false);
  });

  it('missing flow → FLOW_NOT_FOUND', async () => {
    const caller = { ...currentAuth } as any;
    await expect(
      fireScheduleNow(
        caller,
        makeSchedule({ target: { kind: 'flow', flowName: 'ghost-flow', alias: 'live' } }),
        {},
      ),
    ).rejects.toMatchObject({ code: 'FLOW_NOT_FOUND' });
    expect(runsColl.docs.size).toBe(0);
  });

  it('flow with no live version → NO_LIVE_VERSION', async () => {
    await createFlow({ ...currentAuth } as any, { ...FLOW_DEF, name: 'draft-only' });
    const caller = { ...currentAuth } as any;
    const err = await fireScheduleNow(
      caller,
      makeSchedule({ target: { kind: 'flow', flowName: 'draft-only', alias: 'live' } }),
      {},
    ).catch((e: unknown) => e);
    expect((err as AppError).code).toBe('NO_LIVE_VERSION');
  });
});

describe('scheduleSweeper', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('start/stop test seam is idempotent', () => {
    expect(isScheduleSweeperRunning()).toBe(false);
    startScheduleSweeper();
    expect(isScheduleSweeperRunning()).toBe(true);
    startScheduleSweeper();
    expect(isScheduleSweeperRunning()).toBe(true);
    stopScheduleSweeper();
    expect(isScheduleSweeperRunning()).toBe(false);
    stopScheduleSweeper();
    expect(isScheduleSweeperRunning()).toBe(false);
  });

  it('sweeps are no-ops while SCHEDULES_ENABLED=false', async () => {
    config.SCHEDULES_ENABLED = false;
    startScheduleSweeper();
    await vi.advanceTimersByTimeAsync(120000);
    expect(storeMocks.claimDueSchedules).not.toHaveBeenCalled();
    kickScheduleSweeper();
    await vi.advanceTimersByTimeAsync(1000);
    expect(storeMocks.claimDueSchedules).not.toHaveBeenCalled();
  });

  it('enabled sweeps claim due schedules', async () => {
    config.SCHEDULES_ENABLED = true;
    storeMocks.claimDueSchedules.mockResolvedValue([]);
    startScheduleSweeper();
    await vi.advanceTimersByTimeAsync(30000);
    expect(storeMocks.claimDueSchedules).toHaveBeenCalledTimes(1);
    expect(storeMocks.claimDueSchedules).toHaveBeenCalledWith(expect.any(Date), 20);
    await vi.advanceTimersByTimeAsync(30000);
    expect(storeMocks.claimDueSchedules).toHaveBeenCalledTimes(2);
  });

  it('kick triggers an out-of-band sweep when enabled', async () => {
    config.SCHEDULES_ENABLED = true;
    storeMocks.claimDueSchedules.mockResolvedValue([]);
    kickScheduleSweeper();
    await vi.advanceTimersByTimeAsync(100);
    expect(storeMocks.claimDueSchedules).toHaveBeenCalledTimes(1);
  });
});
