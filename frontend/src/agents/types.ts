/**
 * agents/types.ts — presentation model for the Agent Task Workspace.
 *
 * Maps the backend task lifecycle (`assigned / in_progress / completed /
 * blocked / cancelled` + per-step `pending / running / ok / failed /
 * skipped`) onto the workspace's human status language. Every status carries
 * icon + text — never color alone.
 *
 * Honesty rule: these are pure mappings over real backend state. Nothing
 * here invents activity.
 */
import type { SytelineTaskDetail, SytelineTaskStatus, TaskStepLog } from '../api/tasks';

/** Wire value the backend uses when a task parks for write approval (§11.4). */
export const AWAITING_WRITE_APPROVAL = 'awaiting-write-approval';

/** Human-facing task states shown in the workspace. */
export type TaskDisplayStatus =
  | 'queued'
  | 'running'
  | 'waiting_approval'
  | 'blocked'
  | 'failed'
  | 'completed'
  | 'cancelled';

export interface DisplayStatus {
  status: TaskDisplayStatus;
  /** Short human label, always rendered next to the icon. */
  label: string;
  /** Raw backend reason, shown as subordinate text when present. */
  reason?: string;
}

/**
 * blockedReasons that mean "the world stopped us" (as opposed to a step
 * failing or approval waiting). Everything else blocked is surfaced as
 * Failed so step errors aren't softened.
 */
const BLOCKED_REASONS = new Set([
  'invalid-plan',
  'requester-lost-permission',
  'requester-lost-clearance',
]);

function isBlockedReason(value: string | undefined): boolean {
  if (!value) return false;
  if (BLOCKED_REASONS.has(value)) return true;
  return value.startsWith('externally-stopped:');
}

export function taskDisplayStatus(task: {
  status: SytelineTaskStatus;
  blockedReason?: string;
}): DisplayStatus {
  switch (task.status) {
    case 'assigned':
      return { status: 'queued', label: 'Queued' };
    case 'in_progress':
      return { status: 'running', label: 'Running' };
    case 'completed':
      return { status: 'completed', label: 'Completed' };
    case 'cancelled':
      return { status: 'cancelled', label: 'Cancelled' };
    case 'blocked': {
      const reason = task.blockedReason;
      if (reason === AWAITING_WRITE_APPROVAL) {
        return {
          status: 'waiting_approval',
          label: 'Waiting for approval',
          reason: 'The agent finished its read-only checks and proposed a write plan.',
        };
      }
      if (isBlockedReason(reason)) {
        return { status: 'blocked', label: 'Blocked', reason };
      }
      return { status: 'failed', label: 'Failed', reason };
    }
  }
}

/** Human-facing step states. */
export type StepDisplayStatus = 'pending' | 'running' | 'done' | 'verified' | 'failed' | 'skipped';

export function stepDisplayStatus(step: TaskStepLog, planAction?: string): StepDisplayStatus {
  switch (step.status) {
    case 'ok':
      // assertText / readScreen steps that passed genuinely verified something.
      return planAction === 'assertText' || planAction === 'readScreen' ? 'verified' : 'done';
    case 'failed':
      return 'failed';
    case 'running':
      return 'running';
    case 'skipped':
      return 'skipped';
    default:
      return 'pending';
  }
}

/** Friendly one-line rendering of a runTaskPlan DSL step (unknown shape → raw action name). */
export function describePlanStep(step: unknown): string {
  if (!step || typeof step !== 'object') return 'Unknown step';
  const s = step as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (s.action) {
    case 'gotoForm':
      return `Go to the ${str(s.form)} form`;
    case 'fillField':
      return `Fill “${str(s.label)}” with “${str(s.value)}”`;
    case 'clickButton':
      return `Click “${str(s.label)}”`;
    case 'readScreen':
      return 'Read the screen';
    case 'assertText':
      return `Verify the screen shows “${str(s.text)}”`;
    default:
      return String(s.action ?? 'Unknown step');
  }
}

/** True for steps that change SyteLine state (the approval gate cares). */
export function isWriteStepAction(action: string | undefined): boolean {
  return action === 'fillField' || action === 'clickButton';
}

export function planActionOf(plan: unknown[], index: number): string | undefined {
  const s = plan[index] as Record<string, unknown> | undefined;
  const action = s?.action;
  return typeof action === 'string' ? action : undefined;
}

/**
 * Splits a task's steps into the read-only checks that already ran and the
 * write steps still proposed. Used by the approval panel.
 */
export function splitReconVsProposed(task: SytelineTaskDetail): {
  completed: TaskStepLog[];
  proposed: { index: number; description: string }[];
} {
  const completed: TaskStepLog[] = [];
  const proposed: { index: number; description: string }[] = [];
  task.steps.forEach((step, index) => {
    if (step.status === 'ok') {
      completed.push(step);
    } else if (step.status === 'skipped' || step.status === 'pending') {
      proposed.push({ index, description: describePlanStep(task.plan[index]) });
    }
  });
  return { completed, proposed };
}

/** Progress across the step log: completed (ok) steps over total. */
export function taskProgress(task: Pick<SytelineTaskDetail, 'steps'>): {
  done: number;
  total: number;
} {
  const total = task.steps.length;
  const done = task.steps.filter((s) => s.status === 'ok').length;
  return { done, total };
}

/**
 * Parses the runner's "Proposed write plan (awaiting approval)" summary
 * into numbered lines. Returns null when the summary isn't in that shape —
 * the panel then falls back to the step list.
 */
export function parseProposedPlan(summary: string | undefined): string[] | null {
  if (!summary || !summary.includes('awaiting approval')) return null;
  const lines = summary
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\d+\.\s/.test(line));
  return lines.length > 0 ? lines : null;
}
