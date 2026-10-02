/**
 * studio/adapters.test.ts — backend view <-> frontend builder model.
 *
 * Backend-structured fields (condition when/then/else, verify assertions,
 * trigger details) must survive a load->save round trip; hand-authored
 * steps that can't be expressed honestly throw descriptive client errors
 * instead of inventing values.
 */
import { describe, expect, it } from 'vitest';
import {
  adaptAutomation,
  adaptAutomationSummary,
  toBackendDraft,
  type BackendAutomationView,
} from './adapters';
import type { StudioAutomation } from './types';

const VIEW: BackendAutomationView = {
  id: 'auto-1',
  name: 'late-po-check',
  title: 'Late PO check',
  description: 'Flags late purchase orders.',
  status: 'draft',
  trigger: { kind: 'scheduled', cron: '0 6 * * *', timezone: 'America/Chicago', inputs: {} },
  steps: [
    {
      id: 'fetch',
      kind: 'action',
      actionId: 'syteline.getOpenPurchaseOrders',
      connectionId: 'trn',
      params: { item: 'WIDGET-1' },
      retries: 2,
      continueOnError: true,
    },
    {
      id: 'branch',
      kind: 'condition',
      when: "{{steps.fetch.output.data.status}} == 'late'",
      then: 'note',
      else: 'fetch',
    },
    {
      id: 'check',
      kind: 'verify',
      actionId: 'syteline.getItem',
      connectionId: 'trn',
      params: { item: 'WIDGET-1', site: 'MAIN' },
      assertions: [{ path: 'status', operator: '==', value: 'open' }],
    },
    { id: 'note', kind: 'log', message: 'done' },
  ],
  destructiveSteps: [],
  deployment: { status: 'never', flowName: 'studio-auto-1' },
  createdAt: '2026-10-02T16:00:00Z',
  updatedAt: '2026-10-02T16:00:00Z',
};

describe('adaptAutomationSummary', () => {
  it('derives the summary from the view', () => {
    expect(adaptAutomationSummary(VIEW)).toMatchObject({
      id: 'auto-1',
      name: 'late-po-check',
      title: 'Late PO check',
      status: 'draft',
      triggerKind: 'scheduled',
      updatedAt: '2026-10-02T16:00:00Z',
      lastRunAt: null,
    });
  });
});

describe('adaptAutomation', () => {
  it('keeps structured step and trigger fields through the load', () => {
    const automation = adaptAutomation(VIEW);
    expect(automation.trigger).toMatchObject({
      kind: 'scheduled',
      cron: '0 6 * * *',
      timezone: 'America/Chicago',
    });
    const condition = automation.steps[1];
    expect(condition).toMatchObject({
      kind: 'condition',
      when: "{{steps.fetch.output.data.status}} == 'late'",
      then: 'note',
      else: 'fetch',
      expression: "{{steps.fetch.output.data.status}} == 'late'",
    });
    const verify = automation.steps[2];
    expect(verify.assertions).toEqual([{ path: 'status', operator: '==', value: 'open' }]);
    expect(verify.expectation).toContain('status');
    const action = automation.steps[0];
    expect(action).toMatchObject({ retries: 2, continueOnError: true, connectionId: 'trn' });
    expect(automation.deployment).toBeNull();
  });

  it('maps a deployed automation to the deployed flag', () => {
    const automation = adaptAutomation({
      ...VIEW,
      deployment: {
        status: 'deployed',
        flowName: 'studio-auto-1',
        deployedAt: '2026-10-02T17:00:00Z',
        deployedBy: 'u1',
      },
    });
    expect(automation.deployment).toMatchObject({
      deployed: true,
      deployedAt: '2026-10-02T17:00:00Z',
      deployedBy: 'u1',
    });
  });
});

describe('toBackendDraft', () => {
  it('round-trips a loaded draft without losing structure', () => {
    const automation = adaptAutomation(VIEW);
    const draft = toBackendDraft(automation);
    expect(draft.trigger).toEqual({
      kind: 'scheduled',
      cron: '0 6 * * *',
      timezone: 'America/Chicago',
      inputs: {},
    });
    expect(draft.steps[1]).toEqual({
      id: 'branch',
      kind: 'condition',
      when: "{{steps.fetch.output.data.status}} == 'late'",
      then: 'note',
      else: 'fetch',
    });
    expect(draft.steps[2]).toMatchObject({
      kind: 'verify',
      actionId: 'syteline.getItem',
      assertions: [{ path: 'status', operator: '==', value: 'open' }],
    });
    expect(draft.steps[0]).toMatchObject({ retries: 2, continueOnError: true });
  });

  it('linearizes a hand-authored condition onto the next step', () => {
    const automation: StudioAutomation = {
      ...adaptAutomation(VIEW),
      steps: [
        { id: 'a', kind: 'action', actionId: 'syteline.getItem', params: {} },
        { id: 'c', kind: 'condition', expression: 'x == 1' },
        { id: 'l', kind: 'log', message: 'hi' },
      ],
    };
    const draft = toBackendDraft(automation);
    expect(draft.steps[1]).toMatchObject({ kind: 'condition', when: 'x == 1', then: 'l', else: 'l' });
  });

  it('throws honestly for a verify step with no assertions', () => {
    const automation: StudioAutomation = {
      ...adaptAutomation(VIEW),
      steps: [{ id: 'v', kind: 'verify', actionId: 'syteline.getItem', expectation: 'looks good' }],
    };
    expect(() => toBackendDraft(automation)).toThrow(/needs at least one field assertion/);
  });

  it('throws honestly for a scheduled trigger with no cron', () => {
    const automation: StudioAutomation = {
      ...adaptAutomation(VIEW),
      trigger: { kind: 'scheduled' },
    };
    expect(() => toBackendDraft(automation)).toThrow(/cron expression/);
  });

  it('throws honestly for a hand-authored event trigger with no watch config', () => {
    const automation: StudioAutomation = {
      ...adaptAutomation(VIEW),
      trigger: { kind: 'event', event: 'when something changes' },
    };
    expect(() => toBackendDraft(automation)).toThrow(/watched action/);
  });

  it('round-trips an AI-style event trigger', () => {
    const automation: StudioAutomation = {
      ...adaptAutomation(VIEW),
      trigger: {
        kind: 'event',
        actionId: 'syteline.getItem',
        connectionId: 'trn',
        params: {},
        watchPath: 'status',
        pollCron: '*/5 * * * *',
        timezone: 'UTC',
      },
    };
    expect(toBackendDraft(automation).trigger).toEqual({
      kind: 'event',
      actionId: 'syteline.getItem',
      connectionId: 'trn',
      params: {},
      watchPath: 'status',
      pollCron: '*/5 * * * *',
      timezone: 'UTC',
    });
  });
});
