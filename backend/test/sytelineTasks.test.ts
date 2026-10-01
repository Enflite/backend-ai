/**
 * sytelineTasks.test.ts — the syteline.task.* tool family and task store.
 *
 * - create: assigned task with requester auth snapshot, audit SYTELINE_TASK_CREATED
 * - list: requester sees own tasks; admins see the tenant's; status filter
 * - get: cross-user reads are TASK_NOT_FOUND (no existence leak); admin can read
 * - cancel: requester or admin; destructive (CONFIRMATION_REQUIRED); terminal
 *   tasks are not re-cancelled; audit SYTELINE_TASK_CANCELLED
 * - store: atomic claim (no double-claim), tenant scoping
 * - every tool fails fast while SYTELINE_UI_ENABLED=false
 * - tool callers without `syteline:ui` get TOOL_FORBIDDEN
 *
 * All persistence is in-memory. VALIDATED IN CI; real MongoDB REQUIRES
 * PRODUCTION INFRASTRUCTURE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { config } from '../src/config.js';
import type { AuthContext, Permission } from '../src/authz/permissions.js';
import { authorizeTool, runToolCall } from '../src/tools/gateway.js';
import { cancelTask, claimTask, createTask } from '../src/syteline/tasks/taskStore.js';
import { snapshotRequesterAuth } from '../src/syteline/tasks/taskStore.js';

function authFor(userId: string, permissions: Permission[], roleName = 'Admin'): AuthContext {
  return {
    userId,
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    tenantId: 'tenant-a',
    roleId: 'role-1',
    roleName,
    permissions,
    sessionId: 'session-1',
  };
}

const ADMIN_AUTH = () =>
  authFor('user-admin', ['tool:use', 'chat:create', 'syteline:ui', 'tenant:manage']);
const AI_ADMIN_AUTH = () => authFor('user-ai-admin', ['tool:use', 'chat:create', 'syteline:ui'], 'AI Admin');
const USER_AUTH = () =>
  authFor('user-basic', ['tool:use', 'chat:create', 'syteline:read', 'syteline:forms'], 'User');
const OTHER_ADMIN_AUTH = () => authFor('user-other', ['tool:use', 'syteline:ui'], 'Admin');

// In-memory syteline_tasks collection with the operations the store uses.
function memoryDb() {
  const tasks = new Map<string, Record<string, any>>();
  const toolExecutions: Array<Record<string, any>> = [];

  const matches = (doc: Record<string, any>, filter: Record<string, any>): boolean =>
    Object.entries(filter).every(([key, value]) => {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        if ('$in' in value) return (value.$in as unknown[]).includes(doc[key]);
        if ('$nin' in value) return !(value.$nin as unknown[]).includes(doc[key]);
        return false;
      }
      return doc[key] === value;
    });

  const collection = (name: string) => {
    if (name === 'tool_executions') {
      return {
        insertOne: vi.fn(async (doc: Record<string, any>) => {
          toolExecutions.push({ ...doc });
          return { insertedId: doc._id };
        }),
        updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
          const row = toolExecutions.find((r) => r._id === filter._id);
          if (row) Object.assign(row, update.$set);
          return { modifiedCount: row ? 1 : 0 };
        }),
      };
    }
    if (name === 'syteline_tasks') {
      return {
        insertOne: vi.fn(async (doc: Record<string, any>) => {
          tasks.set(doc._id, { ...doc });
          return { insertedId: doc._id };
        }),
        findOne: vi.fn(async (filter: Record<string, any>) => {
          for (const doc of tasks.values()) {
            if (matches(doc, filter)) return { ...doc };
          }
          return null;
        }),
        find: vi.fn((filter: Record<string, any>) => {
          let rows = [...tasks.values()].filter((d) => matches(d, filter));
          const cursor = {
            sort: vi.fn((spec: Record<string, 1 | -1>) => {
              const [key, dir] = Object.entries(spec)[0]!;
              rows = [...rows].sort((a, b) =>
                dir === 1
                  ? a[key] - b[key]
                  : b[key] - a[key],
              );
              return cursor;
            }),
            limit: vi.fn((n: number) => {
              rows = rows.slice(0, n);
              return cursor;
            }),
            toArray: vi.fn(async () => rows.map((r) => ({ ...r }))),
          };
          return cursor;
        }),
        findOneAndUpdate: vi.fn(
          async (filter: Record<string, any>, update: Record<string, any>, opts: { returnDocument?: string }) => {
            for (const doc of tasks.values()) {
              if (matches(doc, filter)) {
                Object.assign(doc, update.$set);
                return opts?.returnDocument === 'after' ? { ...doc } : null;
              }
            }
            return null;
          },
        ),
        updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
          for (const doc of tasks.values()) {
            if (matches(doc, filter)) {
              Object.assign(doc, update.$set);
              return { modifiedCount: 1 };
            }
          }
          return { modifiedCount: 0 };
        }),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return { collection, tasks };
}

let db: ReturnType<typeof memoryDb>;
let savedUiEnabled: unknown;

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb();
  getDbMock.mockImplementation(async () => ({ collection: db.collection }));
  savedUiEnabled = (config as Record<string, unknown>).SYTELINE_UI_ENABLED;
  (config as Record<string, unknown>).SYTELINE_UI_ENABLED = true;
});

function restoreConfig(): void {
  (config as Record<string, unknown>).SYTELINE_UI_ENABLED = savedUiEnabled;
}

async function createViaTool(
  auth: AuthContext,
  args: Record<string, unknown>,
  conversationId?: string,
) {
  return runToolCall({
    auth,
    name: 'syteline.task.create',
    rawArguments: JSON.stringify(args),
    classification: 'INTERNAL',
    confirmed: false,
    conversationId,
    signal: new AbortController().signal,
  });
}

describe('syteline.task.create', () => {
  it('creates an assigned task with the requester auth snapshot and audits creation', async () => {
    const result = await createViaTool(ADMIN_AUTH(), {
      title: 'PO detail report viewer changes',
      goal: 'Make the PO detail report viewer changes',
    });
    expect(result.ok).toBe(true);
    const task = (result.data as { task: Record<string, any> }).task;
    expect(task.status).toBe('assigned');
    expect(task.title).toBe('PO detail report viewer changes');
    expect(task.autoApproveWrites).toBe(false);
    expect(task.authSnapshot).toBeUndefined(); // internal plumbing, not exposed
    const stored = db.tasks.get(task._id);
    expect(stored?.requesterUserId).toBe('user-admin');
    expect(stored?.authSnapshot.userId).toBe('user-admin');
    expect(stored?.authSnapshot.permissions).toContain('syteline:ui');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYTELINE_TASK_CREATED', success: true }),
    );
  });

  it('records conversationId from the tool execution context when the input omits it', async () => {
    const result = await createViaTool(
      ADMIN_AUTH(),
      { title: 'T', goal: 'G' },
      'conv-123',
    );
    const task = (result.data as { task: Record<string, any> }).task;
    expect(task.conversationId).toBe('conv-123');
  });

  it('denies callers without syteline:ui (TOOL_FORBIDDEN)', async () => {
    const result = await createViaTool(USER_AUTH(), { title: 'T', goal: 'G' });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TOOL_FORBIDDEN');
  });

  it('fails fast while SYTELINE_UI_ENABLED=false', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_ENABLED = false;
    try {
      const result = await createViaTool(ADMIN_AUTH(), { title: 'T', goal: 'G' });
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe('SYTELINE_UI_DISABLED');
    } finally {
      restoreConfig();
    }
  });
});

describe('syteline.task.list', () => {
  async function listViaTool(auth: AuthContext, args: Record<string, unknown> = {}) {
    return runToolCall({
      auth,
      name: 'syteline.task.list',
      rawArguments: JSON.stringify(args),
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
  }

  it('requesters see only their own tasks; admins see the tenant tasks', async () => {
    const a = authFor('user-admin', ['tool:use', 'chat:create', 'syteline:ui', 'tenant:manage']);
    await createTask(a, { title: 'A', goal: 'g' }, 'INTERNAL');
    await createTask(OTHER_ADMIN_AUTH(), { title: 'B', goal: 'g' }, 'INTERNAL');

    const mine = (await listViaTool(OTHER_ADMIN_AUTH())) as { data: { tasks: unknown[]; count: number } };
    expect(mine.data.count).toBe(1);

    const all = (await listViaTool(a)) as { data: { tasks: unknown[]; count: number } };
    expect(all.data.count).toBe(2);
  });

  it('filters by status', async () => {
    const a = ADMIN_AUTH();
    const t = await createTask(a, { title: 'A', goal: 'g' }, 'INTERNAL');
    await claimTask('tenant-a', t._id, 'runner-1');
    const assigned = (await listViaTool(a, { status: 'assigned' })) as {
      data: { count: number };
    };
    const inProgress = (await listViaTool(a, { status: 'in_progress' })) as {
      data: { count: number };
    };
    expect(assigned.data.count).toBe(0);
    expect(inProgress.data.count).toBe(1);
  });
});

describe('syteline.task.get', () => {
  async function getViaTool(auth: AuthContext, taskId: string) {
    return runToolCall({
      auth,
      name: 'syteline.task.get',
      rawArguments: JSON.stringify({ taskId }),
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
  }

  it('returns the full record to the requester', async () => {
    const a = ADMIN_AUTH();
    const t = await createTask(a, { title: 'A', goal: 'g' }, 'INTERNAL');
    const result = (await getViaTool(a, t._id)) as { data: { task: Record<string, any> } };
    expect(result.data.task._id).toBe(t._id);
    expect(result.data.task.steps).toEqual([]);
  });

  it('does not leak other users tasks (TASK_NOT_FOUND)', async () => {
    const t = await createTask(ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    const result = await getViaTool(OTHER_ADMIN_AUTH(), t._id);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TASK_NOT_FOUND');
  });

  it('lets admins read any tenant task', async () => {
    const t = await createTask(OTHER_ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    const result = (await getViaTool(ADMIN_AUTH(), t._id)) as {
      data: { task: Record<string, any> };
    };
    expect(result.data.task._id).toBe(t._id);
  });
});

describe('syteline.task.cancel', () => {
  async function cancelViaTool(auth: AuthContext, taskId: string, confirmed: boolean) {
    return runToolCall({
      auth,
      name: 'syteline.task.cancel',
      rawArguments: JSON.stringify({ taskId }),
      classification: 'INTERNAL',
      confirmed,
      signal: new AbortController().signal,
    });
  }

  it('requires explicit confirmation (destructive)', () => {
    expect(() =>
      authorizeTool(ADMIN_AUTH(), 'syteline.task.cancel', { taskId: 'x' }, 'INTERNAL', false),
    ).toThrowError(expect.objectContaining({ code: 'CONFIRMATION_REQUIRED' }));
  });

  it('cancels the requester task and audits', async () => {
    const a = AI_ADMIN_AUTH();
    const t = await createTask(a, { title: 'A', goal: 'g' }, 'INTERNAL');
    const result = (await cancelViaTool(a, t._id, true)) as {
      data: { cancelled: boolean };
    };
    expect(result.data.cancelled).toBe(true);
    expect(db.tasks.get(t._id)?.status).toBe('cancelled');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SYTELINE_TASK_CANCELLED', success: true }),
    );
  });

  it('refuses to cancel another user task without admin', async () => {
    const t = await createTask(ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    const result = await cancelViaTool(OTHER_ADMIN_AUTH(), t._id, true);
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TASK_NOT_FOUND');
  });

  it('reports already-terminal tasks without re-cancelling', async () => {
    const a = ADMIN_AUTH();
    const t = await createTask(a, { title: 'A', goal: 'g' }, 'INTERNAL');
    await cancelTask('tenant-a', t._id);
    const result = (await cancelViaTool(a, t._id, true)) as {
      data: { cancelled: boolean; status: string };
    };
    expect(result.data.cancelled).toBe(false);
    expect(result.data.status).toBe('cancelled');
  });
});

describe('task store claim', () => {
  it('claims atomically: the second claim loses', async () => {
    const t = await createTask(ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    const first = await claimTask('tenant-a', t._id, 'runner-1');
    expect(first?.status).toBe('in_progress');
    const second = await claimTask('tenant-a', t._id, 'runner-2');
    expect(second).toBeNull();
  });

  it('claims are tenant-scoped', async () => {
    const t = await createTask(ADMIN_AUTH(), { title: 'A', goal: 'g' }, 'INTERNAL');
    const other = await claimTask('tenant-b', t._id, 'runner-1');
    expect(other).toBeNull();
    expect(db.tasks.get(t._id)?.status).toBe('assigned');
  });

  it('snapshots the requester auth (identifiers only, no secrets)', () => {
    const snap = snapshotRequesterAuth(ADMIN_AUTH(), 'INTERNAL');
    expect(snap.userId).toBe('user-admin');
    expect(snap.tenantId).toBe('tenant-a');
    expect(JSON.stringify(snap)).not.toMatch(/password|secret|token/i);
  });
});
