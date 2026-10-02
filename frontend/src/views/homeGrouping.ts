/**
 * views/homeGrouping.ts — pure section grouping for the command-center home.
 *
 * Groups live SyteLine tasks into the command center's agent-loop sections:
 * needs your approval (waiting_approval) → running now (non-terminal, not
 * waiting) → needs attention (failed/blocked) → completed today. No
 * invented data: pure mapping over real list items + fetched details.
 */
import { localDay } from '../board/types';
import { taskDisplayStatus } from '../agents/types';
import type { SytelineTaskListItem, TaskStepLog } from '../api/tasks';

export interface HomeTaskDetail {
  blockedReason?: string;
  steps?: TaskStepLog[];
}

export interface HomeSections {
  /** waiting_approval: the agent paused for a decision. */
  approvals: SytelineTaskListItem[];
  /** queued + running: active, non-terminal, not waiting. */
  running: SytelineTaskListItem[];
  /** failed + blocked: need attention. */
  attention: SytelineTaskListItem[];
  /** completed today (local day), newest first. */
  completedToday: SytelineTaskListItem[];
}

export function groupTasksForHome(
  items: SytelineTaskListItem[],
  details: Record<string, HomeTaskDetail>,
  now: Date = new Date(),
): HomeSections {
  const sections: HomeSections = { approvals: [], running: [], attention: [], completedToday: [] };
  const today = localDay(now);
  for (const item of items) {
    const detail = details[item._id];
    const display = taskDisplayStatus({ status: item.status, blockedReason: detail?.blockedReason });
    switch (display.status) {
      case 'waiting_approval':
        sections.approvals.push(item);
        break;
      case 'running':
      case 'queued':
        sections.running.push(item);
        break;
      case 'failed':
      case 'blocked':
        sections.attention.push(item);
        break;
      case 'completed':
        if (item.completedAt && localDay(new Date(item.completedAt)) === today) {
          sections.completedToday.push(item);
        }
        break;
      default:
        break;
    }
  }
  sections.completedToday.sort((a, b) => (b.completedAt ?? '').localeCompare(a.completedAt ?? ''));
  return sections;
}
