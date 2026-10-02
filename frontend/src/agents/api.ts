/**
 * agents/api.ts — workspace data access for SyteLine agent tasks.
 *
 * Reuses the task tool endpoints (`frontend/src/api/tasks.ts`). The approve
 * call targets the `syteline.task.approve` contract (requester-only approval
 * of a task parked as blocked/awaiting-write-approval); when the backend
 * does not provide it yet the gateway answers TOOL_NOT_FOUND and callers
 * render an honest "awaiting backend support" state — never fake approval.
 */
import { api, ApiError } from '../api';
import { executeTool, defaultToolClassification } from '../api/tools';
import type { DataClassification } from '../types';
import type { SytelineTaskStatus } from '../api/tasks';

export {
  listSytelineTasks,
  getSytelineTask,
  createSytelineTask,
  cancelSytelineTask,
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

export interface ApproveTaskResult {
  approved: boolean;
  status: SytelineTaskStatus;
  blockedReason?: string | null;
  reason?: string;
  taskId?: string;
}

/**
 * Approve a task parked awaiting write approval. The tool is destructive
 * (gateway confirmation-gated), so the UI confirms first and passes
 * confirmed=true — mirroring the cancel flow.
 *
 * Throws ApiError with code TOOL_NOT_FOUND when the backend does not
 * provide `syteline.task.approve` yet.
 */
export async function approveSytelineTask(
  classification: DataClassification,
  taskId: string,
  confirmed: boolean,
): Promise<ApproveTaskResult> {
  const { result } = await executeTool<ApproveTaskResult>(
    'syteline.task.approve',
    { taskId },
    classification,
    confirmed,
  );
  return result;
}

/** True when an error means "the backend doesn't offer this capability yet". */
export function isNotWiredError(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'TOOL_NOT_FOUND';
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
