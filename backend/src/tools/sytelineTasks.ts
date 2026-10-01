/**
 * sytelineTasks.ts — syteline.task.* agentic tool family (DESIGN.md §11.2).
 *
 * The kanban API for the SyteLine task-agent system: create tasks in plain
 * language, list them (the board view), inspect one, cancel one. The
 * server-side task runner (§11.3, syteline/tasks/) picks up `assigned`
 * tasks, plans and executes them as the requester, and reports back.
 *
 * All tools carry permission `syteline:ui` (Admin / AI Admin only — acting
 * as a user in SyteLine is privileged) and fail fast when the
 * SYTELINE_UI_ENABLED master kill-switch is off.
 */

import { config } from '../config.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import type { AuthContext, Classification } from '../authz/permissions.js';
import type {
  ToolDefinition,
  ToolExecutionContext,
} from './gateway.js';
import {
  cancelTaskInput,
  createTaskInput,
  getTaskInput,
  listTasksInput,
  type CreateTaskInput,
  type SytelineTaskDoc,
} from '../syteline/tasks/taskTypes.js';
import {
  assertTaskVisible,
  cancelTask,
  createTask,
  getTask,
  listTasks,
} from '../syteline/tasks/taskStore.js';
import { kickTaskRunner } from '../syteline/tasks/taskScheduler.js';

const TASK_CLASSIFICATIONS: Classification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'PROPRIETARY',
];

function assertTaskUiEnabled(): void {
  if (!config.SYTELINE_UI_ENABLED) {
    throw Errors.badRequest(
      'SYTELINE_UI_DISABLED',
      'SyteLine UI automation is disabled (SYTELINE_UI_ENABLED=false)',
    );
  }
}

/** Admins (tenant:manage) see the tenant's tasks; others see only their own. */
function isTaskAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

/**
 * Public task view: the full record (step log, evidence ids, plan) minus
 * the internal auth snapshot, which is runner plumbing.
 */
function publicTaskView(task: SytelineTaskDoc): Record<string, unknown> {
  const { authSnapshot: _authSnapshot, ...rest } = task;
  void _authSnapshot;
  return {
    ...rest,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
    startedAt: task.startedAt?.toISOString(),
    completedAt: task.completedAt?.toISOString(),
  };
}

export const sytelineTaskToolDefinitions: readonly ToolDefinition<any>[] = [
  {
    name: 'syteline.task.create',
    description:
      'Create a SyteLine task for the AI task-agent system: describe the work in plain language ' +
      '(e.g. "make the PO detail report viewer changes", "check why order 12345 is late"). ' +
      'The task runner picks it up, plans the browser steps, drives SyteLine as YOU (your saved ' +
      'credentials), and reports back with evidence. autoApproveWrites=true is YOUR explicit ' +
      'confirmation for THIS task\'s write steps only — bounded to this task, recorded, auditable. ' +
      'Default false: the agent does read-only reconnaissance, then parks the task as ' +
      'blocked/awaiting-write-approval with the proposed plan. Only ever create a task when the ' +
      'user explicitly asks for SyteLine work to be done.',
    action: 'create-task',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: TASK_CLASSIFICATIONS,
    schema: createTaskInput,
    execute: async (
      input: CreateTaskInput,
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertTaskUiEnabled();
      const task = await createTask(
        ctx.auth,
        input,
        ctx.classification,
        ctx.conversationId ?? input.conversationId,
      );
      await recordAudit({
        tenantId: ctx.auth.tenantId,
        userId: ctx.auth.userId,
        requestId: ctx.requestId,
        action: 'SYTELINE_TASK_CREATED',
        success: true,
        metadata: {
          taskId: task._id,
          title: task.title,
          autoApproveWrites: task.autoApproveWrites,
        },
      });
      // Nudge the runner for an out-of-band sweep (no-op when disabled).
      kickTaskRunner();
      return { task: publicTaskView(task) };
    },
  },
  {
    name: 'syteline.task.list',
    description:
      'List SyteLine tasks (the kanban board API): optionally filter by status ' +
      '(assigned, in_progress, completed, blocked, cancelled). Admins see the tenant\'s tasks; ' +
      'everyone else sees only their own.',
    action: 'list-tasks',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: TASK_CLASSIFICATIONS,
    schema: listTasksInput,
    execute: async (
      input: { status?: SytelineTaskDoc['status'] },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertTaskUiEnabled();
      const tasks = await listTasks(
        ctx.auth.tenantId,
        ctx.auth.userId,
        isTaskAdmin(ctx.auth),
        input.status,
      );
      return { tasks: tasks.map(publicTaskView), count: tasks.length };
    },
  },
  {
    name: 'syteline.task.get',
    description:
      'Get one SyteLine task: full record including the plan, per-step execution log, ' +
      'screenshot evidence ids, result summary, or blocked reason.',
    action: 'get-task',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: TASK_CLASSIFICATIONS,
    schema: getTaskInput,
    execute: async (
      input: { taskId: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertTaskUiEnabled();
      const task = await getTask(ctx.auth.tenantId, input.taskId);
      if (!task) throw Errors.notFound('TASK_NOT_FOUND', 'Task not found');
      assertTaskVisible(task, ctx.auth.userId, isTaskAdmin(ctx.auth));
      return { task: publicTaskView(task) };
    },
  },
  {
    name: 'syteline.task.cancel',
    description:
      'Cancel a SyteLine task (assigned or in_progress). Destructive: needs explicit ' +
      'confirmation. Only the requester or an admin can cancel.',
    action: 'cancel-task',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: TASK_CLASSIFICATIONS,
    schema: cancelTaskInput,
    execute: async (
      input: { taskId: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertTaskUiEnabled();
      const task = await getTask(ctx.auth.tenantId, input.taskId);
      if (!task) throw Errors.notFound('TASK_NOT_FOUND', 'Task not found');
      assertTaskVisible(task, ctx.auth.userId, isTaskAdmin(ctx.auth));
      const cancelled = await cancelTask(ctx.auth.tenantId, input.taskId);
      if (!cancelled) {
        return { cancelled: false, status: task.status, reason: 'already terminal' };
      }
      await recordAudit({
        tenantId: ctx.auth.tenantId,
        userId: ctx.auth.userId,
        requestId: ctx.requestId,
        action: 'SYTELINE_TASK_CANCELLED',
        success: true,
        metadata: { taskId: task._id, title: task.title },
      });
      return { cancelled: true, taskId: task._id };
    },
  },
];
