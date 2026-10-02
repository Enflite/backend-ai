/**
 * flowsSchema.test.ts — Flows platform schema validation and the template
 * engine (ADR-022). Pure functions: no mocks needed.
 *
 * VALIDATED IN CI.
 */
import { describe, expect, it } from 'vitest';
import {
  flowDefinitionSchema,
  type FlowDefinition,
} from '../src/flows/flowTypes.js';
import {
  describeOutputShape,
  evaluateCondition,
  resolveParams,
  resolveValue,
  type TemplateContext,
} from '../src/flows/template.js';

function baseDefinition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'my-flow',
    title: 'My Flow',
    description: 'test',
    inputs: {},
    outputs: {},
    steps: [{ id: 's1', kind: 'tool', tool: 'repo.read', params: {} }],
    onError: 'stop',
    ...overrides,
  };
}

function ctxFor(overrides: Partial<TemplateContext> = {}): TemplateContext {
  return {
    inputs: { name: 'Ada', count: 3, tags: ['a', 'b'], nested: { deep: { v: 42 } } },
    stepOutputs: new Map<string, unknown>([
      ['fetch', { id: 'ord-1', total: 99.5, items: [{ sku: 'x' }, { sku: 'y' }] }],
      ['flag', true],
    ]),
    ...overrides,
  };
}

describe('flowDefinitionSchema', () => {
  it('accepts a valid definition with defaults applied', () => {
    const parsed: FlowDefinition = flowDefinitionSchema.parse(baseDefinition());
    expect(parsed.name).toBe('my-flow');
    expect(parsed.onError).toBe('stop');
    const toolStep = parsed.steps[0]!;
    expect(toolStep.kind).toBe('tool');
    if (toolStep.kind === 'tool') {
      expect(toolStep.retries).toBe(0);
      expect(toolStep.continueOnError).toBe(false);
    }
  });

  it('rejects an unknown step kind', () => {
    const result = flowDefinitionSchema.safeParse(
      baseDefinition({ steps: [{ id: 's1', kind: 'teleport' }] }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects duplicate step ids', () => {
    const result = flowDefinitionSchema.safeParse(
      baseDefinition({
        steps: [
          { id: 's1', kind: 'tool', tool: 'a.b', params: {} },
          { id: 's1', kind: 'tool', tool: 'a.b', params: {} },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('duplicate step id'))).toBe(true);
    }
  });

  it('rejects condition branches that reference unknown step ids', () => {
    const result = flowDefinitionSchema.safeParse(
      baseDefinition({
        steps: [
          { id: 'check', kind: 'condition', when: '{{inputs.x}}', then: 's1', else: 'ghost' },
          { id: 's1', kind: 'tool', tool: 'a.b', params: {} },
        ],
      }),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => i.message.includes('unknown step id'))).toBe(true);
    }
  });

  it('rejects a condition that targets itself', () => {
    const result = flowDefinitionSchema.safeParse(
      baseDefinition({
        steps: [{ id: 'check', kind: 'condition', when: 'x', then: 'check', else: 'check' }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects flow names outside ^[a-z0-9-]+$', () => {
    for (const name of ['My_Flow', 'my flow', 'MY-FLOW', 'a'.repeat(65)]) {
      expect(flowDefinitionSchema.safeParse(baseDefinition({ name })).success).toBe(false);
    }
  });

  it('rejects step ids outside the allowed class', () => {
    const result = flowDefinitionSchema.safeParse(
      baseDefinition({ steps: [{ id: 'has space', kind: 'tool', tool: 'a.b', params: {} }] }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts all four step kinds with their defaults', () => {
    const parsed = flowDefinitionSchema.parse(
      baseDefinition({
        steps: [
          { id: 't1', kind: 'tool', tool: 'syteline.task.create', params: { a: 1 } },
          { id: 's1', kind: 'subflow', flow: 'child-flow', inputs: {} },
          { id: 'a1', kind: 'agent', prompt: 'hi', outputSchema: { type: 'object' } },
          { id: 'c1', kind: 'condition', when: "{{t1}} == 'x'", then: 't1', else: 's1' },
        ],
      }),
    );
    expect(parsed.steps.map((s) => s.kind)).toEqual(['tool', 'subflow', 'agent', 'condition']);
    const sub = parsed.steps[1]!;
    if (sub.kind === 'subflow') expect(sub.alias).toBe('live');
    const agent = parsed.steps[2]!;
    if (agent.kind === 'agent') expect(agent.maxTokens).toBe(2000);
  });

  it('rejects empty steps and more than 200 steps', () => {
    expect(flowDefinitionSchema.safeParse(baseDefinition({ steps: [] })).success).toBe(false);
    const many = Array.from({ length: 201 }, (_, i) => ({
      id: `s${i}`,
      kind: 'tool',
      tool: 'a.b',
      params: {},
    }));
    expect(flowDefinitionSchema.safeParse(baseDefinition({ steps: many })).success).toBe(false);
  });
});

describe('template engine', () => {
  it('resolves input paths, preserving raw values for whole-expression templates', () => {
    const ctx = ctxFor();
    expect(resolveValue('{{inputs.name}}', ctx)).toBe('Ada');
    expect(resolveValue('{{inputs.count}}', ctx)).toBe(3);
    expect(resolveValue('{{inputs.tags}}', ctx)).toEqual(['a', 'b']);
    expect(resolveValue('{{inputs.nested.deep.v}}', ctx)).toBe(42);
    expect(resolveValue('{{inputs.tags[1]}}', ctx)).toBe('b');
  });

  it('resolves step output paths including array indices', () => {
    const ctx = ctxFor();
    expect(resolveValue('{{steps.fetch.output.id}}', ctx)).toBe('ord-1');
    expect(resolveValue('{{steps.fetch.output.total}}', ctx)).toBe(99.5);
    expect(resolveValue('{{steps.fetch.output.items[0].sku}}', ctx)).toBe('x');
    expect(resolveValue('{{steps.fetch.output.items}}', ctx)).toEqual([{ sku: 'x' }, { sku: 'y' }]);
  });

  it('interpolates expressions inside larger strings', () => {
    const ctx = ctxFor();
    expect(resolveValue('Hello {{inputs.name}}, order {{steps.fetch.output.id}}', ctx)).toBe(
      'Hello Ada, order ord-1',
    );
    expect(resolveValue('count={{inputs.count}}', ctx)).toBe('count=3');
  });

  it('throws TEMPLATE_RESOLUTION_ERROR for unknown paths', () => {
    const ctx = ctxFor();
    for (const template of [
      '{{inputs.missing}}',
      '{{inputs.name.deeper}}',
      '{{steps.ghost.output.x}}',
      '{{steps.fetch.output.nope}}',
      '{{steps.fetch.output.items[9]}}',
      '{{bogus.path}}',
      '{{inputs.constructor}}',
    ]) {
      let code: string | undefined;
      try {
        resolveValue(template, ctx);
      } catch (error: unknown) {
        code = (error as { code?: string }).code;
      }
      expect(code, template).toBe('TEMPLATE_RESOLUTION_ERROR');
    }
  });

  it('deep-resolves params objects and arrays', () => {
    const ctx = ctxFor();
    const resolved = resolveParams(
      {
        id: '{{inputs.name}}',
        n: '{{inputs.count}}',
        list: ['{{inputs.tags[0]}}', 'static'],
        deep: { v: '{{steps.fetch.output.total}}' },
        untouched: 7,
      },
      ctx,
    );
    expect(resolved).toEqual({
      id: 'Ada',
      n: 3,
      list: ['a', 'static'],
      deep: { v: 99.5 },
      untouched: 7,
    });
  });

  it('passes non-string params through untouched', () => {
    const ctx = ctxFor();
    expect(resolveParams(42, ctx)).toBe(42);
    expect(resolveParams(null, ctx)).toBeNull();
  });
});

describe('condition evaluation', () => {
  it('evaluates bare-template truthiness on the raw value', () => {
    const truthyCtx = ctxFor({ stepOutputs: new Map([['s', true]]) });
    expect(evaluateCondition('{{steps.s.output}}', truthyCtx)).toBe(true);
    for (const [value, expected] of [
      [false, false],
      [0, false],
      ['', false],
      [null, false],
      [undefined, false],
      ['yes', true],
      [1, true],
    ] as Array<[unknown, boolean]>) {
      const ctx = ctxFor({ stepOutputs: new Map([['s', value]]) });
      expect(evaluateCondition('{{steps.s.output}}', ctx), JSON.stringify(value)).toBe(expected);
    }
  });

  it('supports == and != against quoted literals', () => {
    const ctx = ctxFor();
    expect(evaluateCondition("{{inputs.name}} == 'Ada'", ctx)).toBe(true);
    expect(evaluateCondition('{{inputs.name}} == "Ada"', ctx)).toBe(true);
    expect(evaluateCondition("{{inputs.name}} != 'Ada'", ctx)).toBe(false);
    expect(evaluateCondition("{{inputs.name}} == 'Bob'", ctx)).toBe(false);
    expect(evaluateCondition("{{inputs.name}} != 'Bob'", ctx)).toBe(true);
    expect(evaluateCondition('{{inputs.count}} == \'3\'', ctx)).toBe(true);
  });

  it('treats a non-empty literal string as truthy', () => {
    expect(evaluateCondition('always', ctxFor())).toBe(true);
    expect(evaluateCondition('', ctxFor())).toBe(false);
  });

  it('fails closed on unresolvable templates in conditions', () => {
    let code: string | undefined;
    try {
      evaluateCondition('{{inputs.missing}} == \'x\'', ctxFor());
    } catch (error: unknown) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('TEMPLATE_RESOLUTION_ERROR');
  });
});

describe('describeOutputShape', () => {
  it('describes types without values', () => {
    expect(describeOutputShape('secret-value')).toBe('string[12]');
    expect(describeOutputShape(42)).toBe('number');
    expect(describeOutputShape(true)).toBe('boolean');
    expect(describeOutputShape(null)).toBe('null');
    expect(describeOutputShape([1, 2])).toBe('array[2]');
    expect(describeOutputShape({ a: 1, b: 'x' })).toBe('object{keys:[a,b]}');
    // The value itself never appears in the descriptor.
    expect(describeOutputShape({ password: 'hunter2' })).not.toContain('hunter2');
  });
});
