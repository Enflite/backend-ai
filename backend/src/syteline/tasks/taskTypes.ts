/**
 * taskTypes.ts — SyteLine task-agent data model (DESIGN.md §11.1).
 *
 * A task is a unit of SyteLine work handed to the system in plain language.
 * The task runner (§11.3, taskRunner.ts) claims `assigned` tasks, generates
 * a runTaskPlan DSL plan with the model, executes it as the task's requester
 * through their own UI session, and reports back. Statuses map onto the
 * kanban board columns (assigned / in progress / completed / blocked);
 * the frontend board itself is out of scope — `syteline.task.list` is the
 * board's API.
 */

import { z } from 'zod';

/** Kanban lifecycle. Terminal states: completed, blocked, cancelled. */
export const TASK_STATUSES = [
  'assigned',
  'in_progress',
  'completed',
  'blocked',
  'cancelled',
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = [
  'completed',
  'blocked',
  'cancelled',
];

/** Per-step execution log entry. `detail` carries identifier keys only — never values. */
export interface TaskStepLog {
  action: string;
  detail?: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  startedAt?: Date;
  completedAt?: Date;
  evidenceIds: string[];
  /** Truncated observation for readScreen steps (tenant-scoped, like tool results). */
  observation?: string;
  errorCode?: string;
}

/**
 * Snapshot of the requester's auth context, taken at task creation.
 * This is the creation-time record: who asked, with what permissions, in
 * which tenant. The runner resolves the requester's LIVE auth at run time
 * (same permission resolution as login) and fails closed when the live
 * context is gone or no longer holds `syteline:ui` — a demotion or
 * deactivation after task creation must not keep driving the user's
 * SyteLine session. Contains identifiers only, never secrets.
 */
export interface TaskAuthSnapshot {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
  clearance: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  classification: string;
}

/** Mongo document shape for the `syteline_tasks` collection (tenant-scoped). */
export interface SytelineTaskDoc {
  _id: string;
  tenantId: string;
  requesterUserId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  /** Validated runTaskPlan DSL steps (zod-checked before execution). */
  plan: unknown[];
  steps: TaskStepLog[];
  /**
   * Scoped human confirmation for this task's writes: `true` on create IS
   * the explicit confirmation for that task's write steps — bounded to this
   * task's plan, recorded on the task, auditable. Default false: the runner
   * does read-only reconnaissance, records the proposed write plan, and
   * marks the task blocked/awaiting-write-approval.
   */
  autoApproveWrites: boolean;
  resultSummary?: string;
  blockedReason?: string;
  conversationId?: string;
  authSnapshot: TaskAuthSnapshot;
  runnerId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Tool input schemas (syteline.task.*, all permission `syteline:ui`)
// ---------------------------------------------------------------------------

export const taskIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'taskId must be a 1-64 char identifier');

export const createTaskInput = z
  .object({
    title: z.string().min(1).max(120),
    goal: z.string().min(1).max(2000),
    autoApproveWrites: z.boolean().optional().default(false),
    conversationId: z.string().max(128).optional(),
  })
  .strict();

export const listTasksInput = z
  .object({
    status: z.enum(TASK_STATUSES).optional(),
  })
  .strict();

export const getTaskInput = z.object({ taskId: taskIdParam }).strict();

export const cancelTaskInput = z.object({ taskId: taskIdParam }).strict();

export type CreateTaskInput = z.input<typeof createTaskInput>;
export type ListTasksInput = z.infer<typeof listTasksInput>;
