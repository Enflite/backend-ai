/**
 * studio/builder.test.ts — unit tests for the builder's pure helpers.
 * No DOM, no network.
 */
import { describe, expect, it } from 'vitest';
import type { StudioAction, StudioStep } from './types';
import {
  actionTestToStepResult,
  automationStatusBucket,
  coerceParamValue,
  createStep,
  destructiveSteps,
  duplicateStep,
  fieldsFromJsonSchema,
  moveStep,
  removeStep,
  stepKindLabel,
  stepOperation,
  summarizeStep,
  summarizeTrigger,
} from './builder';

function steps(): StudioStep[] {
  return [
    { id: 'a', kind: 'action', actionId: 'syteline.getItem', params: { item: 'X' } },
    { id: 'b', kind: 'condition', expression: 'qty > 0' },
    { id: 'c', kind: 'log', message: 'done' },
  ];
}

describe('moveStep', () => {
  it('moves a step up one position', () => {
    const next = moveStep(steps(), 'b', -1);
    expect(next.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('moves a step down one position', () => {
    const next = moveStep(steps(), 'a', 1);
    expect(next.map((s) => s.id)).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op at the bounds and for unknown ids', () => {
    expect(moveStep(steps(), 'a', -1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(moveStep(steps(), 'c', 1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
    expect(moveStep(steps(), 'zzz', 1).map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });

  it('does not mutate the input', () => {
    const input = steps();
    moveStep(input, 'a', 1);
    expect(input.map((s) => s.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('duplicateStep', () => {
  it('inserts a copy with a fresh id directly after the original', () => {
    const next = duplicateStep(steps(), 'a');
    expect(next.map((s) => s.id)).toEqual(['a', expect.any(String), 'b', 'c']);
    expect(next[1].id).not.toBe('a');
    expect(next[1].kind).toBe('action');
    expect(next[1].params).toEqual({ item: 'X' });
    expect(next[1].params).not.toBe(next[0].params);
  });

  it('is a no-op for unknown ids', () => {
    expect(duplicateStep(steps(), 'zzz')).toHaveLength(3);
  });
});

describe('removeStep', () => {
  it('removes the step by id', () => {
    expect(removeStep(steps(), 'b').map((s) => s.id)).toEqual(['a', 'c']);
  });
});

describe('createStep', () => {
  it('creates an action step with the catalog id', () => {
    const step = createStep('action', 'syteline.getItem');
    expect(step.kind).toBe('action');
    expect(step.actionId).toBe('syteline.getItem');
    expect(step.id).toMatch(/^step-/);
  });
});

describe('summaries', () => {
  const action: StudioAction = {
    id: 'syteline.getItem',
    title: 'Get item',
    description: 'Fetch an item.',
    substrate: 'api',
    destructive: false,
    supported: true,
    operation: { method: 'GET', path: '/api/items' },
  };

  it('labels every kind', () => {
    expect(stepKindLabel('trigger')).toBe('TRIGGER');
    expect(stepKindLabel('action')).toBe('ACTION');
    expect(stepKindLabel('condition')).toBe('CONDITION');
    expect(stepKindLabel('verify')).toBe('VERIFY');
    expect(stepKindLabel('log')).toBe('LOG');
  });

  it('summarizes steps from the catalog when no custom name', () => {
    expect(summarizeStep({ id: 'a', kind: 'action', actionId: 'syteline.getItem' }, action)).toBe('Get item');
    expect(summarizeStep({ id: 'b', kind: 'condition', expression: 'qty > 0' })).toBe('If qty > 0');
    expect(summarizeStep({ id: 'c', kind: 'verify' })).toBe('Verify… (no expectation set)');
    expect(summarizeStep({ id: 'd', kind: 'log', message: 'done' })).toBe('done');
    expect(summarizeStep({ id: 'e', kind: 'log', name: 'Audit line' })).toBe('Audit line');
  });

  it('shows the bound operation for action steps', () => {
    expect(stepOperation({ id: 'a', kind: 'action', actionId: 'syteline.getItem' }, action)).toBe(
      'GET /api/items',
    );
    expect(stepOperation({ id: 'b', kind: 'condition' })).toBeNull();
  });

  it('summarizes each trigger kind', () => {
    expect(summarizeTrigger({ kind: 'manual' })).toContain('Runs when');
    expect(summarizeTrigger({ kind: 'scheduled', cron: '0 9 * * *' })).toBe('Cron: 0 9 * * *');
    expect(summarizeTrigger({ kind: 'webhook' })).toContain('issued on deploy');
    expect(summarizeTrigger({ kind: 'event', event: 'PO created' })).toBe('PO created');
  });
});

describe('destructiveSteps', () => {
  it('flags only action steps whose catalog entry is destructive', () => {
    const byId = new Map<string, StudioAction>([
      ['a1', { id: 'a1', title: 'Delete', description: '', substrate: 'api', destructive: true, supported: true }],
      ['a2', { id: 'a2', title: 'Read', description: '', substrate: 'api', destructive: false, supported: true }],
    ]);
    const found = destructiveSteps(
      [
        { id: 's1', kind: 'action', actionId: 'a1' },
        { id: 's2', kind: 'action', actionId: 'a2' },
        { id: 's3', kind: 'log' },
        { id: 's4', kind: 'action' },
      ],
      byId,
    );
    expect(found.map((f) => f.step.id)).toEqual(['s1']);
  });
});

describe('fieldsFromJsonSchema', () => {
  it('flattens a zod-style JSON Schema into typed fields', () => {
    const fields = fieldsFromJsonSchema({
      type: 'object',
      properties: {
        item: { type: 'string', minLength: 1 },
        levels: { type: 'integer', minimum: 1 },
        includeZero: { type: 'boolean', default: false },
        site: { type: 'string', enum: ['TRN', 'PRD'] },
      },
      required: ['item'],
    });
    expect(fields.map((f) => [f.name, f.type, f.required])).toEqual([
      ['item', 'text', true],
      ['levels', 'number', false],
      ['includeZero', 'boolean', false],
      ['site', 'select', false],
    ]);
    expect(fields[3].options).toEqual(['TRN', 'PRD']);
  });

  it('returns [] for anything that is not a schema object', () => {
    expect(fieldsFromJsonSchema(null)).toEqual([]);
    expect(fieldsFromJsonSchema({ type: 'string' })).toEqual([]);
  });
});

describe('coerceParamValue', () => {
  it('coerces number and boolean inputs, blanks to undefined', () => {
    expect(coerceParamValue({ name: 'n', type: 'number', required: false }, '3')).toBe(3);
    expect(coerceParamValue({ name: 'n', type: 'number', required: false }, '')).toBeUndefined();
    expect(coerceParamValue({ name: 'b', type: 'boolean', required: false }, true)).toBe(true);
    expect(coerceParamValue({ name: 't', type: 'text', required: false }, 'x')).toBe('x');
  });
});

describe('actionTestToStepResult', () => {
  const base = {
    request: { method: 'GET', url: 'https://syteline.example/api/items', params: {} },
    response: { status: 200, bodyTruncated: { truncated: false, preview: '{}' }, durationMs: 42 },
    connectionId: 'default',
    actionId: 'syteline.getItem',
    executedAt: '2026-10-02T17:00:00Z',
  };

  it('maps 2xx to ok with request/response passthrough', () => {
    const r = actionTestToStepResult('s1', base);
    expect(r).toMatchObject({ stepId: 's1', status: 'ok', durationMs: 42 });
    expect(r.request).toEqual(base.request);
    expect(r.response).toEqual(base.response);
  });

  it('maps non-2xx and null status to failed', () => {
    expect(
      actionTestToStepResult('s1', { ...base, response: { ...base.response, status: 500 } }).status,
    ).toBe('failed');
    expect(
      actionTestToStepResult('s1', { ...base, response: { ...base.response, status: null } }).status,
    ).toBe('failed');
  });
});

describe('automationStatusBucket', () => {
  it('normalizes backend statuses to Jake\'s filter buckets', () => {
    expect(automationStatusBucket('draft')).toBe('draft');
    expect(automationStatusBucket('failed')).toBe('failed');
    expect(automationStatusBucket('scheduled')).toBe('scheduled');
    expect(automationStatusBucket('active')).toBe('active');
    expect(automationStatusBucket('deployed')).toBe('active');
    expect(automationStatusBucket('weird')).toBe('other');
  });
});
