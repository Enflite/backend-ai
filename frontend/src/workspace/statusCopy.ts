/**
 * workspace/statusCopy.ts — pure presentation helpers for the agent
 * execution workspace.
 *
 * Every string here is derived from real task API state (the agents/types
 * display mappings plus task timestamps, steps, and the runner's own
 * words) — nothing invents activity. Unit tested; the components render
 * exactly what these return.
 */
import type { SytelineTaskDetail, TaskStepLog } from '../api/tasks';
import {
  describePlanStep,
  taskDisplayStatus,
  taskProgress,
  type TaskDisplayStatus,
} from '../agents/types';
import { relativeTime } from '../board/types';

/** Relay run-header status line, driven by the real task status. */
export function liveStatusText(status: TaskDisplayStatus): string {
  switch (status) {
    case 'running':
      return 'Agent is working';
    case 'waiting_approval':
      return 'Waiting for approval';
    case 'queued':
      return 'Queued';
    case 'completed':
      return 'Ready for review';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Needs attention';
    case 'cancelled':
      return 'Cancelled';
  }
}

/** Sidebar status-dot colors. Running pulses (see TaskDot); the label next
 * to each row and the badge in the run header carry the state in words —
 * never color alone. */
export const TASK_DOT_COLORS: Record<TaskDisplayStatus, string> = {
  running: 'var(--accent)',
  waiting_approval: '#d97706',
  queued: 'var(--muted-foreground)',
  failed: 'var(--danger)',
  blocked: 'var(--danger)',
  completed: '#15803d',
  cancelled: 'var(--muted-foreground)',
};

export interface RunSummary {
  /** The live status line ("Agent is working", …). */
  statusText: string;
  /** What the agent is actually doing — a real step, plan, or state. */
  title: string;
  /** Supporting real detail: the runner's words, progress, or reason. */
  detail: string;
  /** Elapsed line built from real timestamps. */
  elapsed: string;
}

function firstLine(text: string | undefined, max = 140): string {
  if (!text) return '';
  const line = text.split('\n').map((part) => part.trim()).find(Boolean) ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function lastIndexOf(steps: TaskStepLog[], statuses: ReadonlySet<TaskStepLog['status']>): number {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (statuses.has(steps[i].status)) return i;
  }
  return -1;
}

function elapsedFor(task: SytelineTaskDetail, status: TaskDisplayStatus): string {
  switch (status) {
    case 'running':
      return task.startedAt ? `Started ${relativeTime(task.startedAt)}` : `Updated ${relativeTime(task.updatedAt)}`;
    case 'completed':
      return task.completedAt ? `Finished ${relativeTime(task.completedAt)}` : `Updated ${relativeTime(task.updatedAt)}`;
    case 'queued':
      return `Created ${relativeTime(task.createdAt)}`;
    case 'cancelled':
      return `Cancelled ${relativeTime(task.updatedAt)}`;
    default:
      return `Updated ${relativeTime(task.updatedAt)}`;
  }
}

/**
 * The Relay-style run summary for a task: a live status line plus the
 * freshest real signal — the running step, the runner's summary, or the
 * blocker the backend reported.
 */
export function runSummary(task: SytelineTaskDetail): RunSummary {
  const display = taskDisplayStatus(task);
  const statusText = liveStatusText(display.status);
  const elapsed = elapsedFor(task, display.status);
  const { done, total } = taskProgress(task);
  const steps = task.steps;

  switch (display.status) {
    case 'running': {
      const index = lastIndexOf(steps, new Set(['running']));
      if (index < 0) {
        return {
          statusText,
          title: 'Planning the work',
          detail: 'The agent is drafting its plan before touching SyteLine.',
          elapsed,
        };
      }
      const step = steps[index];
      return {
        statusText,
        title: describePlanStep(task.plan[index]),
        detail:
          firstLine(step.observation) ||
          (total > 0 ? `${done} of ${total} steps done` : 'The run just started.'),
        elapsed,
      };
    }
    case 'waiting_approval':
      return {
        statusText,
        title: 'The agent proposed a write plan',
        detail: 'Review it in the Approvals tab — nothing changes in SyteLine until you approve.',
        elapsed,
      };
    case 'queued':
      return {
        statusText,
        title: 'Waiting for the runner',
        detail: 'The runner picks this task up next.',
        elapsed,
      };
    case 'completed':
      return {
        statusText,
        title: firstLine(task.resultSummary) || 'Run finished',
        detail: total > 0 ? `${done} of ${total} steps completed` : 'No steps were recorded for this run.',
        elapsed,
      };
    case 'failed': {
      const index = lastIndexOf(steps, new Set(['failed']));
      const step = index >= 0 ? steps[index] : null;
      return {
        statusText,
        title: step ? describePlanStep(task.plan[index]) : 'A step failed',
        detail:
          (step?.errorCode ? `${step.errorCode} — ` : '') + (firstLine(step?.observation) || firstLine(task.blockedReason) || 'Open the task to see what happened.'),
        elapsed,
      };
    }
    case 'blocked':
      return {
        statusText,
        title: 'The run is blocked',
        detail: firstLine(task.blockedReason) || 'Open the task to see what stopped it.',
        elapsed,
      };
    case 'cancelled':
      return {
        statusText,
        title: 'Run cancelled',
        detail: total > 0 ? `${done} of ${total} steps had completed.` : 'The run was cancelled before any steps ran.',
        elapsed,
      };
  }
}

/** Sidebar order: needs-a-human first, then active, then the archive. */
const SECTION_RANK: Record<TaskDisplayStatus, number> = {
  waiting_approval: 0,
  running: 1,
  queued: 2,
  failed: 3,
  blocked: 3,
  completed: 4,
  cancelled: 5,
};

/**
 * Orders sidebar tasks the way the landing grouped them — waiting for
 * approval, running, queued, failed/blocked, completed — newest first
 * inside each group. ISO timestamps sort lexicographically.
 */
export function sortTasksForSidebar<T extends { _id: string; status: SytelineTaskDetail['status']; updatedAt: string }>(
  items: T[],
  blockedReasons: Record<string, string | undefined>,
): T[] {
  return [...items].sort((a, b) => {
    const rankA = SECTION_RANK[taskDisplayStatus({ status: a.status, blockedReason: blockedReasons[a._id] }).status];
    const rankB = SECTION_RANK[taskDisplayStatus({ status: b.status, blockedReason: blockedReasons[b._id] }).status];
    if (rankA !== rankB) return rankA - rankB;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}
