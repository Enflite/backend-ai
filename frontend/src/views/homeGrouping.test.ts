import { describe, expect, it } from 'vitest';
import { groupTasksForHome } from './homeGrouping';
import type { SytelineTaskListItem } from '../api/tasks';

function item(overrides: Partial<SytelineTaskListItem> & { _id: string }): SytelineTaskListItem {
  return {
    title: 'task',
    status: 'assigned',
    createdAt: '2026-10-02T08:00:00.000Z',
    updatedAt: '2026-10-02T08:00:00.000Z',
    ...overrides,
  };
}

const now = new Date('2026-10-02T23:00:00Z');

describe('groupTasksForHome', () => {
  it('routes each display status into its command-center section', () => {
    const items = [
      item({ _id: 'a', status: 'blocked' }),
      item({ _id: 'b', status: 'in_progress' }),
      item({ _id: 'c', status: 'assigned' }),
      item({ _id: 'd', status: 'blocked' }),
      item({ _id: 'e', status: 'completed', completedAt: '2026-10-02T12:00:00-05:00' }),
    ];
    const details = {
      a: { blockedReason: 'awaiting-write-approval' },
      d: { blockedReason: 'invalid-plan' },
    };
    const sections = groupTasksForHome(items, details, now);
    expect(sections.approvals.map((t) => t._id)).toEqual(['a']);
    expect(sections.running.map((t) => t._id).sort()).toEqual(['b', 'c']);
    expect(sections.attention.map((t) => t._id)).toEqual(['d']);
    expect(sections.completedToday.map((t) => t._id)).toEqual(['e']);
  });

  it('drops completed tasks from earlier days and sorts newest first', () => {
    // Wide day margins: correct in every timezone, not just the test runner's.
    const items = [
      item({ _id: 'old', status: 'completed', completedAt: '2026-09-30T23:00:00Z' }),
      item({ _id: 'new', status: 'completed', completedAt: '2026-10-02T16:00:00Z' }),
      item({ _id: 'mid', status: 'completed', completedAt: '2026-10-02T14:00:00Z' }),
      item({ _id: 'no-ts', status: 'completed' }),
    ];
    const sections = groupTasksForHome(items, {}, now);
    expect(sections.completedToday.map((t) => t._id)).toEqual(['new', 'mid']);
  });

  it('leaves cancelled tasks and tasks with unknown details out of every section', () => {
    const items = [item({ _id: 'x', status: 'cancelled' })];
    const sections = groupTasksForHome(items, {}, now);
    expect(sections).toEqual({ approvals: [], running: [], attention: [], completedToday: [] });
  });

  it('treats blocked-without-detail as attention, not approval', () => {
    const items = [item({ _id: 'z', status: 'blocked' })];
    const sections = groupTasksForHome(items, {}, now);
    expect(sections.approvals).toHaveLength(0);
    expect(sections.attention.map((t) => t._id)).toEqual(['z']);
  });
});
