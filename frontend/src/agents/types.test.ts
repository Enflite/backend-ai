/**
 * agents/types.test.ts — status mapping for the Agent Task Workspace.
 *
 * Pure mappings over backend state: verifies the human status language,
 * the failed-vs-blocked distinction, verification labeling for assert steps,
 * and the proposed-plan parser. No backend, no mocks.
 */
import { describe, expect, it } from 'vitest';
import {
  describePlanStep,
  parseProposedPlan,
  stepDisplayStatus,
  taskDisplayStatus,
  taskProgress,
} from './types';

describe('taskDisplayStatus', () => {
  it('maps the five backend statuses', () => {
    expect(taskDisplayStatus({ status: 'assigned' }).label).toBe('Queued');
    expect(taskDisplayStatus({ status: 'in_progress' }).label).toBe('Running');
    expect(taskDisplayStatus({ status: 'completed' }).label).toBe('Completed');
    expect(taskDisplayStatus({ status: 'cancelled' }).label).toBe('Cancelled');
  });

  it('surfaces awaiting-write-approval as waiting for approval', () => {
    const display = taskDisplayStatus({ status: 'blocked', blockedReason: 'awaiting-write-approval' });
    expect(display.status).toBe('waiting_approval');
    expect(display.label).toBe('Waiting for approval');
  });

  it('keeps genuine blockers as blocked', () => {
    for (const reason of ['invalid-plan', 'requester-lost-permission', 'externally-stopped:cancelled']) {
      expect(taskDisplayStatus({ status: 'blocked', blockedReason: reason }).status).toBe('blocked');
    }
  });

  it('surfaces step failures as failed, not softened to blocked', () => {
    const display = taskDisplayStatus({ status: 'blocked', blockedReason: 'STEP_FAILED' });
    expect(display.status).toBe('failed');
    expect(display.label).toBe('Failed');
    expect(display.reason).toBe('STEP_FAILED');
  });
});

describe('stepDisplayStatus', () => {
  const base = { action: 'x', status: 'ok' as const, evidenceIds: [] };
  it('marks passed assertion steps as verified', () => {
    expect(stepDisplayStatus(base, 'assertText')).toBe('verified');
    expect(stepDisplayStatus(base, 'readScreen')).toBe('verified');
    expect(stepDisplayStatus(base, 'clickButton')).toBe('done');
  });

  it('maps the remaining step states', () => {
    expect(stepDisplayStatus({ ...base, status: 'pending' })).toBe('pending');
    expect(stepDisplayStatus({ ...base, status: 'running' })).toBe('running');
    expect(stepDisplayStatus({ ...base, status: 'failed' })).toBe('failed');
    expect(stepDisplayStatus({ ...base, status: 'skipped' })).toBe('skipped');
  });
});

describe('describePlanStep', () => {
  it('renders friendly descriptions for known actions', () => {
    expect(describePlanStep({ action: 'gotoForm', form: 'Items' })).toBe('Go to the Items form');
    expect(describePlanStep({ action: 'fillField', label: 'Order', value: '123' })).toContain('Fill');
    expect(describePlanStep({ action: 'clickButton', label: 'Find' })).toBe('Click “Find”');
    expect(describePlanStep({ action: 'readScreen' })).toBe('Read the screen');
    expect(describePlanStep({ action: 'assertText', text: 'Open' })).toContain('Verify');
  });

  it('falls back to the raw action name for unknown shapes', () => {
    expect(describePlanStep({ action: 'customThing' })).toBe('customThing');
    expect(describePlanStep(null)).toBe('Unknown step');
  });
});

describe('taskProgress', () => {
  it('counts ok steps over total', () => {
    const steps = [
      { action: 'a', status: 'ok' as const, evidenceIds: [] },
      { action: 'b', status: 'running' as const, evidenceIds: [] },
      { action: 'c', status: 'pending' as const, evidenceIds: [] },
    ];
    expect(taskProgress({ steps })).toEqual({ done: 1, total: 3 });
  });
});

describe('parseProposedPlan', () => {
  it('extracts numbered lines from the approval summary', () => {
    const summary =
      'Read-only reconnaissance complete. Proposed write plan (awaiting approval):\n' +
      '3. fillField (Order)\n4. clickButton (Find)';
    expect(parseProposedPlan(summary)).toEqual(['3. fillField (Order)', '4. clickButton (Find)']);
  });

  it('returns null for non-approval summaries', () => {
    expect(parseProposedPlan('4 step(s) ok')).toBeNull();
    expect(parseProposedPlan(undefined)).toBeNull();
  });
});
