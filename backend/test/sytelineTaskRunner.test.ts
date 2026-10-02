/**
 * sytelineTaskRunner.test.ts — the SyteLine task runner (DESIGN.md §11.3).
 *
 * - claim -> plan -> execute -> report with the FakeDriver (deterministic)
 * - read-only task completes; per-step evidence ids attached; completion audit
 * - stop-on-first-failure: failed step blocks the task with the error code
 * - autoApproveWrites=false: read-only reconnaissance runs, write steps are
 *   skipped, task parks as blocked/awaiting-write-approval with the proposed plan
 * - autoApproveWrites=true: write steps execute
 * - invalid plan JSON -> blocked/invalid-plan
 * - completion report appended to the originating conversation (and only when
 *   the conversation belongs to the requester)
 * - live permission check: a requester demoted/deactivated after task creation
 *   fails closed (blocked/requester-lost-permission), never driving the browser
 * - mid-run cancel stops execution promptly; terminal transitions never
 *   overwrite a newer state (no resurrection of a cancelled task)
 * - processAssignedTasks sweeps assigned tasks (runner disabled -> no-op)
 * - the canonical PO Detail Report Viewer plan validates against the DSL
 *   schema and carries the §11.9 safety structure (backup first, no live form)
 *
 * The model is replaced by overrideTaskPlanFn; the browser by the FakeDriver.
 * VALIDATED IN CI; real Chromium/model planning REQUIRES REAL SYTELINE.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { getDbMock, tenantOpMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  tenantOpMock: vi.fn(),
}));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
}));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { config } from '../src/config.js';
import type { AuthContext, Permission } from '../src/authz/permissions.js';
import { FakeDriver } from '../src/syteline/ui/fakeDriver.js';
import { overrideUiDriverFactory, runTaskPlanInput } from '../src/tools/sytelineUi.js';
import { blockTask, cancelTask, completeTask, createTask, claimTask } from '../src/syteline/tasks/taskStore.js';
import {
  authFromSnapshot,
  extractPlanJson,
  overrideTaskPlanFn,
  processAssignedTasks,
  runTask,
  TASK_PLANNER_SYSTEM_PROMPT,
} from '../src/syteline/tasks/taskRunner.js';
import { PO_DETAIL_VIEWER_CANONICAL_PLAN } from '../src/eval/cases/sytelineTaskPlanning.js';
import type { SytelineTaskDoc } from '../src/syteline/tasks/taskTypes.js';

const BASE_URL = 'https://syteline.example/web';
const FORM_URL = `${BASE_URL}?form=CustomerOrders`;

function authFor(userId: string, permissions: Permission[]): AuthContext {
  return {
    userId,
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    tenantId: 'tenant-a',
    roleId: 'role-1',
    roleName: 'Admin',
    permissions,
    sessionId: 'session-1',
  };
}

const ADMIN_AUTH = () =>
  authFor('user-admin', ['tool:use', 'chat:create', 'syteline:ui', 'tenant:manage']);

// In-memory collections with dotted-path $set support for step updates.
function memoryDb() {
  const tasks = new Map<string, Record<string, any>>();
  const conversations = new Map<string, Record<string, any>>();
  const messages: Array<Record<string, any>> = [];

  const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$nin' in value) return !(value.$nin as unknown[]).includes(doc[key]);
        if ('$in' in value) return (value.$in as unknown[]).includes(doc[key]);
        return false;
      }
      return doc[key] === value;
    });

  const applyDotted = (doc: Record<string, any>, path: string, value: unknown): void => {
    const parts = path.split('.');
    let target: Record<string, any> = doc;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const next = parts[i + 1]!;
      const isIndex = /^\d+$/.test(next);
      if (!(part in target) || target[part] == null) {
        target[part] = isIndex ? [] : {};
      }
      target = target[part];
    }
    target[parts[parts.length - 1]!] = value;
  };

  const taskCollection = {
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      tasks.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of tasks.values()) if (matches(doc, filter)) return { ...doc };
      return null;
    }),
    find: vi.fn((filter: Record<string, any>) => {
      let rows = [...tasks.values()].filter((d) => matches(d, filter));
      const cursor = {
        sort: vi.fn((_spec: unknown) => cursor),
        limit: vi.fn((n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        }),
        toArray: vi.fn(async () => rows.map((r) => JSON.parse(JSON.stringify(r)))),
      };
      return cursor;
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, any>, update: Record<string, any>, opts: { returnDocument?: string }) => {
        for (const doc of tasks.values()) {
          if (matches(doc, filter)) {
            for (const [path, value] of Object.entries(update.$set)) applyDotted(doc, path, value);
            return opts?.returnDocument === 'after' ? JSON.parse(JSON.stringify(doc)) : null;
          }
        }
        return null;
      },
    ),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const doc of tasks.values()) {
        if (matches(doc, filter)) {
          for (const [path, value] of Object.entries(update.$set)) applyDotted(doc, path, value);
          return { modifiedCount: 1, matchedCount: 1 };
        }
      }
      return { modifiedCount: 0, matchedCount: 0 };
    }),
  };

  // Live-auth lookup tables for the runner's run-time permission check.
  // `revoked` simulates a demotion/deactivation after task creation.
  const liveUsers = new Map<string, Record<string, any>>();
  const liveMemberships = new Map<string, Record<string, any>>();
  const liveTenants = new Map<string, Record<string, any>>();
  const liveRoles = new Map<string, Record<string, any>>();
  let liveRolePermissions: Array<Record<string, any>> = [];
  let livePermissions: Array<Record<string, any>> = [];
  const simpleFindOne = (table: Map<string, Record<string, any>>) =>
    vi.fn(async (filter: Record<string, any>) => {
      for (const doc of table.values()) if (matches(doc, filter)) return { ...doc };
      return null;
    });
  const simpleFind = (rows: Array<Record<string, any>>) =>
    vi.fn((filter: Record<string, any>) => ({
      toArray: vi.fn(async () => rows.filter((d) => matches(d, filter)).map((d) => ({ ...d }))),
    }));

  function seedLiveAuth(opts: { noUiPermission?: boolean; deactivated?: boolean } = {}): void {
    liveUsers.set('user-admin', {
      _id: 'user-admin', email: 'user-admin@example.test', passwordHash: 'x',
      displayName: 'Test User', isActive: !opts.deactivated, clearance: 'INTERNAL',
    });
    liveMemberships.set('user-admin:tenant-a', {
      _id: 'm1', userId: 'user-admin', tenantId: 'tenant-a', roleId: 'role-1',
    });
    liveTenants.set('tenant-a', { _id: 'tenant-a', name: 'Tenant A' });
    liveRoles.set('role-1', { _id: 'role-1', name: 'Admin' });
    const perms = opts.noUiPermission
      ? ['tool:use', 'chat:create', 'tenant:manage']
      : ['tool:use', 'chat:create', 'syteline:ui', 'tenant:manage'];
    liveRolePermissions = perms.map((name, i) => ({ _id: `rp${i}`, roleId: 'role-1', permissionId: `perm-${name}` }));
    livePermissions = perms.map((name) => ({ _id: `perm-${name}`, name }));
  }

  const collection = (name: string) => {
    if (name === 'syteline_tasks') return taskCollection;
    if (name === 'syteline_credentials') {
      return { findOne: vi.fn(async () => null), updateOne: vi.fn(async () => ({})) };
    }
    if (name === 'conversations') {
      return {
        findOne: vi.fn(async (filter: Record<string, any>) => {
          const doc = conversations.get(filter._id);
          if (!doc) return null;
          if (filter.tenantId && doc.tenantId !== filter.tenantId) return null;
          if (filter.userId && doc.userId !== filter.userId) return null;
          return { ...doc };
        }),
        updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
          const doc = conversations.get(filter._id);
          if (doc) Object.assign(doc, update.$set);
          return { modifiedCount: doc ? 1 : 0 };
        }),
      };
    }
    if (name === 'messages') {
      return {
        insertOne: vi.fn(async (doc: Record<string, any>) => {
          messages.push({ ...doc });
          return { insertedId: doc._id };
        }),
      };
    }
    if (name === 'users') return { findOne: simpleFindOne(liveUsers) };
    if (name === 'memberships') return { findOne: simpleFindOne(liveMemberships) };
    if (name === 'tenants') return { findOne: simpleFindOne(liveTenants) };
    if (name === 'roles') return { findOne: simpleFindOne(liveRoles) };
    if (name === 'role_permissions') return { find: simpleFind(liveRolePermissions) };
    if (name === 'permissions') return { find: simpleFind(livePermissions) };
    throw new Error(`unexpected collection ${name}`);
  };
  return { collection, tasks, conversations, messages, seedLiveAuth };
}

let db: ReturnType<typeof memoryDb>;
const evidenceDir = mkdtempSync(join(tmpdir(), 'task-evidence-'));
const savedConfig: Record<string, unknown> = {};

function setConfig(key: string, value: unknown): void {
  if (!(key in savedConfig)) savedConfig[key] = (config as Record<string, unknown>)[key];
  (config as Record<string, unknown>)[key] = value;
}

function fakeDriverFactory() {
  return async () =>
    FakeDriver.withLoginPage(BASE_URL, 'jsmith1', 's3cret', {
      [FORM_URL]: {
        text: 'Customer Orders\nOrder SO-77821 Status Open',
        fields: { Order: '' },
        buttons: {
          Find: (d) => d.setPageText('Customer Orders\nOrder SO-77821 Status Open\nLine 1 shipped'),
        },
      },
    });
}

const READ_ONLY_PLAN = JSON.stringify({
  steps: [
    { action: 'gotoForm', form: 'CustomerOrders' },
    { action: 'readScreen' },
    { action: 'assertText', text: 'Customer Orders' },
  ],
});

const WRITE_PLAN = JSON.stringify({
  steps: [
    { action: 'gotoForm', form: 'CustomerOrders' },
    { action: 'readScreen' },
    { action: 'fillField', label: 'Order', value: 'SO-77821' },
    { action: 'clickButton', label: 'Find' },
  ],
});

const FAILING_PLAN = JSON.stringify({
  steps: [
    { action: 'gotoForm', form: 'CustomerOrders' },
    { action: 'gotoForm', form: 'NoSuchForm' },
    { action: 'readScreen' },
  ],
});

async function claimedTask(plan: string, opts: { autoApproveWrites?: boolean; conversationId?: string } = {}): Promise<SytelineTaskDoc> {
  overrideTaskPlanFn(async () => plan);
  const created = await createTask(
    ADMIN_AUTH(),
    { title: 'Test task', goal: 'Check the customer orders form', autoApproveWrites: opts.autoApproveWrites ?? false },
    'INTERNAL',
    opts.conversationId,
  );
  const claimed = await claimTask('tenant-a', created._id, 'runner-test');
  if (!claimed) throw new Error('claim failed in test setup');
  return claimed;
}

beforeEach(() => {
  vi.clearAllMocks();
  // This suite exercises the DB-driven permission path (seedLiveAuth seeds
  // role_permissions/permissions), so disable the code-level all-grant posture.
  vi.stubEnv('PERMISSIONS_ALL_GRANTED', 'false');
  db = memoryDb();
  db.seedLiveAuth();
  getDbMock.mockImplementation(async () => ({ collection: db.collection }));
  tenantOpMock.mockImplementation(async (_tenantId: string, cb: (db: unknown, tenantId: string) => Promise<unknown>) =>
    cb({ collection: db.collection }, _tenantId),
  );
  overrideUiDriverFactory(fakeDriverFactory());
  overrideTaskPlanFn(null);
  setConfig('SYTELINE_UI_ENABLED', true);
  setConfig('SYTELINE_TASK_RUNNER_ENABLED', true);
  setConfig('SYTELINE_UI_URL', BASE_URL);
  setConfig('SYTELINE_UI_USERNAME', 'jsmith1');
  setConfig('SYTELINE_UI_PASSWORD', 's3cret');
  setConfig('SYTELINE_UI_EVIDENCE_DIR', evidenceDir);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('runTask — read-only completion', () => {
  it('claims, plans, executes, and completes with per-step evidence', async () => {
    const task = await claimedTask(READ_ONLY_PLAN);
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('completed');
    expect(stored.resultSummary).toContain('3 step(s) ok');
    expect(stored.steps).toHaveLength(3);
    for (const step of stored.steps) {
      expect(step.status).toBe('ok');
      expect(step.evidenceIds).toHaveLength(1);
    }
    // Keys only in audit metadata — never field values.
    const stepAudits = recordAuditMock.mock.calls.filter(
      ([input]) => input.action === 'SYTELINE_TASK_STEP',
    );
    expect(stepAudits).toHaveLength(3);
    expect(JSON.stringify(stepAudits)).not.toContain('SO-77821');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYTELINE_TASK_COMPLETED', success: true }),
    );
    // Evidence files landed in the tenant dir.
    const { readdirSync } = await import('node:fs');
    expect(readdirSync(join(evidenceDir, 'tenant-a')).length).toBeGreaterThanOrEqual(3);
  });
});

describe('runTask — stop on first failure', () => {
  it('blocks the task with the step error code and stops', async () => {
    const task = await claimedTask(FAILING_PLAN);
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('UI_PAGE_NOT_FOUND');
    expect(stored.steps[0]!.status).toBe('ok');
    expect(stored.steps[1]!.status).toBe('failed');
    expect(stored.steps[1]!.errorCode).toBe('UI_PAGE_NOT_FOUND');
    expect(stored.steps[2]!.status).toBe('pending'); // never ran
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYTELINE_TASK_BLOCKED', success: false }),
    );
  });
});

describe('runTask — write approval gate (§11.4)', () => {
  it('without approval: runs reconnaissance, skips writes, parks as awaiting-write-approval', async () => {
    const task = await claimedTask(WRITE_PLAN, { autoApproveWrites: false });
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('awaiting-write-approval');
    expect(stored.steps[0]!.status).toBe('ok'); // gotoForm ran
    expect(stored.steps[1]!.status).toBe('ok'); // readScreen ran
    expect(stored.steps[2]!.status).toBe('skipped'); // fillField skipped
    expect(stored.steps[3]!.status).toBe('skipped'); // clickButton skipped
    expect(stored.resultSummary).toContain('Proposed write plan');
    expect(stored.resultSummary).toContain('fillField');
  });

  it('with autoApproveWrites: write steps execute', async () => {
    const task = await claimedTask(WRITE_PLAN, { autoApproveWrites: true });
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('completed');
    expect(stored.steps.every((s: { status: string }) => s.status === 'ok')).toBe(true);
    expect(stored.resultSummary).toContain('4 step(s) ok');
  });
});

describe('runTask — invalid plan', () => {
  it('blocks the task when the planner returns non-JSON', async () => {
    const task = await claimedTask('this is not json');
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('invalid-plan');
  });

  it('blocks the task when the plan has an unknown action', async () => {
    const task = await claimedTask(JSON.stringify({ steps: [{ action: 'hackTheGibson' }] }));
    await runTask(task);

    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('invalid-plan');
  });
});

describe('runTask — conversation report-back', () => {
  it('appends an assistant message to the originating conversation', async () => {
    db.conversations.set('conv-1', { _id: 'conv-1', tenantId: 'tenant-a', userId: 'user-admin' });
    const task = await claimedTask(READ_ONLY_PLAN, { conversationId: 'conv-1' });
    await runTask(task);

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      conversationId: 'conv-1',
      tenantId: 'tenant-a',
      role: 'assistant',
    });
    expect(db.messages[0]!.content).toContain('Test task');
    expect(db.messages[0]!.content).toContain('completed');
  });

  it('never reports into a conversation owned by someone else', async () => {
    db.conversations.set('conv-2', { _id: 'conv-2', tenantId: 'tenant-a', userId: 'user-other' });
    const task = await claimedTask(READ_ONLY_PLAN, { conversationId: 'conv-2' });
    await runTask(task);

    expect(db.messages).toHaveLength(0);
    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('completed'); // task still completes; only the report is skipped
  });
});

describe('processAssignedTasks', () => {
  it('sweeps assigned tasks and is a no-op when the runner is disabled', async () => {
    overrideTaskPlanFn(async () => READ_ONLY_PLAN);
    await createTask(ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    await createTask(ADMIN_AUTH(), { title: 'B', goal: 'g' }, 'INTERNAL');

    const result = await processAssignedTasks();
    expect(result.claimed).toBe(2);
    expect(result.succeeded).toBe(2);
    const statuses = [...db.tasks.values()].map((t) => t.status);
    expect(statuses).toEqual(['completed', 'completed']);

    setConfig('SYTELINE_TASK_RUNNER_ENABLED', false);
    await createTask(ADMIN_AUTH(), { title: 'C', goal: 'g' }, 'INTERNAL');
    const idle = await processAssignedTasks();
    expect(idle).toEqual({ claimed: 0, succeeded: 0, blocked: 0 });
    expect([...db.tasks.values()].find((t) => t.title === 'C')!.status).toBe('assigned');
  });
});

describe('canonical PO Detail Report Viewer plan (§11.9)', () => {
  it('validates against the runTaskPlan DSL schema', () => {
    const parsed = runTaskPlanInput.parse(extractPlanJson(PO_DETAIL_VIEWER_CANONICAL_PLAN));
    expect(parsed.steps.length).toBeGreaterThan(0);
    expect(parsed.steps.length).toBeLessThanOrEqual(25);
  });

  it('carries the safety structure: backup first, no live form', () => {
    const parsed = runTaskPlanInput.parse(extractPlanJson(PO_DETAIL_VIEWER_CANONICAL_PLAN));
    // (a) backup/FormSync step FIRST
    expect(parsed.steps[0]).toMatchObject({ action: 'gotoForm', form: 'FormSync' });
    // (b) collection + custom load method
    expect(PO_DETAIL_VIEWER_CANONICAL_PLAN).toContain('UE_FL-SL');
    expect(PO_DETAIL_VIEWER_CANONICAL_PLAN).toContain('Custom Load Method');
    // (c) T&C group footer
    expect(PO_DETAIL_VIEWER_CANONICAL_PLAN).toContain('Group Footer');
    expect(PO_DETAIL_VIEWER_CANONICAL_PLAN).toContain('Terms and Conditions');
    // (d) no step touching the live Purchase Order Report form
    for (const step of parsed.steps) {
      if (step.action === 'gotoForm') {
        expect(step.form).not.toBe('PurchaseOrderReport');
      }
    }
  });

  it('planner guidance encodes backup-first and the truncation gotcha', () => {
    expect(TASK_PLANNER_SYSTEM_PROMPT).toContain('BACKUP BEFORE FORM CHANGES');
    expect(TASK_PLANNER_SYSTEM_PROMPT).toContain('FormSync');
    expect(TASK_PLANNER_SYSTEM_PROMPT).toContain('string or binary data would be truncated');
    expect(TASK_PLANNER_SYSTEM_PROMPT).toContain('Keep component names short');
  });

  it('auth snapshot records the requester identity at creation time', async () => {
    const created = await createTask(ADMIN_AUTH(), { title: 'T', goal: 'g' }, 'INTERNAL');
    const auth = authFromSnapshot(created);
    expect(auth.userId).toBe('user-admin');
    expect(auth.tenantId).toBe('tenant-a');
    expect(auth.permissions).toContain('syteline:ui');
    expect(auth.sessionId).toContain(created._id); // synthetic runner session
  });

  it('fails closed when the requester lost syteline:ui after task creation', async () => {
    db.seedLiveAuth({ noUiPermission: true });
    const task = await claimedTask(READ_ONLY_PLAN);
    const finalStatus = await runTask(task);

    expect(finalStatus).toBe('blocked');
    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('blocked');
    expect(stored.blockedReason).toBe('requester-lost-permission');
    expect(stored.steps).toEqual([]); // planner never ran, browser never touched
  });

  it('fails closed when the requester is deactivated after task creation', async () => {
    db.seedLiveAuth({ deactivated: true });
    const task = await claimedTask(READ_ONLY_PLAN);
    const finalStatus = await runTask(task);

    expect(finalStatus).toBe('blocked');
    expect(db.tasks.get(task._id)!.blockedReason).toBe('requester-lost-permission');
  });

  it('stops promptly when the task is cancelled mid-run and never resurrects it', async () => {
    const task = await claimedTask(READ_ONLY_PLAN);
    await cancelTask('tenant-a', task._id); // external cancel after the claim
    const finalStatus = await runTask(task);

    expect(finalStatus).toBe('cancelled');
    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('cancelled');
    // No step executed: the browser run stopped before the first step.
    expect(stored.steps.every((s: { status: string }) => s.status === 'pending')).toBe(true);
  });

  it('completeTask/blockTask never overwrite a newer terminal state', async () => {
    const task = await claimedTask(READ_ONLY_PLAN);
    await cancelTask('tenant-a', task._id);

    expect(await completeTask('tenant-a', task._id, 'too late')).toBe(false);
    expect(await blockTask('tenant-a', task._id, 'too late')).toBe(false);
    const stored = db.tasks.get(task._id)!;
    expect(stored.status).toBe('cancelled');
    expect(stored.resultSummary).toBeUndefined();
  });

  it('runTask reports its final status for sweep accounting', async () => {
    const okTask = await claimedTask(READ_ONLY_PLAN);
    expect(await runTask(okTask)).toBe('completed');
    const badTask = await claimedTask(FAILING_PLAN);
    expect(await runTask(badTask)).toBe('blocked');
  });
});
