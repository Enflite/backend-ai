/**
 * api/tasks.ts — SyteLine task-agent runs via the generic tool endpoint.
 *
 * The board's data source for task cards: syteline.task.list / get / create
 * (backend/src/tools/sytelineTasks.ts). Public views strip the internal
 * auth snapshot; dates arrive as ISO strings.
 */
import { executeTool } from './tools';
import { api } from '../api';
import type { DataClassification } from '../types';

export type SytelineTaskStatus = 'assigned' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';

export interface TaskStepLog {
  action: string;
  detail?: string;
  status: 'pending' | 'running' | 'ok' | 'failed' | 'skipped';
  startedAt?: string;
  completedAt?: string;
  evidenceIds: string[];
  observation?: string;
  errorCode?: string;
}

export interface SytelineTaskListItem {
  _id: string;
  title: string;
  status: SytelineTaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface SytelineTaskDetail extends SytelineTaskListItem {
  goal: string;
  plan: unknown[];
  steps: TaskStepLog[];
  autoApproveWrites: boolean;
  /** Who asked for the work — creation-time record from the task store. */
  requesterUserId?: string;
  resultSummary?: string;
  blockedReason?: string;
  conversationId?: string;
  startedAt?: string;
  runnerId?: string;
}

export interface CreateSytelineTaskInput {
  title: string;
  goal: string;
  autoApproveWrites?: boolean;
  /** Optional originating conversation: the runner posts its report there. */
  conversationId?: string;
}

async function call<T>(tool: string, parameters: Record<string, unknown>, classification: DataClassification): Promise<T> {
  const { result } = await executeTool<{ task?: T; tasks?: T } | T>(tool, parameters, classification);
  // Tool results wrap the payload as { task } / { tasks }; unwrap one level.
  if (result && typeof result === 'object' && !Array.isArray(result)) {
    const wrapped = result as { task?: T; tasks?: T };
    if (wrapped.task !== undefined) return wrapped.task;
    if (wrapped.tasks !== undefined) return wrapped.tasks;
  }
  return result as T;
}

export async function listSytelineTasks(
  classification: DataClassification,
  status?: SytelineTaskStatus,
): Promise<SytelineTaskListItem[]> {
  return call<SytelineTaskListItem[]>('syteline.task.list', status ? { status } : {}, classification);
}

export async function getSytelineTask(
  classification: DataClassification,
  taskId: string,
): Promise<SytelineTaskDetail> {
  return call<SytelineTaskDetail>('syteline.task.get', { taskId }, classification);
}

export async function createSytelineTask(
  classification: DataClassification,
  input: CreateSytelineTaskInput,
): Promise<SytelineTaskDetail> {
  return call<SytelineTaskDetail>('syteline.task.create', { ...input }, classification);
}

export async function cancelSytelineTask(
  classification: DataClassification,
  taskId: string,
  confirmed: boolean,
): Promise<{ cancelled: boolean; status: SytelineTaskStatus; reason?: string }> {
  // syteline.task.cancel is destructive: the tool gateway enforces the
  // confirmation gate, so the UI must confirm first and pass confirmed=true.
  const { result } = await executeTool<{ cancelled: boolean; status: SytelineTaskStatus; reason?: string }>(
    'syteline.task.cancel',
    { taskId },
    classification,
    confirmed,
  );
  return result;
}

/**
 * Re-queue a blocked task so the runner picks it up again. Pass
 * approveWrites=true to approve the task's proposed write plan
 * (task-bounded write approval); omit to keep the current setting
 * (e.g. re-queueing after an external dependency clears).
 */
export async function requeueSytelineTask(
  classification: DataClassification,
  taskId: string,
  approveWrites?: boolean,
): Promise<SytelineTaskDetail> {
  return call<SytelineTaskDetail>(
    'syteline.task.requeue',
    approveWrites === undefined ? { taskId } : { taskId, approveWrites },
    classification,
  );
}

export interface GeneratedBoardTask {
  id: string;
  title: string;
}

/**
 * Ask the AI to break a plain-language goal into board tasks
 * (POST /syteline-tasks/generate). The server validates the model's output
 * and creates each task through the real task path; the runner picks them
 * up like any hand-created task. No classification parameter: the server
 * uses the requester's clearance.
 */
export async function generateSytelineTasks(input: {
  goal: string;
  count?: number;
}): Promise<{ tasks: GeneratedBoardTask[] }> {
  return api.request('/syteline-tasks/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
}

/** Success copy for the generate box. Pure — unit tested. */
export function generationConfirmation(count: number): string {
  return `Created ${count} task${count === 1 ? '' : 's'} — the AI will pick them up from the board.`;
}
