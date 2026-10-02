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
    expect(parseTaskTab('WATCH')).toBe(DEFAULT_TASK_TAB);
  });

  it('defaults to watch and labels every tab', () => {
    expect(DEFAULT_TASK_TAB).toBe('watch');
    expect(TASK_TAB_LABELS).toEqual({ watch: 'Watch', review: 'Review', approvals: 'Approvals' });
  });
});
