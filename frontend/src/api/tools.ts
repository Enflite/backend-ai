/**
 * api/tools.ts — generic agentic-tool execution.
 *
 * Task-agent runs (syteline.task.*) and SyteLine ops (syteline.ui.*) are
 * tools-only: no dedicated REST endpoints exist, so the frontend drives
 * them through POST /tools/:name/execute like the chat loop does.
 */
import { api } from '../api';
import type { DataClassification } from '../types';

export interface ToolExecution<T = unknown> {
  executionId: string;
  result: T;
  truncated: boolean;
}

/**
 * Classification to stamp on direct tool calls: mirrors the chat default —
 * a PUBLIC-only caller defaults to PUBLIC (INTERNAL would exceed their
 * clearance), everyone else to INTERNAL.
 */
export function defaultToolClassification(clearance: DataClassification): DataClassification {
  return clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
}

export async function executeTool<T = unknown>(
  name: string,
  parameters: Record<string, unknown>,
  classification: DataClassification,
  confirmed = false,
): Promise<ToolExecution<T>> {
  return api.request<ToolExecution<T>>(`/tools/${encodeURIComponent(name)}/execute`, {
    method: 'POST',
    body: JSON.stringify({ parameters, classification, confirmed }),
  });
}
