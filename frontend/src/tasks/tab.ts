/**
 * tasks/tab.ts — the TaskWorkspace tab model.
 *
 * The workspace tabs (Activity / Evidence / Approvals) are URL-synced via
 * `?tab=` so deep links and reloads land on the right view. Parsing is
 * defensive: missing or unknown values fall back to the default tab. The
 * pre-R3 ids (`watch`, `review`) still map to their renamed tabs so old
 * deep links keep working.
 */

export const TASK_TABS = ['activity', 'evidence', 'approvals'] as const;

/** The workspace tabs, in display order. */
export type TaskTab = (typeof TASK_TABS)[number];

export const TASK_TAB_LABELS: Record<TaskTab, string> = {
  activity: 'Activity',
  evidence: 'Evidence',
  approvals: 'Approvals',
};

export const DEFAULT_TASK_TAB: TaskTab = 'activity';

/** Renamed tab ids — legacy `?tab=` values resolve to their successors. */
const LEGACY_TASK_TABS: Record<string, TaskTab> = {
  watch: 'activity',
  review: 'evidence',
};

/** Parse a raw `?tab=` value into a valid tab; anything else → default. */
export function parseTaskTab(value: string | null | undefined): TaskTab {
  if (value !== undefined && value !== null) {
    if ((TASK_TABS as readonly string[]).includes(value)) {
      return value as TaskTab;
    }
    const legacy = LEGACY_TASK_TABS[value];
    if (legacy) return legacy;
  }
  return DEFAULT_TASK_TAB;
}
