import { beforeEach, describe, expect, it, vi } from 'vitest';

const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));

import {
  runAgenticLoop,
  type AgenticLoopDonePayload,
  type AgenticLoopOptions,
} from '../src/chat/agenticLoop.js';
import type { GatewayEvent, ProviderToolDefinition } from '../src/ai/gateway/gateway.js';
import type { ToolCallResult } from '../src/tools/gateway.js';
import type { AuthContext } from '../src/authz/permissions.js';
import type { ApprovedModel } from '../src/ai/gateway/modelRegistry.js';

/**
 * A non-SyteLine tool family the loop has never seen: a tiny calculator.
 * Proving the loop is a generalized engine, not a SyteLine script.
 */
const calcTools: ProviderToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'calc.add',
      description: 'Add two numbers',
      parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc.double',
      description: 'Double a number',
      parameters: { type: 'object', properties: { x: { type: 'number' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'calc.wipe',
      description: 'Wipe the calculator history (destructive)',
      parameters: { type: 'object', properties: {} },
    },
  },
];

const testModel = { id: 'm1', name: 'Test Model', contextWindow: 8192 } as unknown as ApprovedModel;

function scriptedGateway(steps: GatewayEvent[][], onInput?: (input: any, round: number) => void) {
  let round = 0;
  return async (input: any) => {
    onInput?.(input, round);
    const step = steps[round] ?? [];
    round += 1;
    return {
      model: testModel,
      telemetry: {},
      events: (async function* () {
        for (const event of step) yield event;
      })(),
    };
  };
}

interface SinkLog {
  texts: string[];
  plans: string[];
  toolCalls: string[][];
  dones: AgenticLoopDonePayload[];
  errors: Array<{ code: string; message: string }>;
}

function collectingSink(): { sink: AgenticLoopOptions['sink']; log: SinkLog } {
  const log: SinkLog = { texts: [], plans: [], toolCalls: [], dones: [], errors: [] };
  return {
    log,
    sink: {
      text: async (delta) => { log.texts.push(delta); return true; },
      plan: async (plan) => { log.plans.push(plan); return true; },
      toolCalls: async (calls) => { log.toolCalls.push(calls.map((c) => c.name)); return true; },
      failover: async () => true,
      done: async (payload) => { log.dones.push(payload); return true; },
      error: async (code, message) => { log.errors.push({ code, message }); },
    },
  };
}

const baseAuth = { userId: 'u1', tenantId: 't1', roleId: 'r1' } as unknown as AuthContext;

function baseOptions(overrides: Partial<AgenticLoopOptions> = {}): AgenticLoopOptions {
  return {
    tenantId: 't1',
    userId: 'u1',
    roleId: 'r1',
    classification: 'INTERNAL',
    auth: baseAuth,
    initialModel: testModel,
    buildSystemPrompt: (name) => `You are served by ${name}.`,
    providerTools: calcTools,
    messages: [{ role: 'user', content: 'What is (1 + 2) doubled?' }],
    signal: new AbortController().signal,
    telemetry: {},
    maxIterations: 5,
    maxResponseChars: 100_000,
    approvalFor: (name) => (name === 'calc.wipe' ? 'requires-approval' : 'auto'),
    ...overrides,
  } as AgenticLoopOptions;
}

function fakeCalcRunner(impl?: (opts: any) => Promise<ToolCallResult>) {
  return vi.fn(async (opts: any): Promise<ToolCallResult> => {
    if (impl) return impl(opts);
    const args = JSON.parse(opts.rawArguments) as { a: number; b: number; x: number };
    if (opts.name === 'calc.add') return { ok: true, output: String(args.a + args.b) };
    if (opts.name === 'calc.double') return { ok: true, output: String(args.x * 2) };
    return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: 'unknown tool' };
  });
}

function stepAudits() {
  return recordAudit.mock.calls
    .map((c) => c[0])
    .filter((e) => e.action === 'AGENTIC_LOOP_STEP');
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
});

describe('generalized agentic loop', () => {
  it('chains dependent tool rounds: later rounds see earlier results', async () => {
    const seenInputs: any[] = [];
    const streamGateway = scriptedGateway(
      [
        [{ type: 'text', content: "I'll compute that." },
         { type: 'tool_call', id: 'c1', name: 'calc.add', arguments: JSON.stringify({ a: 1, b: 2 }) }],
        [{ type: 'tool_call', id: 'c2', name: 'calc.double', arguments: JSON.stringify({ x: 3 }) }],
        [{ type: 'text', content: 'The answer is 6.' }],
      ],
      (input) => seenInputs.push(input)
    );
    const toolRunner = fakeCalcRunner();
    const { sink, log } = collectingSink();

    const result = await runAgenticLoop(baseOptions({ streamGateway, toolRunner, sink }));

    // Dependent chaining: calc.double ran with the value from calc.add's result.
    expect(toolRunner).toHaveBeenCalledTimes(2);
    expect(toolRunner.mock.calls[0]![0]).toMatchObject({ name: 'calc.add' });
    expect(JSON.parse(toolRunner.mock.calls[1]![0].rawArguments)).toEqual({ x: 3 });
    // Round 2's prompt included round 1's tool result (zone-4 wrapped).
    const round2Messages = seenInputs[1].messages as Array<{ role: string; content: string }>;
    expect(round2Messages.some((m) => m.role === 'tool' && String(m.content).includes('calc.add'))).toBe(true);
    expect(round2Messages.some((m) => m.role === 'tool' && String(m.content).includes('3'))).toBe(true);

    // Text accumulated across rounds; the run completed with 2 tool rounds.
    expect(result.content).toContain("I'll compute that.");
    expect(result.content).toContain('The answer is 6.');
    expect(result.toolIterations).toBe(2);
    expect(result.completed).toBe(true);
    expect(result.failed).toBe(false);
    expect(log.dones).toHaveLength(1);
    expect(log.dones[0]).toMatchObject({ toolIterations: 2 });
  });

  it('narrates a one-line plan before executing each round', async () => {
    const streamGateway = scriptedGateway([
      [{ type: 'tool_call', id: 'c1', name: 'calc.add', arguments: JSON.stringify({ a: 1, b: 2 }) }],
      [{ type: 'text', content: 'done' }],
    ]);
    const { sink, log } = collectingSink();
    await runAgenticLoop(baseOptions({ streamGateway, toolRunner: fakeCalcRunner(), sink }));
    expect(log.plans).toHaveLength(1);
    expect(log.plans[0]!.length).toBeGreaterThan(0);
    // One line, no invented paragraphs.
    expect(log.plans[0]).not.toContain('\n');
    expect(log.toolCalls).toEqual([['calc.add']]);
  });

  it('audits every step with argument keys only — never values', async () => {
    const streamGateway = scriptedGateway([
      [{ type: 'tool_call', id: 'c1', name: 'calc.add', arguments: JSON.stringify({ a: 1, b: 2 }) }],
      [{ type: 'text', content: 'done' }],
    ]);
    await runAgenticLoop(baseOptions({ streamGateway, toolRunner: fakeCalcRunner(), sink: collectingSink().sink }));
    const steps = stepAudits();
    expect(steps).toHaveLength(1);
    // Exact metadata shape: the audit trail is a compliance surface, so
    // assert equality (not partial matching) to catch any extra fields
    // leaking into stored audit rows.
    expect(steps[0]).toEqual({
      tenantId: 't1',
      userId: 'u1',
      requestId: undefined,
      action: 'AGENTIC_LOOP_STEP',
      resource: 'chat',
      classification: 'INTERNAL',
      success: true,
      metadata: {
        step: 1,
        modelId: 'm1',
        tools: ['calc.add'],
        argKeys: [['a', 'b']],
        outcomes: ['ok'],
        retried: false,
      },
    });
    const auditJson = JSON.stringify(steps);
    // Argument values must not leak into the audit trail.
    expect(auditJson).not.toContain('"a":1');
    expect(auditJson).not.toContain('"b":2');
  });

  it('stops at the iteration budget and says so in the audit trail', async () => {
    const streamGateway = scriptedGateway([
      [{ type: 'tool_call', id: 'c1', name: 'calc.add', arguments: JSON.stringify({ a: 1, b: 2 }) }],
      [{ type: 'tool_call', id: 'c2', name: 'calc.add', arguments: JSON.stringify({ a: 3, b: 4 }) }],
      [{ type: 'tool_call', id: 'c3', name: 'calc.add', arguments: JSON.stringify({ a: 5, b: 6 }) }],
    ]);
    const toolRunner = fakeCalcRunner();
    const { sink, log } = collectingSink();
    const result = await runAgenticLoop(
      baseOptions({ streamGateway, toolRunner, sink, maxIterations: 2 })
    );
    expect(result.toolIterations).toBe(2);
    expect(result.truncatedByCap).toBe(true);
    expect(result.finishReason).toBe('tool_budget');
    const budget = recordAudit.mock.calls.map((c) => c[0]).find((e) => e.action === 'AGENTIC_LOOP_BUDGET');
    expect(budget).toBeDefined();
    expect(budget.metadata).toMatchObject({ maxIterations: 2, pendingToolCalls: ['calc.add'] });
    // The user is told the turn was cut off by the budget — never silent.
    expect(result.content).toContain('stopped after 2 tool rounds');
    expect(log.texts.join('')).toContain('stopped after 2 tool rounds');
    expect(log.dones[0]).toMatchObject({ finishReason: 'tool_budget', toolIterations: 2 });
    // Third-round tools never ran.
    expect(toolRunner).toHaveBeenCalledTimes(2);
    expect(log.dones).toHaveLength(1);
  });

  it('retries a transient tool failure once via the recovery path', async () => {
    const streamGateway = scriptedGateway([
      [{ type: 'tool_call', id: 'c1', name: 'calc.add', arguments: JSON.stringify({ a: 1, b: 2 }) }],
      [{ type: 'text', content: 'recovered' }],
    ]);
    let attempts = 0;
    const toolRunner = fakeCalcRunner(async () => {
      attempts += 1;
      if (attempts === 1) return { ok: false, errorCode: 'TOOL_TIMEOUT', message: 'timed out' };
      return { ok: true, output: '3' };
    });
    const result = await runAgenticLoop(baseOptions({ streamGateway, toolRunner, sink: collectingSink().sink }));
    expect(attempts).toBe(2);
    expect(result.content).toContain('recovered');
    const steps = stepAudits();
    expect(steps[0]!.metadata.retried).toBe(true);
    expect(steps[0]!.metadata.outcomes).toEqual(['ok']);
  });

  it('never auto-executes a destructive tool; the model gets a TOOL_REQUIRES_APPROVAL error instead', async () => {
    const seenInputs: any[] = [];
    const streamGateway = scriptedGateway(
      [
        [{ type: 'tool_call', id: 'w1', name: 'calc.wipe', arguments: JSON.stringify({}) }],
        [{ type: 'text', content: 'I need your approval first.' }],
      ],
      (input) => seenInputs.push(input)
    );
    const wipeExecute = vi.fn();
    const toolRunner = fakeCalcRunner(async (opts) => {
      if (opts.name === 'calc.wipe') {
        wipeExecute();
        return { ok: true, output: 'wiped' };
      }
      return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: 'unknown' };
    });
    const result = await runAgenticLoop(baseOptions({ streamGateway, toolRunner, sink: collectingSink().sink }));
    expect(wipeExecute).not.toHaveBeenCalled();
    // The gate audited the refusal, and the model saw the approval error.
    const toolExec = recordAudit.mock.calls.map((c) => c[0]).find((e) => e.action === 'TOOL_EXECUTION');
    expect(toolExec).toMatchObject({ success: false, tool: 'calc.wipe' });
    const round2Messages = seenInputs[1].messages as Array<{ role: string; content: string }>;
    const toolMessage = round2Messages.find((m) => m.role === 'tool');
    expect(String(toolMessage?.content)).toContain('TOOL_REQUIRES_APPROVAL');
    expect(result.content).toContain('I need your approval first.');
  });

  it('executes a destructive tool whose call ID was pre-approved', async () => {
    const streamGateway = scriptedGateway([
      [{ type: 'tool_call', id: 'w1', name: 'calc.wipe', arguments: JSON.stringify({}) }],
      [{ type: 'text', content: 'wiped with approval' }],
    ]);
    const toolRunner = fakeCalcRunner(async (opts) => {
      if (opts.name === 'calc.wipe') return { ok: true, output: 'wiped' };
      return { ok: false, errorCode: 'TOOL_NOT_FOUND', message: 'unknown' };
    });
    const result = await runAgenticLoop(
      baseOptions({
        streamGateway,
        toolRunner,
        sink: collectingSink().sink,
        approvedCallIds: new Set(['w1']),
      })
    );
    expect(toolRunner).toHaveBeenCalledTimes(1);
    expect(toolRunner.mock.calls[0]![0]).toMatchObject({ name: 'calc.wipe', confirmed: true });
    expect(result.content).toContain('wiped with approval');
  });
});
