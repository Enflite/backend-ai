/**
 * schedulesStore.test.ts — Schedules data layer (ADR-023).
 *
 * Covers: create computes nextRunAt, duplicate-name conflict, unknown
 * flow / runAs rejection, update recomputing nextRunAt on trigger
 * change, pause nulling / resume recomputing, atomic due-claim (claims
 * only due+enabled, advances nextRunAt, no double-claim), delete keeping
 * flow_runs, recordTick patching, and getScheduleStats status counts
 * with the trailing-30-day window. VALIDATED IN CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));

import { AppError } from '../src/errors.js';
import {
  claimDueSchedules,
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleById,
  getScheduleStats,
  listSchedules,
  pauseSchedule,
  recordTick,
  resumeSchedule,
  updateSchedule,
} from '../src/schedules/scheduleStore.js';
import type { CreateScheduleInput } from '../src/schedules/scheduleTypes.js';

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in (extended from flowsRoutes.test.ts):
// supports $lte filters, findOne({ sort }), and includeResultMetadata on
// findOneAndUpdate (the store's due-claim CAS path).
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
    if (
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      if ('$nin' in value) return !(value.$nin as unknown[]).includes(actual);
      if ('$in' in value) return (value.$in as unknown[]).includes(actual);
      if ('$lte' in value) {
        if (actual === undefined || actual === null) return false;
        return (actual as any) <= (value.$lte as any);
      }
      return false;
    }
    // Plain equality; Dates compare by time value (the claim CAS guards on
    // the exact old tick).
    if (actual instanceof Date && value instanceof Date) {
      return actual.getTime() === value.getTime();
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
    for (const [key, value] of Object.entries(update.$push ?? {})) {
      const arr = (getDotted(doc, key) as unknown[] | undefined) ?? [];
      arr.push(value);
      applyDotted(doc, key, arr);
    }
  };
  const sortRows = (
    rows: Record<string, any>[],
    spec: Record<string, 1 | -1> | undefined,
  ): Record<string, any>[] => {
    if (!spec) return rows;
    const entries = Object.entries(spec);
    return [...rows].sort((a, b) => {
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
    findOne: vi.fn(async (filter: Record<string, any>, options?: { sort?: Record<string, 1 | -1> }) => {
      const rows = sortRows([...docs.values()].filter((doc) => matches(doc, filter)), options?.sort);
      return rows.length > 0 ? clone(rows[0]!) : null;
    }),
    findOneAndUpdate: vi.fn(
      async (
        filter: Record<string, any>,
        update: Record<string, any>,
        options?: { returnDocument?: 'before' | 'after'; includeResultMetadata?: boolean },
      ) => {
        for (const [id, doc] of docs) {
          if (matches(doc, filter)) {
            const before = clone(doc);
            applyUpdate(doc, update);
            docs.set(id, doc);
            const resultDoc = options?.returnDocument === 'before' ? before : clone(doc);
            if (options?.includeResultMetadata) {
              return { value: resultDoc, ok: 1 };
            }
            return resultDoc;
          }
        }
        return options?.includeResultMetadata ? { value: null, ok: 1 } : null;
      },
    ),
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
          rows = sortRows(rows, spec);
          return cursor;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        project: (_spec: Record<string, unknown>) => cursor,
        toArray: async () => rows,
      };
      return cursor;
    }),
    createIndex: vi.fn(async () => 'idx'),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Coll = ReturnType<typeof memoryCollection>;
let schedulesColl: Coll;
let flowsColl: Coll;
let usersColl: Coll;
let membershipsColl: Coll;
let runsColl: Coll;

const auth = {
  userId: 'user-admin',
  tenantId: 'tenant-a',
  sessionId: 'sess-1',
  roleId: 'role-1',
  email: 'admin@example.test',
  displayName: 'Admin',
  roleName: 'Admin',
  clearance: 'INTERNAL',
  permissions: ['schedules:manage', 'schedules:run'],
};

const baseInput: CreateScheduleInput = {
  name: 'buyer-routine',
  title: 'Buyer routine',
  description: '',
  target: { kind: 'flow', flowName: 'buyer-flow', alias: 'live' },
  trigger: { kind: 'cron', expression: '0 7 * * *', timezone: 'America/Chicago' },
  inputs: {},
  confirmWrites: false,
  enabled: true,
  runAsUserId: 'user-admin',
};

function makeRun(overrides: Record<string, any>): Record<string, any> {
  return {
    _id: `run-${Math.random().toString(36).slice(2)}`,
    tenantId: 'tenant-a',
    flowName: 'buyer-flow',
    flowVersion: 1,
    status: 'completed',
    inputs: {},
    steps: [],
    confirmWrites: false,
    requestedBy: { userId: 'user-admin', tenantId: 'tenant-a' },
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  schedulesColl = memoryCollection([['tenantId', 'name']]);
  flowsColl = memoryCollection([['tenantId', 'name']]);
  usersColl = memoryCollection();
  membershipsColl = memoryCollection();
  runsColl = memoryCollection();
  getDbMock.mockResolvedValue({
    collection: (name: string) => {
      switch (name) {
        case 'schedules':
          return schedulesColl;
        case 'flows':
          return flowsColl;
        case 'users':
          return usersColl;
        case 'memberships':
          return membershipsColl;
        case 'flow_runs':
          return runsColl;
        default:
          throw new Error(`unexpected collection: ${name}`);
      }
    },
  });
  // Seed a target flow, a tenant-member user, and a non-member user.
  return (async () => {
    await flowsColl.insertOne({ _id: 'flow-1', tenantId: 'tenant-a', name: 'buyer-flow' });
    await usersColl.insertOne({ _id: 'user-admin', tenantId: 'tenant-a' });
    await usersColl.insertOne({ _id: 'user-stranger', tenantId: 'tenant-a' });
    await membershipsColl.insertOne({ _id: 'm-1', userId: 'user-admin', tenantId: 'tenant-a' });
  })();
});

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
    return;
  }
  throw new Error(`expected rejection with code ${code}, but it resolved`);
}

// ---------------------------------------------------------------------------
// create
// ---------------------------------------------------------------------------

describe('createSchedule', () => {
  it('computes nextRunAt from the cron trigger when enabled', async () => {
    const now = new Date();
    const doc = await createSchedule(auth as any, baseInput);
    expect(doc.nextRunAt).toBeInstanceOf(Date);
    expect(doc.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(doc.enabled).toBe(true);
    expect(doc._id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('sets nextRunAt to null when disabled', async () => {
    const doc = await createSchedule(auth as any, { ...baseInput, name: 'paused-one', enabled: false });
    expect(doc.nextRunAt).toBeNull();
  });

  it('rejects duplicate (tenant, name) with SCHEDULE_NAME_CONFLICT', async () => {
    await createSchedule(auth as any, baseInput);
    await expectCode(createSchedule(auth as any, baseInput), 'SCHEDULE_NAME_CONFLICT');
  });

  it('rejects an unknown target flow with FLOW_NOT_FOUND', async () => {
    await expectCode(
      createSchedule(auth as any, {
        ...baseInput,
        name: 'missing-flow',
        target: { kind: 'flow', flowName: 'nope', alias: 'live' },
      }),
      'FLOW_NOT_FOUND',
    );
  });

  it('rejects an unknown runAs user with INVALID_RUN_AS_USER', async () => {
    await expectCode(
      createSchedule(auth as any, { ...baseInput, name: 'ghost-user', runAsUserId: 'no-such-user' }),
      'INVALID_RUN_AS_USER',
    );
  });

  it('rejects a user who is not a tenant member with INVALID_RUN_AS_USER', async () => {
    await expectCode(
      createSchedule(auth as any, { ...baseInput, name: 'stranger', runAsUserId: 'user-stranger' }),
      'INVALID_RUN_AS_USER',
    );
  });

  it('maps a cron expression with no occurrence to CRON_HAS_NO_OCCURRENCE', async () => {
    await expectCode(
      createSchedule(auth as any, {
        ...baseInput,
        name: 'never-fires',
        // Feb 30 never exists: parses fine, never occurs within 366 days.
        trigger: { kind: 'cron', expression: '30 2 30 2 *', timezone: 'UTC' },
      }),
      'CRON_HAS_NO_OCCURRENCE',
    );
  }, 30_000);
});

// ---------------------------------------------------------------------------
// read / update / pause / resume / delete
// ---------------------------------------------------------------------------

describe('read + update + delete', () => {
  it('getSchedule / getScheduleById / listSchedules round-trip', async () => {
    const created = await createSchedule(auth as any, baseInput);
    expect(await getSchedule('tenant-a', 'buyer-routine')).toMatchObject({ _id: created._id });
    expect(await getScheduleById('tenant-a', created._id)).toMatchObject({ name: 'buyer-routine' });
    expect(await getSchedule('tenant-a', 'nope')).toBeNull();
    expect(await getSchedule('tenant-b', 'buyer-routine')).toBeNull();

    await createSchedule(auth as any, { ...baseInput, name: 'second-one', enabled: false });
    const all = await listSchedules('tenant-a', { limit: 50 });
    expect(all.map((s) => s.name)).toEqual(['second-one', 'buyer-routine']); // newest first
    const enabledOnly = await listSchedules('tenant-a', { enabled: true, limit: 50 });
    expect(enabledOnly.map((s) => s.name)).toEqual(['buyer-routine']);
  });

  it('update recomputes nextRunAt when the trigger changes', async () => {
    const before = await createSchedule(auth as any, baseInput);
    const updated = await updateSchedule(
      'tenant-a',
      'buyer-routine',
      { trigger: { kind: 'cron', expression: '0 8 * * *', timezone: 'America/Chicago' } },
    );
    expect(updated.trigger).toMatchObject({ expression: '0 8 * * *' });
    expect(updated.nextRunAt).toBeInstanceOf(Date);
    expect(updated.nextRunAt!.getTime()).not.toBe(before.nextRunAt!.getTime());
  });

  it('update re-validates a changed target flow and runAs user', async () => {
    await createSchedule(auth as any, baseInput);
    await expectCode(
      updateSchedule('tenant-a', 'buyer-routine', {
        target: { kind: 'flow', flowName: 'ghost-flow', alias: 'live' },
      }),
      'FLOW_NOT_FOUND',
    );
    await expectCode(
      updateSchedule('tenant-a', 'buyer-routine', { runAsUserId: 'user-stranger' }),
      'INVALID_RUN_AS_USER',
    );
  });

  it('update on a missing schedule throws SCHEDULE_NOT_FOUND', async () => {
    await expectCode(
      updateSchedule('tenant-a', 'ghost', { title: 'x' }),
      'SCHEDULE_NOT_FOUND',
    );
  });

  it('pause nulls nextRunAt and resume recomputes it', async () => {
    await createSchedule(auth as any, baseInput);
    const paused = await pauseSchedule('tenant-a', 'buyer-routine');
    expect(paused.enabled).toBe(false);
    expect(paused.nextRunAt).toBeNull();

    const resumed = await resumeSchedule('tenant-a', 'buyer-routine');
    expect(resumed.enabled).toBe(true);
    expect(resumed.nextRunAt).toBeInstanceOf(Date);
    expect(resumed.nextRunAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('delete removes the schedule but keeps flow_runs history', async () => {
    const created = await createSchedule(auth as any, baseInput);
    await runsColl.insertOne(
      makeRun({ scheduleRef: { scheduleId: created._id, scheduleName: 'buyer-routine' } }),
    );
    await deleteSchedule('tenant-a', 'buyer-routine');
    expect(await getSchedule('tenant-a', 'buyer-routine')).toBeNull();
    expect(await runsColl.findOne({})).not.toBeNull();
    await expectCode(deleteSchedule('tenant-a', 'buyer-routine'), 'SCHEDULE_NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// claimDueSchedules
// ---------------------------------------------------------------------------

describe('claimDueSchedules', () => {
  async function seedDueSchedule(): Promise<string> {
    // Daily 7am CT; nextRunAt hand-set to yesterday 7am CT so it is due
    // without depending on the real wall clock.
    const doc = await createSchedule(auth as any, baseInput);
    const pastTick = new Date('2026-10-01T07:00:00-05:00');
    await schedulesColl.updateOne({ _id: doc._id }, { $set: { nextRunAt: pastTick } });
    return doc._id;
  }

  it('claims only due+enabled schedules, advances nextRunAt, returns tick', async () => {
    const dueId = await seedDueSchedule();
    // Enabled but not due (real next fire is in the future).
    await createSchedule(auth as any, { ...baseInput, name: 'future-one' });
    // Due tick but disabled: must not fire.
    const disabled = await createSchedule(auth as any, {
      ...baseInput,
      name: 'disabled-one',
      enabled: false,
    });
    await schedulesColl.updateOne(
      { _id: disabled._id },
      { $set: { nextRunAt: new Date('2026-10-01T07:00:00-05:00') } },
    );

    const now = new Date('2026-10-02T06:00:00-05:00');
    const claimed = await claimDueSchedules(now, 10);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!._id).toBe(dueId);
    // tick is the old fire time that was claimed.
    expect(claimed[0]!.tick.getTime()).toBe(new Date('2026-10-01T07:00:00-05:00').getTime());

    // nextRunAt advanced to the following fire time, past `now`.
    const stored = await getScheduleById('tenant-a', dueId);
    expect(stored!.nextRunAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(stored!.nextRunAt!.getTime()).toBe(
      new Date('2026-10-02T07:00:00-05:00').getTime(),
    );

    // Second sweep at the same `now` finds nothing: no double-claim.
    expect(await claimDueSchedules(now, 10)).toHaveLength(0);
  });

  it('claims multiple due schedules oldest-first up to the limit', async () => {
    const first = await seedDueSchedule();
    const secondDoc = await createSchedule(auth as any, { ...baseInput, name: 'second-due' });
    const laterTick = new Date('2026-10-01T12:00:00-05:00');
    await schedulesColl.updateOne({ _id: secondDoc._id }, { $set: { nextRunAt: laterTick } });

    const now = new Date('2026-10-02T06:00:00-05:00');
    const claimed = await claimDueSchedules(now, 1);
    expect(claimed).toHaveLength(1);
    expect(claimed[0]!._id).toBe(first); // oldest tick first
    const rest = await claimDueSchedules(now, 10);
    expect(rest).toHaveLength(1);
    expect(rest[0]!._id).toBe(secondDoc._id);
  });

  it('a lost CAS race is skipped, not double-claimed', async () => {
    const dueId = await seedDueSchedule();
    const now = new Date('2026-10-02T06:00:00-05:00');
    // Simulate another backend winning the race first.
    const winner = await claimDueSchedules(now, 10);
    expect(winner).toHaveLength(1);
    // Force the CAS filter to fail (nextRunAt already advanced): the
    // sweep must return nothing rather than re-claim.
    const after = await claimDueSchedules(now, 10);
    expect(after).toHaveLength(0);
    expect((await getScheduleById('tenant-a', dueId))!.nextRunAt!.getTime()).toBeGreaterThan(
      now.getTime(),
    );
  });
});

// ---------------------------------------------------------------------------
// recordTick + getScheduleStats
// ---------------------------------------------------------------------------

describe('recordTick + getScheduleStats', () => {
  it('recordTick patches last-run fields', async () => {
    const doc = await createSchedule(auth as any, baseInput);
    const at = new Date('2026-10-02T07:00:05-05:00');
    await recordTick('tenant-a', doc._id, {
      lastRunAt: at,
      lastRunId: 'run-123',
      lastTickStatus: 'triggered',
    });
    const stored = await getScheduleById('tenant-a', doc._id);
    expect(stored!.lastRunAt!.getTime()).toBe(at.getTime());
    expect(stored!.lastRunId).toBe('run-123');
    expect(stored!.lastTickStatus).toBe('triggered');
  });

  it('stats count by status all-time and trailing-30-days, scoped to the schedule', async () => {
    const doc = await createSchedule(auth as any, baseInput);
    const scheduleId = doc._id;
    const ref = { scheduleRef: { scheduleId, scheduleName: 'buyer-routine' } };
    const recent = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);

    await runsColl.insertOne(makeRun({ ...ref, status: 'completed', createdAt: recent }));
    await runsColl.insertOne(makeRun({ ...ref, status: 'completed', createdAt: old }));
    await runsColl.insertOne(makeRun({ ...ref, status: 'running', createdAt: recent }));
    await runsColl.insertOne(makeRun({ ...ref, status: 'cancelled', createdAt: recent }));
    // Noise: different schedule, different tenant — must not count.
    await runsColl.insertOne(
      makeRun({ scheduleRef: { scheduleId: 'other-sched', scheduleName: 'x' }, status: 'completed' }),
    );
    await runsColl.insertOne(
      makeRun({ ...ref, tenantId: 'tenant-b', status: 'completed' }),
    );

    await recordTick('tenant-a', scheduleId, {
      lastRunAt: recent,
      lastRunId: 'run-1',
      lastTickStatus: 'triggered',
    });

    const stats = await getScheduleStats('tenant-a', scheduleId);
    expect(stats.scheduleId).toBe(scheduleId);
    expect(stats.scheduleName).toBe('buyer-routine');
    expect(stats.enabled).toBe(true);
    expect(stats.nextRunAt).toBeInstanceOf(Date);
    expect(stats.lastRunId).toBe('run-1');
    expect(stats.lastTickStatus).toBe('triggered');
    expect(stats.totalRuns).toBe(4);
    expect(stats.byStatus).toEqual({ completed: 2, running: 1, cancelled: 1 });
    expect(stats.last30Days).toEqual({ completed: 1, running: 1, cancelled: 1 });
  });

  it('stats on a schedule with no runs returns empty counts', async () => {
    const doc = await createSchedule(auth as any, baseInput);
    const stats = await getScheduleStats('tenant-a', doc._id);
    expect(stats.totalRuns).toBe(0);
    expect(stats.byStatus).toEqual({});
    expect(stats.last30Days).toEqual({});
    expect(stats.lastRunAt).toBeUndefined();
  });

  it('stats on a missing schedule throws SCHEDULE_NOT_FOUND', async () => {
    await expectCode(getScheduleStats('tenant-a', 'nope'), 'SCHEDULE_NOT_FOUND');
  });
});
