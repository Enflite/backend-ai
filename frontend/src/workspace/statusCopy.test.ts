import { describe, expect, it } from 'vitest';
import { liveStatusText, runSummary, sortTasksForSidebar } from './statusCopy';
import type { SytelineTaskDetail } from '../api/tasks';

function baseTask(overrides: Partial<SytelineTaskDetail> = {}): SytelineTaskDetail {
  return {
    _id: 'task-1',
    title: 'Bring TRN up to date',
    status: 'in_progress',
    createdAt: '2026-10-02T14:00:00.000Z',
    updatedAt: '2026-10-02T15:00:00.000Z',
    goal: 'Do the thing.',
    plan: [{ action: 'readScreen' }, { action: 'fillField', label: 'Name', value: 'x' }],
    steps: [],
    autoApproveWrites: false,
    ...overrides,
  };
}

describe('liveStatusText', () => {
  it('maps every display status to its run-header line', () => {
    expect(liveStatusText('running')).toBe('Agent is working');
    expect(liveStatusText('waiting_approval')).toBe('Waiting for approval');
    expect(liveStatusText('queued')).toBe('Queued');
    expect(liveStatusText('completed')).toBe('Ready for review');
    expect(liveStatusText('blocked')).toBe('Blocked');
    expect(liveStatusText('failed')).toBe('Needs attention');
    expect(liveStatusText('cancelled')).toBe('Cancelled');
  });
});

describe('runSummary', () => {
  it('describes the running step and its observation', () => {
    const summary = runSummary(
      baseTask({
        startedAt: '2026-10-02T14:30:00.000Z',
        steps: [
          { action: 'readScreen', status: 'ok', evidenceIds: [], observation: 'Saw the grid.' },
          { action: 'fillField', status: 'running', evidenceIds: [], observation: 'Typing into the field…' },
        ],
      }),
    );
    expect(summary.statusText).toBe('Agent is working');
    expect(summary.title).toBe('Fill “Name” with “x”');
    expect(summary.detail).toBe('Typing into the field…');
    expect(summary.elapsed).toContain('Started');
  });

  it('is honest when the agent is still planning', () => {
    const summary = runSummary(baseTask());
    expect(summary.title).toBe('Planning the work');
    expect(summary.detail).toContain('drafting its plan');
  });

  it('names the failed step and its error code', () => {
    const summary = runSummary(
      baseTask({
        status: 'blocked',
        blockedReason: 'STEP_FAILED',
        steps: [
          { action: 'clickButton', status: 'failed', evidenceIds: [], observation: 'Button not found.', errorCode: 'ELEMENT_NOT_FOUND' },
        ],
      }),
    );
    expect(summary.statusText).toBe('Needs attention');
    expect(summary.detail).toContain('ELEMENT_NOT_FOUND');
    expect(summary.detail).toContain('Button not found.');
  });

  it('uses the runner’s first summary line when the run finished', () => {
    const summary = runSummary(
      baseTask({
        status: 'completed',
        completedAt: '2026-10-02T16:00:00.000Z',
        resultSummary: 'All forms validated.\nLine two of the report.',
        steps: [
          { action: 'readScreen', status: 'ok', evidenceIds: [] },
          { action: 'readScreen', status: 'ok', evidenceIds: [] },
        ],
      }),
    );
    expect(summary.statusText).toBe('Ready for review');
    expect(summary.title).toBe('All forms validated.');
    expect(summary.detail).toBe('2 of 2 steps completed');
    expect(summary.elapsed).toContain('Finished');
  });

  it('surfaces the backend’s blocked reason verbatim', () => {
    const summary = runSummary(baseTask({ status: 'blocked', blockedReason: 'externally-stopped: runner lost session' }));
    expect(summary.statusText).toBe('Blocked');
    expect(summary.detail).toBe('externally-stopped: runner lost session');
  });

  it('handles waiting_approval and queued without inventing work', () => {
    const approval = runSummary(baseTask({ status: 'blocked', blockedReason: 'awaiting-write-approval' }));
    expect(approval.statusText).toBe('Waiting for approval');
    expect(approval.title).toContain('write plan');

    const queued = runSummary(baseTask({ status: 'assigned' }));
    expect(queued.statusText).toBe('Queued');
    expect(queued.title).toBe('Waiting for the runner');
  });
});

describe('sortTasksForSidebar', () => {
  it('orders by lifecycle priority, newest first within a group', () => {
    const items = [
      baseTask({ _id: 'old-run', status: 'completed', updatedAt: '2026-10-01T10:00:00.000Z' }),
      baseTask({ _id: 'run-a', status: 'in_progress', updatedAt: '2026-10-02T10:00:00.000Z' }),
      baseTask({ _id: 'run-b', status: 'in_progress', updatedAt: '2026-10-02T12:00:00.000Z' }),
      baseTask({ _id: 'queued', status: 'assigned', updatedAt: '2026-10-02T13:00:00.000Z' }),
      baseTask({ _id: 'needs-you', status: 'blocked', updatedAt: '2026-10-02T11:00:00.000Z' }),
    ];
    const reasons = { 'needs-you': 'awaiting-write-approval' };
    const sorted = sortTasksForSidebar(items, reasons).map((t) => t._id);
    expect(sorted).toEqual(['needs-you', 'run-b', 'run-a', 'queued', 'old-run']);
  });

  it('does not mutate the input', () => {
    const items = [baseTask({ _id: 'a', status: 'completed' }), baseTask({ _id: 'b', status: 'assigned' })];
    sortTasksForSidebar(items, {});
    expect(items.map((t) => t._id)).toEqual(['a', 'b']);
  });
});
