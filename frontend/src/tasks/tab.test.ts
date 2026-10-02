import { describe, expect, it } from 'vitest';
import { DEFAULT_TASK_TAB, TASK_TAB_LABELS, TASK_TABS, parseTaskTab } from './tab';

describe('parseTaskTab', () => {
  it('accepts each known tab value', () => {
    for (const tab of TASK_TABS) {
      expect(parseTaskTab(tab)).toBe(tab);
    }
  });

  it('falls back to the default tab for missing or unknown values', () => {
    expect(parseTaskTab(null)).toBe(DEFAULT_TASK_TAB);
    expect(parseTaskTab(undefined)).toBe(DEFAULT_TASK_TAB);
    expect(parseTaskTab('')).toBe(DEFAULT_TASK_TAB);
    expect(parseTaskTab('bogus')).toBe(DEFAULT_TASK_TAB);
    expect(parseTaskTab('ACTIVITY')).toBe(DEFAULT_TASK_TAB);
  });

  it('maps the renamed pre-R3 tab ids to their successors', () => {
    expect(parseTaskTab('watch')).toBe('activity');
    expect(parseTaskTab('review')).toBe('evidence');
  });

  it('defaults to activity and labels every tab', () => {
    expect(DEFAULT_TASK_TAB).toBe('activity');
    expect(TASK_TAB_LABELS).toEqual({ activity: 'Activity', evidence: 'Evidence', approvals: 'Approvals' });
  });
});
