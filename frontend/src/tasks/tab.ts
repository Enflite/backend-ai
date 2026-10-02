/**
 * tasks/tab.ts — the TaskWorkspace tab model.
 *
 * The workspace tabs (Watch / Review / Approvals) are URL-synced via
 * `?tab=` so deep links and reloads land on the right view. Parsing is
 * defensive: missing or unknown values fall back to the default tab.
 */

export const TASK_TABS = ['watch', 'review', 'approvals'] as const;

/** The workspace tabs, in display order. */
export type TaskTab = (typeof TASK_TABS)[number];

export const TASK_TAB_LABELS: Record<TaskTab, string> = {
  watch: 'Watch',
  review: 'Review',
  approvals: 'Approvals',
};

export const DEFAULT_TASK_TAB: TaskTab = 'watch';

/** Parse a raw `?tab=` value into a valid tab; anything else → default. */
export function parseTaskTab(value: string | null | undefined): TaskTab {
  if (value !== undefined && value !== null && (TASK_TABS as readonly string[]).includes(value)) {
    return value as TaskTab;
  }
  return DEFAULT_TASK_TAB;
}
