/**
 * agents/api.ts — workspace data access for SyteLine agent tasks.
 *
 * Reuses the task tool endpoints (`frontend/src/api/tasks.ts`). Approval is
 * implemented on top of the real `syteline.task.requeue` tool with
 * `approveWrites: true` (task-bounded write approval for a task parked as
 * blocked/awaiting-write-approval).
 */
import { api } from '../api';
import { defaultToolClassification } from '../api/tools';
import type { DataClassification } from '../types';
import {
  requeueSytelineTask,
  type SytelineTaskDetail,
} from '../api/tasks';

export {
  listSytelineTasks,
  getSytelineTask,
  createSytelineTask,
  cancelSytelineTask,
  requeueSytelineTask,
} from '../api/tasks';
export type {
  SytelineTaskDetail,
  SytelineTaskListItem,
  SytelineTaskStatus,
  TaskStepLog,
  CreateSytelineTaskInput,
} from '../api/tasks';

export function toolClassificationFor(clearance: DataClassification): DataClassification {
  return defaultToolClassification(clearance);
}

/**
 * Approve a task parked awaiting write approval: re-queues it with
 * task-bounded write approval (`syteline.task.requeue` with
 * `approveWrites: true`). The runner picks the task back up and runs the
 * approved changes as the requester. Throws when the task is no longer
 * blocked (ApiError code TASK_NOT_BLOCKED).
 */
export async function approveSytelineTask(
  classification: DataClassification,
  taskId: string,
): Promise<SytelineTaskDetail> {
  return requeueSytelineTask(classification, taskId, true);
}

/**
 * Fetches one screenshot evidence PNG as a Blob (the endpoint needs the
 * Bearer token, so plain <img src> can't be used). Callers create an object
 * URL and revoke it on unmount.
 */
export async function fetchTaskEvidence(taskId: string, evidenceId: string): Promise<Blob> {
  return api.blob(
    `/syteline-tasks/${encodeURIComponent(taskId)}/evidence/${encodeURIComponent(evidenceId)}`,
  );
}
