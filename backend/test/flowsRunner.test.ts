/**
 * flowsRunner.test.ts — the Flows deterministic executor (ADR-022).
 *
 * - happy path: multi-step tool flow with template output passing
 * - stop-on-first-failure → blocked with the error code
 * - continueOnError: failed step recorded, execution continues
 * - condition branching both ways (truthiness + == / !=)
 * - subflow recursion (inputs in, last-step output out) + depth cap
 * - agent step: stubbed gateway, JSON parsed + outputSchema validated
 * - template resolution failure → blocked/TEMPLATE_RESOLUTION_ERROR
 * - input validation failure → blocked/INPUT_VALIDATION_ERROR
 * - retries with backoff: fail-once then succeed
 * - live permission check: demoted/deactivated requester fails closed
 *   (blocked/requester-lost-permission, executor never called)
 * - store: publish immutability + sha256, alias 412 on stale revision,
 *   idempotency (same key → same run; different flow/inputs → 409)
 * - processQueuedRuns: disabled runner is a no-op; enabled sweeps claims
 *
 * The tool executor is replaced by overrideFlowToolExecutor and the agent
 * gateway call by overrideFlowAgentFn; the DB is an in-memory stand-in.
 * VALIDATED IN CI; real tool execution / model calls REQUIRE REAL INFRA.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { gatewayStreamMock } = vi.hoisted(() => ({ gatewayStreamMock: vi.fn() }));
const { resolveChatDefaultMock } = vi.hoisted(() => ({ resolveChatDefaultMock: vi.fn() }));
const { runToolCallMock } = vi.hoisted(() => ({ runToolCallMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));
vi.mock('../src/syteline/requesterAuth.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/ai/gateway/gateway.js', () => ({ gatewayStream: gatewayStreamMock }));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({
  resolveChatDefault: resolveChatDefaultMock,
}));
vi.mock('../src/tools/gateway.js', () => ({ runToolCall: runToolCallMock }));

import { config } from '../src/config.js';
import type { AuthContext, Permission } from '../src/authz/permissions.js';
import {
  cancelRun,
  claimRun,
  createFlow,
  createRun,
  definitionHash,
  getFlow,
  getRun,
  getVersion,
  publishVersion,
  setLiveAlias,
  updateFlowDraft,
} from '../src/flows/flowStore.js';
import {
  MAX_SUBFLOW_DEPTH,
  overrideFlowAgentFn,
  overrideFlowToolExecutor,
  processQueuedRuns,
  runFlow,
  validateFlowInputs,
  validateJsonSchema,
  type FlowToolCallResult,
} from '../src/flows/flowRunner.js';
import type { FlowRunDoc } from '../src/flows/flowTypes.js';

const TENANT = 'tenant-a';
const USER = 'user-admin';

function authFor(permissions: Permission[]): AuthContext {
  return {
    userId: USER,
    email: 'admin@example.test',
    displayName: 'Admin',
    clearance: 'INTERNAL',
    tenantId: TENANT,
    roleId: 'role-1',
    roleName: 'Admin',
    permissions,
    sessionId: 'sess-1',
  };
}

const ADMIN_AUTH = () => authFor(['flows:manage', 'flows:run', 'tenant:manage']);

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in
// ---------------------------------------------------------------------------

function getDotted(doc: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    return (obj as Record<string, unknown>)[key];
  }, doc);
}

function applyDotted(doc: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let target: Record<string, any> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = parts[i + 1]!;
    if (typeof target[part] !== 'object' || target[part] === null) {
      target[part] = /^\d+$/.test(next) ? [] : {};
    }
    target = target[part];
  }
  target[parts[parts.length - 1]!] = value;
}

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = key.includes('.') ? getDotted(doc, key) : doc[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ('$nin' in value) return !(value.$nin as unknown[]).includes(actual);
      if ('$in' in value) return (value.$in as unknown[]).includes(actual);
      return false;
    }
    return actual === value;
  });
}

function memoryCollection() {
  const docs = new Map<string, Record<string, any>>();
  const clone = (doc: Record<string, any>): Record<string, any> => structuredClone(doc);

  const applyUpdate = (doc: Record<string, any>, update: Record<string, any>): void => {
    for (const [key, value] of Object.entries(update.$set ?? {})) {
      applyDotted(doc, key, value);
    }
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      const current = (getDotted(doc, key) as number | undefined) ?? 0;
      applyDotted(doc, key, current + (value as number));
    }
    for (const [key, value] of Object.entries(update.$push ?? {})) {
      const arr = (getDotted(doc, key) as unknown[] | undefined) ?? [];
      arr.push(value);
      applyDotted(doc, key, arr);
    }
  };

  return {
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      if (docs.has(doc._id)) {
        const error = new Error('duplicate key') as Error & { code: number };
        error.code = 11000;
        throw error;
      }
      docs.set(doc._id, clone(doc));
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of docs.values()) if (matches(doc, filter)) return clone(doc);
      return null;
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, any>, update: Record<string, any>, _opts?: unknown) => {
        for (const [id, doc] of docs) {
          if (matches(doc, filter)) {
            applyUpdate(doc, update);
            docs.set(id, doc);
            return clone(doc);
          }
        }
        return null;
      },
    ),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(id, doc);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    deleteOne: vi.fn(async (filter: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          docs.delete(id);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    }),
    find: vi.fn((filter: Record<string, any>) => {
      let rows = [...docs.values()].filter((doc) => matches(doc, filter)).map(clone);
      const cursor: any = {
        sort: (spec: Record<string, 1 | -1>) => {
          const entries = Object.entries(spec);
          rows.sort((a, b) => {
            for (const [key, dir] of entries) {
              const av: any = getDotted(a, key);
              const bv: any = getDotted(b, key);
              if (av === bv) continue;
              if (av === undefined) return 1;
              if (bv === undefined) return -1;
              return (av < bv ? -1 : 1) * dir;
            }
            return 0;
          });
          return cursor;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    }),
    createIndex: vi.fn(async () => 'idx'),
    _docs: docs,
  };
}

let flowsColl: ReturnType<typeof memoryCollection>;
let runsColl: ReturnType<typeof memoryCollection>;

function dbFor(name: string): unknown {
  if (name === 'flows') return flowsColl;
  if (name === 'flow_runs') return runsColl;
  throw new Error(`unexpected collection: ${name}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  flowsColl = memoryCollection();
  runsColl = memoryCollection();
  getDbMock.mockResolvedValue({ collection: (name: string) => dbFor(name) });
  recordAuditMock.mockResolvedValue(undefined);
  liveRequesterAuthMock.mockResolvedValue(ADMIN_AUTH());
  overrideFlowToolExecutor(null);
  overrideFlowAgentFn(null);
  config.FLOW_RUNNER_ENABLED = false;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ToolBehavior = (stepId: string, params: Record<string, unknown>) => FlowToolCallResult;

let toolBehavior: ToolBehavior = () => ({ ok: true, data: null });
const toolCalls: Array<{ stepId: string; tool: string; params: Record<string, unknown> }> = [];

function useFakeTools(behavior: ToolBehavior): void {
  toolBehavior = behavior;
  toolCalls.length = 0;
  overrideFlowToolExecutor(async ({ step, params }) => {
    toolCalls.push({ stepId: step.id, tool: step.tool, params });
    return toolBehavior(step.id, params);
  });
}

function defn(name: string, steps: unknown[], inputs: Record<string, unknown> = {}): unknown {
  return { name, title: name, description: '', inputs, outputs: {}, steps, onError: 'stop' };
}

const toolStep = (id: string, tool = 'test.echo', extra: Record<string, unknown> = {}) => ({
  id,
  kind: 'tool',
  tool,
  params: {},
  ...extra,
});

async function seedLiveFlow(name: string, definition: unknown): Promise<void> {
  await createFlow(ADMIN_AUTH(), definition);
  await publishVersion(TENANT, name, USER);
  const flow = await getFlow(TENANT, name);
  await setLiveAlias(TENANT, name, 1, flow!.revision);
}

async function runToEnd(
  flowName: string,
  inputs: Record<string, unknown> = {},
  extra: { confirmWrites?: boolean; idempotencyKey?: string } = {},
): Promise<FlowRunDoc> {
  const { run } = await createRun(ADMIN_AUTH(), flowName, { inputs, ...extra }, 'INTERNAL');
  const claimed = await claimRun(TENANT, run._id, 'runner-1');
  expect(claimed).not.toBeNull();
  await runFlow(claimed!, {});
  return (await getRun(TENANT, run._id))!;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

describe('flowRunner', () => {
  it('happy path: multi-step tool flow with template output passing', async () => {
    useFakeTools((stepId) => {
      if (stepId === 'fetch') return { ok: true, data: { orderId: 'ord-9', total: 42 } };
      if (stepId === 'notify') return { ok: true, data: { sent: true } };
      return { ok: true, data: null };
    });
    await seedLiveFlow(
      'order-pipe',
      defn('order-pipe', [
        toolStep('fetch'),
        { ...toolStep('notify'), params: { id: '{{steps.fetch.output.orderId}}', amount: '{{steps.fetch.output.total}}' } },
      ]),
    );
    const run = await runToEnd('order-pipe');
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.status)).toEqual(['ok', 'ok']);
    expect(toolCalls[1]!.params).toEqual({ id: 'ord-9', amount: 42 });
    // Step logs persist shapes, never values.
    expect(run.steps[0]!.outputShape).toBe('object{keys:[orderId,total]}');
    expect(JSON.stringify(run.steps)).not.toContain('ord-9');
  });

  it('stop-on-first-failure blocks the run with the error code', async () => {
    useFakeTools((stepId) =>
      stepId === 'boom' ? { ok: false, errorCode: 'UPSTREAM_DOWN', message: 'down' } : { ok: true, data: 1 },
    );
    await seedLiveFlow('fragile', defn('fragile', [toolStep('boom'), toolStep('never')]));
    const run = await runToEnd('fragile');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('UPSTREAM_DOWN');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
    expect(toolCalls.map((c) => c.stepId)).toEqual(['boom']);
  });

  it('continueOnError marks the step failed and continues', async () => {
    useFakeTools((stepId) =>
      stepId === 'wobbly' ? { ok: false, errorCode: 'FLAKY' } : { ok: true, data: 'fine' },
    );
    await seedLiveFlow(
      'resilient',
      defn('resilient', [toolStep('wobbly', 't.x', { continueOnError: true }), toolStep('after')]),
    );
    const run = await runToEnd('resilient');
    expect(run.status).toBe('completed');
    expect(run.steps.map((s) => s.status)).toEqual(['failed', 'ok']);
    expect(run.steps[0]!.errorCode).toBe('FLAKY');
  });

  it('retries a failing step with backoff, then succeeds', async () => {
    let attempts = 0;
    useFakeTools(() => {
      attempts += 1;
      return attempts < 3 ? { ok: false, errorCode: 'TRANSIENT' } : { ok: true, data: 'ok' };
    });
    await seedLiveFlow('retryable', defn('retryable', [toolStep('s1', 't.x', { retries: 2 })]));
    const run = await runToEnd('retryable');
    expect(run.status).toBe('completed');
    expect(attempts).toBe(3);
  });

  it('branches on condition truthiness both ways', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    // if/else in a linear flow: the then-branch ends with an unconditional
    // join jump over the else-branch.
    const steps = [
      { id: 'check', kind: 'condition', when: '{{inputs.go}}', then: 'yes', else: 'no' },
      toolStep('yes'),
      { id: 'join', kind: 'condition', when: 'taken', then: 'end', else: 'end' },
      toolStep('no'),
      toolStep('end'),
    ];
    await seedLiveFlow(
      'branchy',
      defn('branchy', steps, { go: { type: 'boolean', required: true } }),
    );
    const yesRun = await runToEnd('branchy', { go: true });
    expect(yesRun.status).toBe('completed');
    expect(toolCalls.map((c) => c.stepId)).toEqual(['yes', 'end']);
    expect(yesRun.steps.find((s) => s.stepId === 'no')!.status).toBe('skipped');

    toolCalls.length = 0;
    const noRun = await runToEnd('branchy', { go: false });
    expect(toolCalls.map((c) => c.stepId)).toEqual(['no', 'end']);
    expect(noRun.steps.find((s) => s.stepId === 'yes')!.status).toBe('skipped');
    expect(noRun.steps.find((s) => s.stepId === 'join')!.status).toBe('skipped');
  });

  it('branches on == / != literal comparisons', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    const steps = [
      { id: 'check', kind: 'condition', when: "{{inputs.env}} == 'prod'", then: 'prod-step', else: 'dev-step' },
      toolStep('prod-step'),
      { id: 'join', kind: 'condition', when: 'taken', then: 'end', else: 'end' },
      toolStep('dev-step'),
      toolStep('end'),
    ];
    await seedLiveFlow('env-branch', defn('env-branch', steps, { env: { type: 'string', required: true } }));
    await runToEnd('env-branch', { env: 'prod' });
    expect(toolCalls.map((c) => c.stepId)).toEqual(['prod-step', 'end']);
    toolCalls.length = 0;
    await runToEnd('env-branch', { env: 'dev' });
    expect(toolCalls.map((c) => c.stepId)).toEqual(['dev-step', 'end']);
  });

  it('blocks on template resolution failure with TEMPLATE_RESOLUTION_ERROR', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    await seedLiveFlow(
      'dangling',
      defn('dangling', [{ ...toolStep('s1'), params: { v: '{{steps.ghost.output.x}}' } }]),
    );
    const run = await runToEnd('dangling');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('TEMPLATE_RESOLUTION_ERROR');
    expect(toolCalls).toHaveLength(0);
  });

  it('blocks on invalid inputs with INPUT_VALIDATION_ERROR', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    await seedLiveFlow(
      'needs-input',
      defn('needs-input', [toolStep('s1')], { customerId: { type: 'string', required: true } }),
    );
    const run = await runToEnd('needs-input', {});
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('INPUT_VALIDATION_ERROR');
    expect(toolCalls).toHaveLength(0);
  });

  it('fails closed when the requester lost flows:run (demotion guard)', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    liveRequesterAuthMock.mockResolvedValue(null);
    await seedLiveFlow('guarded', defn('guarded', [toolStep('s1')]));
    const run = await runToEnd('guarded');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('requester-lost-permission');
    expect(toolCalls).toHaveLength(0);
    expect(runToolCallMock).not.toHaveBeenCalled();
  });

  it('audits every step with id + status only (never values)', async () => {
    useFakeTools(() => ({ ok: true, data: { secret: 'hunter2' } }));
    await seedLiveFlow('audited', defn('audited', [toolStep('s1')]));
    await runToEnd('audited');
    const stepAudits = recordAuditMock.mock.calls.filter((call) => call[0].action === 'FLOW_RUN_STEP');
    expect(stepAudits.length).toBeGreaterThan(0);
    for (const call of stepAudits) {
      expect(JSON.stringify(call[0])).not.toContain('hunter2');
      expect(call[0].metadata.stepId).toBe('s1');
    }
  });

  it('never resurrects a run cancelled mid-run', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    await seedLiveFlow('cancellable', defn('cancellable', [toolStep('s1')]));
    const { run } = await createRun(ADMIN_AUTH(), 'cancellable', { inputs: {} }, 'INTERNAL');
    const claimed = await claimRun(TENANT, run._id, 'runner-1');
    await cancelRun(TENANT, run._id);
    const status = await runFlow(claimed!, {});
    expect(status).toBe('cancelled');
    const latest = await getRun(TENANT, run._id);
    expect(latest!.status).toBe('cancelled');
  });
});

describe('subflow steps', () => {
  it('recurses with inputs and returns the last step output', async () => {
    useFakeTools((stepId, params) => {
      if (stepId === 'inner') return { ok: true, data: { doubled: (params.n as number) * 2 } };
      return { ok: true, data: null };
    });
    await seedLiveFlow(
      'child',
      defn('child', [{ ...toolStep('inner'), params: { n: '{{inputs.n}}' } }], {
        n: { type: 'number', required: true },
      }),
    );
    await seedLiveFlow('parent', defn('parent', [
      { id: 'call', kind: 'subflow', flow: 'child', inputs: { n: '{{inputs.n}}' } },
      { ...toolStep('use'), params: { v: '{{steps.call.output.doubled}}' } },
    ], { n: { type: 'number', required: true } }));
    const run = await runToEnd('parent', { n: 21 });
    expect(run.status).toBe('completed');
    expect(toolCalls.find((c) => c.stepId === 'use')!.params).toEqual({ v: 42 });
    expect(run.steps.find((s) => s.stepId === 'call')!.outputShape).toBe('object{keys:[doubled]}');
  });

  it('resolves an explicit version instead of live', async () => {
    useFakeTools((stepId) => ({ ok: true, data: stepId }));
    await createFlow(ADMIN_AUTH(), defn('ver-child', [toolStep('v1step')]));
    await publishVersion(TENANT, 'ver-child', USER); // version 1
    await updateFlowDraftForTest('ver-child');
    await publishVersion(TENANT, 'ver-child', USER); // version 2
    const flow = await getFlow(TENANT, 'ver-child');
    await setLiveAlias(TENANT, 'ver-child', 2, flow!.revision);
    await seedLiveFlow('ver-parent', defn('ver-parent', [
      { id: 'call', kind: 'subflow', flow: 'ver-child', version: 1, inputs: {} },
    ]));
    const run = await runToEnd('ver-parent');
    expect(run.status).toBe('completed');
    expect(toolCalls.map((c) => c.stepId)).toEqual(['v1step']);
  });

  it('enforces the depth cap on recursive subflows', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    await seedLiveFlow('loopy', defn('loopy', [
      { id: 'self', kind: 'subflow', flow: 'loopy', inputs: {} },
    ]));
    const run = await runToEnd('loopy');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('SUBFLOW_DEPTH_EXCEEDED');
  });

  it('blocks when the subflow has no live version', async () => {
    useFakeTools(() => ({ ok: true, data: null }));
    await createFlow(ADMIN_AUTH(), defn('unpublished', [toolStep('s1')]));
    await publishVersion(TENANT, 'unpublished', USER); // published but never aliased live
    await seedLiveFlow('needs-child', defn('needs-child', [
      { id: 'call', kind: 'subflow', flow: 'unpublished', inputs: {} },
    ]));
    const run = await runToEnd('needs-child');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('SUBFLOW_NO_LIVE_VERSION');
  });
});

async function updateFlowDraftForTest(name: string): Promise<void> {
  await updateFlowDraft(TENANT, name, defn(name, [toolStep('v2step')]), USER);
}

describe('agent steps', () => {
  it('parses JSON output and validates it against outputSchema', async () => {
    overrideFlowAgentFn(async () => 'Sure! {"summary": "done", "count": 3}');
    await seedLiveFlow('agent-flow', defn('agent-flow', [
      {
        id: 'think',
        kind: 'agent',
        prompt: 'Summarize {{inputs.topic}}',
        outputSchema: {
          type: 'object',
          required: ['summary', 'count'],
          properties: { summary: { type: 'string' }, count: { type: 'integer' } },
        },
      },
      { ...toolStep('use'), params: { s: '{{steps.think.output.summary}}' } },
    ], { topic: { type: 'string', required: true } }));
    useFakeTools(() => ({ ok: true, data: null }));
    const run = await runToEnd('agent-flow', { topic: 'orders' });
    expect(run.status).toBe('completed');
    expect(toolCalls[0]!.params).toEqual({ s: 'done' });
  });

  it('blocks on schema mismatch with AGENT_OUTPUT_SCHEMA_MISMATCH', async () => {
    overrideFlowAgentFn(async () => '{"summary": "done"}'); // missing required count
    await seedLiveFlow('bad-agent', defn('bad-agent', [
      {
        id: 'think',
        kind: 'agent',
        prompt: 'hi',
        outputSchema: { type: 'object', required: ['count'] },
      },
    ]));
    const run = await runToEnd('bad-agent');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('AGENT_OUTPUT_SCHEMA_MISMATCH');
  });

  it('blocks on non-JSON output with AGENT_OUTPUT_NOT_JSON', async () => {
    overrideFlowAgentFn(async () => 'just some prose, no json');
    await seedLiveFlow('prose-agent', defn('prose-agent', [
      { id: 'think', kind: 'agent', prompt: 'hi', outputSchema: { type: 'object' } },
    ]));
    const run = await runToEnd('prose-agent');
    expect(run.status).toBe('blocked');
    expect(run.blockedReason).toBe('AGENT_OUTPUT_NOT_JSON');
  });
});

describe('validateFlowInputs', () => {
  const codeOf = (fn: () => void): string => {
    try {
      fn();
    } catch (error: unknown) {
      return (error as { code?: string }).code ?? '';
    }
    return '';
  };

  it('rejects missing required, wrong types, and unknown keys', () => {
    const specs = {
      a: { type: 'string' as const, required: true },
      b: { type: 'number' as const, required: false },
      c: { type: 'string[]' as const, required: false },
      d: { type: 'boolean' as const, required: false },
    };
    expect(codeOf(() => validateFlowInputs(specs, {}))).toBe('INPUT_VALIDATION_ERROR');
    expect(codeOf(() => validateFlowInputs(specs, { a: 1 }))).toBe('INPUT_VALIDATION_ERROR');
    expect(codeOf(() => validateFlowInputs(specs, { a: 'x', b: 'nope' }))).toBe('INPUT_VALIDATION_ERROR');
    expect(codeOf(() => validateFlowInputs(specs, { a: 'x', c: ['ok', 1] }))).toBe('INPUT_VALIDATION_ERROR');
    expect(codeOf(() => validateFlowInputs(specs, { a: 'x', extra: 1 }))).toBe('INPUT_VALIDATION_ERROR');
    expect(codeOf(() => validateFlowInputs(specs, { a: 'x', b: 2, c: ['y'], d: false }))).toBe('');
  });
});

describe('validateJsonSchema', () => {
  it('validates the documented subset', () => {
    expect(validateJsonSchema({ type: 'string' }, 'x')).toBeNull();
    expect(validateJsonSchema({ type: 'string' }, 1)).toContain('expected string');
    expect(
      validateJsonSchema(
        { type: 'object', required: ['a'], properties: { a: { type: 'integer' } } },
        { a: 1.5 },
      ),
    ).toContain('a');
    expect(
      validateJsonSchema({ type: 'array', items: { type: 'string' } }, ['a', 1]),
    ).toContain('[1]');
    expect(validateJsonSchema({ enum: ['a', 'b'] }, 'c')).toContain('enum');
    expect(
      validateJsonSchema(
        { type: 'object', properties: { a: {} }, additionalProperties: false },
        { a: 1, b: 2 },
      ),
    ).toContain('additional property');
    expect(() => validateJsonSchema('nope', {})).toThrow(/JSON Schema object/);
  });
});

describe('flowStore versioning + idempotency', () => {
  it('publishes immutable versions with stable sha256 hashes', async () => {
    await createFlow(ADMIN_AUTH(), defn('vflow', [toolStep('s1')]));
    const { version: v1 } = await publishVersion(TENANT, 'vflow', USER);
    expect(v1.version).toBe(1);
    expect(v1.definitionHash).toBe(definitionHash(v1.definition));
    const { version: v2 } = await publishVersion(TENANT, 'vflow', USER);
    expect(v2.version).toBe(2);
    const stored = await getVersion(TENANT, 'vflow', 1);
    expect(stored!.definitionHash).toBe(v1.definitionHash);
  });

  it('rejects a stale alias revision with 412', async () => {
    await createFlow(ADMIN_AUTH(), defn('alias-flow', [toolStep('s1')]));
    await publishVersion(TENANT, 'alias-flow', USER);
    const flow = await getFlow(TENANT, 'alias-flow');
    const ok = await setLiveAlias(TENANT, 'alias-flow', 1, flow!.revision);
    expect(ok.liveVersion).toBe(1);
    let statusCode = 0;
    let code = '';
    try {
      await setLiveAlias(TENANT, 'alias-flow', 1, flow!.revision);
    } catch (error: unknown) {
      statusCode = (error as { statusCode?: number }).statusCode ?? 0;
      code = (error as { code?: string }).code ?? '';
    }
    expect(statusCode).toBe(412);
    expect(code).toBe('REVISION_MISMATCH');
  });

  it('idempotency: same key + flow + inputs returns the existing run', async () => {
    await seedLiveFlow('idem', defn('idem', [toolStep('s1')]));
    const first = await createRun(
      ADMIN_AUTH(), 'idem', { inputs: { a: 1 }, idempotencyKey: 'key-1' }, 'INTERNAL',
    );
    const second = await createRun(
      ADMIN_AUTH(), 'idem', { inputs: { a: 1 }, idempotencyKey: 'key-1' }, 'INTERNAL',
    );
    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.run._id).toBe(first.run._id);
  });

  it('idempotency: same key with different inputs is a 409', async () => {
    await seedLiveFlow('idem2', defn('idem2', [toolStep('s1')]));
    await createRun(ADMIN_AUTH(), 'idem2', { inputs: { a: 1 }, idempotencyKey: 'key-2' }, 'INTERNAL');
    let code = '';
    try {
      await createRun(ADMIN_AUTH(), 'idem2', { inputs: { a: 2 }, idempotencyKey: 'key-2' }, 'INTERNAL');
    } catch (error: unknown) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('idempotency: same key with a different flow is a 409', async () => {
    await seedLiveFlow('idem-a', defn('idem-a', [toolStep('s1')]));
    await seedLiveFlow('idem-b', defn('idem-b', [toolStep('s1')]));
    await createRun(ADMIN_AUTH(), 'idem-a', { inputs: {}, idempotencyKey: 'key-3' }, 'INTERNAL');
    let code = '';
    try {
      await createRun(ADMIN_AUTH(), 'idem-b', { inputs: {}, idempotencyKey: 'key-3' }, 'INTERNAL');
    } catch (error: unknown) {
      code = (error as { code?: string }).code ?? '';
    }
    expect(code).toBe('IDEMPOTENCY_KEY_CONFLICT');
  });

  it('MAX_SUBFLOW_DEPTH is 5', () => {
    expect(MAX_SUBFLOW_DEPTH).toBe(5);
  });
});

describe('processQueuedRuns', () => {
  it('is a no-op when the runner is disabled', async () => {
    config.FLOW_RUNNER_ENABLED = false;
    await seedLiveFlow('idle', defn('idle', [toolStep('s1')]));
    await createRun(ADMIN_AUTH(), 'idle', { inputs: {} }, 'INTERNAL');
    const result = await processQueuedRuns();
    expect(result).toEqual({ claimed: 0, succeeded: 0, blocked: 0 });
  });

  it('claims and executes queued runs when enabled', async () => {
    config.FLOW_RUNNER_ENABLED = true;
    useFakeTools(() => ({ ok: true, data: 1 }));
    await seedLiveFlow('sweepable', defn('sweepable', [toolStep('s1')]));
    await createRun(ADMIN_AUTH(), 'sweepable', { inputs: {} }, 'INTERNAL');
    const result = await processQueuedRuns();
    expect(result.claimed).toBe(1);
    expect(result.succeeded).toBe(1);
  });
});
