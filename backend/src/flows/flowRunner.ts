/**
 * flowRunner.ts — deterministic executor for Flows (ADR-022).
 *
 * The runner loads the run's FROZEN version definition at start (never the
 * mutable draft), validates inputs, then executes steps in order with an
 * instruction pointer: tool steps via runToolCall (authorized as the
 * requester, with their live permissions), subflow steps via bounded
 * recursion, agent steps via one bounded gateway call whose JSON output is
 * validated against the step's JSON schema, and condition steps as jumps.
 *
 * There is NO per-step LLM reasoning: the definition is the program.
 *
 * Failure semantics: stop-on-first-failure marks the run `blocked` with
 * the error code, unless the step sets continueOnError (then the step is
 * marked failed and execution continues). Retries use a small
 * deterministic backoff. Every step writes a FLOW_RUN_STEP audit event
 * (step id + status + error code only — never values) and a step-log row
 * carrying the output SHAPE, never the value (ADR-004: template values
 * may carry secrets; runToolCall already redacts secretParams).
 *
 * The requester's LIVE auth is re-resolved at run start (same resolution
 * as login); a demotion/deactivation after run creation fails closed —
 * the run blocks with `requester-lost-permission` and never executes.
 *
 * TEST SEAMS: overrideFlowToolExecutor (mirrors overrideTaskPlanFn /
 * FakeDriver precedent — tests run the full runner against a fake tool
 * executor) and overrideFlowAgentFn (stubs the bounded gateway call).
 */

import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { recordAudit, sanitizeReason } from '../audit/audit.js';
import { Errors } from '../errors.js';
import type { AuthContext, Classification } from '../authz/permissions.js';
import { liveRequesterAuth } from '../syteline/requesterAuth.js';
import { gatewayStream } from '../ai/gateway/gateway.js';
import { resolveChatDefault } from '../ai/gateway/capabilityRouter.js';
import { runToolCall } from '../tools/gateway.js';
import {
  blockRun,
  completeRun,
  findQueuedRuns,
  claimRun,
  getRun,
  getVersion,
  getLiveDefinition,
  updateRunStep,
} from './flowStore.js';
import {
  describeOutputShape,
  evaluateCondition,
  resolveParams,
  resolveValue,
  templateError,
} from './template.js';
import type {
  AgentFlowStep,
  FlowDefinition,
  FlowInputSpec,
  FlowRunDoc,
  FlowRunStatus,
  FlowRunStepLog,
  FlowStep,
  SubflowStep,
  ToolFlowStep,
} from './flowTypes.js';

/** Hard cap on subflow nesting (the step itself counts as depth 1). */
export const MAX_SUBFLOW_DEPTH = 5;

/** Bounds total step executions (condition back-jumps) per definition run. */
function maxOperations(stepCount: number): number {
  return stepCount * 10 + 10;
}

function errorCodeOf(error: unknown): string {
  if (
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return (error as { code: string }).code;
  }
  return 'STEP_FAILED';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Combine a parent signal with a step timeout into one abort signal. */
function withStepTimeout(parent: AbortSignal, timeoutMs: number): {
  signal: AbortSignal;
  cancel: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const onAbort = (): void => controller.abort();
  if (parent.aborted) controller.abort();
  else parent.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
      parent.removeEventListener('abort', onAbort);
    },
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

/**
 * Validate run inputs against the definition's input schema. Strict:
 * missing required inputs, wrong types, and unknown keys are all
 * INPUT_VALIDATION_ERROR — a flow must fail loudly on a bad call site,
 * never coerce.
 */
export function validateFlowInputs(
  specs: Record<string, FlowInputSpec>,
  inputs: Record<string, unknown>,
): void {
  for (const [key, spec] of Object.entries(specs)) {
    const value = inputs[key];
    if (value === undefined) {
      if (spec.required) {
        throw Errors.badRequest('INPUT_VALIDATION_ERROR', `missing required input: ${key}`);
      }
      continue;
    }
    const ok =
      (spec.type === 'string' && typeof value === 'string') ||
      (spec.type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (spec.type === 'boolean' && typeof value === 'boolean') ||
      (spec.type === 'string[]' &&
        Array.isArray(value) &&
        value.every((item) => typeof item === 'string'));
    if (!ok) {
      throw Errors.badRequest(
        'INPUT_VALIDATION_ERROR',
        `input "${key}" must be ${spec.type}`,
      );
    }
  }
  for (const key of Object.keys(inputs)) {
    if (!(key in specs)) {
      throw Errors.badRequest('INPUT_VALIDATION_ERROR', `unknown input: ${key}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export interface FlowToolCallArgs {
  step: ToolFlowStep;
  /** Template-resolved params (raw values; may carry secrets — never log). */
  params: Record<string, unknown>;
  auth: AuthContext;
  classification: Classification;
  confirmWrites: boolean;
  requestId: string;
  signal: AbortSignal;
}

export interface FlowToolCallResult {
  ok: boolean;
  errorCode?: string;
  message?: string;
  /** Step output value on success (in-memory only; persisted as shape). */
  data?: unknown;
}

export type FlowToolExecutor = (args: FlowToolCallArgs) => Promise<FlowToolCallResult>;

let toolExecutorOverride: FlowToolExecutor | null = null;

/** Test-only seam: substitute tool execution (mirrors overrideTaskPlanFn). */
export function overrideFlowToolExecutor(fn: FlowToolExecutor | null): void {
  toolExecutorOverride = fn;
}

async function defaultToolExecutor(args: FlowToolCallArgs): Promise<FlowToolCallResult> {
  const result = await runToolCall({
    auth: args.auth,
    name: args.step.tool,
    rawArguments: JSON.stringify(args.params),
    classification: args.classification,
    confirmed: args.confirmWrites,
    requestId: args.requestId,
    signal: args.signal,
  });
  return {
    ok: result.ok,
    errorCode: result.errorCode,
    message: result.message,
    data: result.data,
  };
}

export interface FlowAgentCallArgs {
  step: AgentFlowStep;
  /** Template-resolved prompt text. */
  prompt: string;
  auth: AuthContext;
  signal: AbortSignal;
}

/** Returns the model's raw text; the runner JSON-parses + schema-validates it. */
export type FlowAgentFn = (args: FlowAgentCallArgs) => Promise<string>;

let agentFnOverride: FlowAgentFn | null = null;

/** Test-only seam: substitute the bounded gateway call for agent steps. */
export function overrideFlowAgentFn(fn: FlowAgentFn | null): void {
  agentFnOverride = fn;
}

/**
 * Default agent call: ONE bounded gateway turn (no tools, no agentic
 * loop). maxTokens is enforced as an approximate character cap
 * (4 chars/token) on the accumulated text — the gateway input carries no
 * max-tokens field, so this is documented as approximate, not exact.
 */
async function defaultAgentFn(args: FlowAgentCallArgs): Promise<string> {
  const model = await resolveChatDefault(args.auth.tenantId, args.auth.userId, args.auth.roleId);
  if (!model) {
    throw Errors.internal('No servable model available for flow agent step', undefined, 'NO_AGENT_MODEL');
  }
  const result = await gatewayStream({
    tenantId: args.auth.tenantId,
    userId: args.auth.userId,
    roleId: args.auth.roleId,
    requestId: `flow-agent-${randomUUID()}`,
    modelId: model.id,
    classification: args.auth.clearance,
    messages: [{ role: 'user', content: args.prompt }],
    signal: args.signal,
  });
  let text = '';
  for await (const event of result.events) {
    if (event.type === 'text') text += event.content;
  }
  return text.slice(0, args.step.maxTokens * 4);
}

// ---------------------------------------------------------------------------
// Agent output: JSON extraction + JSON-schema subset validation
// ---------------------------------------------------------------------------

/** Tolerantly extract the first {...} or [...] JSON value from model text. */
export function extractAgentJson(text: string): unknown {
  const objStart = text.indexOf('{');
  const arrStart = text.indexOf('[');
  let start = -1;
  let endChar = '';
  if (objStart >= 0 && (arrStart < 0 || objStart < arrStart)) {
    start = objStart;
    endChar = '}';
  } else if (arrStart >= 0) {
    start = arrStart;
    endChar = ']';
  }
  if (start < 0) {
    throw Errors.badRequest('AGENT_OUTPUT_NOT_JSON', 'Agent step did not return JSON');
  }
  const end = text.lastIndexOf(endChar);
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Errors.badRequest('AGENT_OUTPUT_NOT_JSON', 'Agent step returned malformed JSON');
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Validate a value against a JSON Schema (draft-07 subset). Supported
 * keywords: type (string|number|integer|boolean|object|array|null),
 * properties, required, items, enum, additionalProperties. Anything else
 * in the schema is ignored. Returns an error description, or null when
 * the value is valid.
 */
export function validateJsonSchema(
  schema: unknown,
  value: unknown,
  path = '$',
): string | null {
  if (!isPlainObject(schema)) {
    throw Errors.badRequest(
      'AGENT_OUTPUT_SCHEMA_INVALID',
      'Agent step outputSchema must be a JSON Schema object',
    );
  }
  const type = (schema as { type?: unknown }).type;
  if (typeof type === 'string') {
    const typeOk =
      (type === 'string' && typeof value === 'string') ||
      (type === 'number' && typeof value === 'number' && Number.isFinite(value)) ||
      (type === 'integer' && typeof value === 'number' && Number.isInteger(value)) ||
      (type === 'boolean' && typeof value === 'boolean') ||
      (type === 'object' && isPlainObject(value)) ||
      (type === 'array' && Array.isArray(value)) ||
      (type === 'null' && value === null);
    if (!typeOk) return `${path}: expected ${type}, got ${describeOutputShape(value)}`;
  }
  const schemaRec = schema as {
    properties?: unknown;
    required?: unknown;
    items?: unknown;
    enum?: unknown;
    additionalProperties?: unknown;
  };
  if (Array.isArray(schemaRec.enum)) {
    const allowed = schemaRec.enum as unknown[];
    if (!allowed.some((candidate) => canonicalEqual(candidate, value))) {
      return `${path}: value not in enum`;
    }
  }
  if (isPlainObject(value)) {
    if (Array.isArray(schemaRec.required)) {
      for (const key of schemaRec.required) {
        if (typeof key === 'string' && !(key in value)) {
          return `${path}: missing required property "${key}"`;
        }
      }
    }
    if (isPlainObject(schemaRec.properties)) {
      for (const [key, propSchema] of Object.entries(schemaRec.properties)) {
        if (key in value) {
          const nested = validateJsonSchema(propSchema, value[key], `${path}.${key}`);
          if (nested) return nested;
        }
      }
    }
    if (schemaRec.additionalProperties === false && isPlainObject(schemaRec.properties)) {
      for (const key of Object.keys(value)) {
        if (!(key in schemaRec.properties)) {
          return `${path}: additional property "${key}" not allowed`;
        }
      }
    }
  }
  if (Array.isArray(value) && schemaRec.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const nested = validateJsonSchema(schemaRec.items, value[i], `${path}[${i}]`);
      if (nested) return nested;
    }
  }
  return null;
}

function canonicalEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

export interface RunFlowOptions {
  signal?: AbortSignal;
}

interface ExecutionContext {
  auth: AuthContext;
  classification: Classification;
  confirmWrites: boolean;
  requestId: string;
  run: FlowRunDoc;
  signal: AbortSignal;
  depth: number;
  /** Abort when the top-level run is no longer `running` (cancel raced us). */
  checkCancelled: () => Promise<boolean>;
  /**
   * Persist a step-log patch. Subflow inner steps pass a no-op: their rows
   * don't exist on the parent run — the subflow step's own row is the
   * persisted record (inner steps are still audited).
   */
  onStepPatch: (index: number, patch: Partial<FlowRunStepLog>) => Promise<void>;
  /** In-memory step outputs for template resolution (never persisted). */
  outputs: Map<string, unknown>;
  /** True for subflow recursion (skips the external-stop re-read; the parent checks). */
  nested: boolean;
}

interface DefinitionOutcome {
  status: 'completed' | 'blocked' | 'cancelled';
  blockedReason?: string;
}

async function auditFlow(
  run: FlowRunDoc,
  action: string,
  success: boolean,
  extra?: { reason?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordAudit({
    tenantId: run.tenantId,
    userId: run.requestedBy.userId,
    requestId: `flow-run-${run._id}`,
    action,
    success,
    reason: extra?.reason ? sanitizeReason(extra.reason) : undefined,
    // Step id + status + error code only — never values (may be secrets).
    metadata: { runId: run._id, ...(extra?.metadata ?? {}) },
  });
}

async function executeToolStep(
  step: ToolFlowStep,
  ctx: ExecutionContext,
  templateCtx: { inputs: Record<string, unknown>; stepOutputs: Map<string, unknown> },
): Promise<unknown> {
  const resolved = resolveParams(step.params, templateCtx);
  if (!isPlainObject(resolved)) {
    throw templateError('tool step params must resolve to an object');
  }
  const timeoutMs = step.timeoutMs ?? config.FLOW_STEP_TIMEOUT_MS;
  const { signal, cancel } = withStepTimeout(ctx.signal, timeoutMs);
  try {
    const result = await (toolExecutorOverride ?? defaultToolExecutor)({
      step,
      params: resolved,
      auth: ctx.auth,
      classification: ctx.classification,
      confirmWrites: ctx.confirmWrites,
      requestId: ctx.requestId,
      signal,
    });
    if (!result.ok) {
      throw Errors.internal(
        result.message ?? `tool "${step.tool}" failed`,
        undefined,
        result.errorCode ?? 'TOOL_STEP_FAILED',
      );
    }
    return result.data;
  } finally {
    cancel();
  }
}

async function executeSubflowStep(
  step: SubflowStep,
  ctx: ExecutionContext,
  templateCtx: { inputs: Record<string, unknown>; stepOutputs: Map<string, unknown> },
): Promise<unknown> {
  if (ctx.depth >= MAX_SUBFLOW_DEPTH) {
    throw Errors.badRequest(
      'SUBFLOW_DEPTH_EXCEEDED',
      `subflow nesting exceeds depth ${MAX_SUBFLOW_DEPTH}`,
    );
  }
  let target: { version: number; definition: FlowDefinition } | null;
  if (step.version !== undefined) {
    const entry = await getVersion(ctx.run.tenantId, step.flow, step.version);
    target = entry ? { version: entry.version, definition: entry.definition } : null;
    if (!target) {
      throw Errors.notFound(
        'SUBFLOW_VERSION_NOT_FOUND',
        `subflow "${step.flow}" has no version ${step.version}`,
      );
    }
  } else {
    target = await getLiveDefinition(ctx.run.tenantId, step.flow);
    if (!target) {
      throw Errors.badRequest(
        'SUBFLOW_NO_LIVE_VERSION',
        `subflow "${step.flow}" has no live version`,
      );
    }
  }
  const resolvedInputs = resolveParams(step.inputs, templateCtx);
  if (!isPlainObject(resolvedInputs)) {
    throw templateError('subflow step inputs must resolve to an object');
  }
  validateFlowInputs(target.definition.inputs, resolvedInputs);

  const timeoutMs = step.timeoutMs ?? config.FLOW_STEP_TIMEOUT_MS;
  const { signal, cancel } = withStepTimeout(ctx.signal, timeoutMs);
  try {
    const nestedOutputs = new Map<string, unknown>();
    const outcome = await executeDefinition(target.definition, resolvedInputs, {
      ...ctx,
      signal,
      depth: ctx.depth + 1,
      nested: true,
      outputs: nestedOutputs,
      // Inner steps have no rows on the parent run: audit only.
      onStepPatch: async () => undefined,
    });
    if (outcome.status !== 'completed') {
      throw Errors.internal(
        `subflow "${step.flow}" ${outcome.status}`,
        undefined,
        outcome.blockedReason ?? 'SUBFLOW_FAILED',
      );
    }
    // The subflow step's output is its last executed step's output.
    // Schema gap (reported, not worked around): FlowDefinition.outputs
    // has no value-mapping expression, so there is no richer contract
    // to resolve declared outputs from.
    const lastStep = [...target.definition.steps].reverse().find((s) => nestedOutputs.has(s.id));
    return lastStep ? nestedOutputs.get(lastStep.id) : null;
  } finally {
    cancel();
  }
}

async function executeAgentStep(
  step: AgentFlowStep,
  ctx: ExecutionContext,
  templateCtx: { inputs: Record<string, unknown>; stepOutputs: Map<string, unknown> },
): Promise<unknown> {
  const resolvedPrompt = resolveValue(step.prompt, templateCtx);
  const prompt =
    typeof resolvedPrompt === 'string' ? resolvedPrompt : JSON.stringify(resolvedPrompt);
  const timeoutMs = step.timeoutMs ?? config.FLOW_STEP_TIMEOUT_MS;
  const { signal, cancel } = withStepTimeout(ctx.signal, timeoutMs);
  try {
    const rawText = await (agentFnOverride ?? defaultAgentFn)({
      step,
      prompt,
      auth: ctx.auth,
      signal,
    });
    const parsed = extractAgentJson(rawText);
    const schemaError = validateJsonSchema(step.outputSchema, parsed);
    if (schemaError) {
      throw Errors.badRequest('AGENT_OUTPUT_SCHEMA_MISMATCH', `agent output invalid: ${schemaError}`);
    }
    return parsed;
  } finally {
    cancel();
  }
}

/**
 * Execute a definition's steps with an instruction pointer. Condition
 * steps jump; forward jumps mark the skipped-over steps `skipped` in the
 * persisted log. Returns the definition outcome; never throws for step
 * failures (they become blocked/continue), but throws for programmer
 * errors (unknown step ids are impossible — validated at publish).
 */
async function executeDefinition(
  definition: FlowDefinition,
  inputs: Record<string, unknown>,
  ctx: ExecutionContext,
): Promise<DefinitionOutcome> {
  const steps = definition.steps;
  const indexById = new Map<string, number>(steps.map((step, i) => [step.id, i]));
  const templateCtx = { inputs, stepOutputs: ctx.outputs };
  let ip = 0;
  let operations = 0;
  const limit = maxOperations(steps.length);

  const markSkipped = async (fromIdx: number, toIdx: number): Promise<void> => {
    for (let i = fromIdx; i < toIdx; i++) {
      const step = steps[i];
      if (!step || ctx.outputs.has(step.id)) continue;
      await ctx.onStepPatch(i, { status: 'skipped', completedAt: new Date() });
      await auditFlow(ctx.run, 'FLOW_RUN_STEP', true, {
        metadata: { stepId: step.id, kind: step.kind, status: 'skipped' },
      });
    }
  };

  while (ip < steps.length) {
    operations += 1;
    if (operations > limit) {
      return { status: 'blocked', blockedReason: 'STEP_LIMIT_EXCEEDED' };
    }
    if (!ctx.nested && (await ctx.checkCancelled())) {
      return { status: 'cancelled' };
    }
    const step: FlowStep = steps[ip]!;
    const stepIndex = ip;

    if (step.kind === 'condition') {
      let outcome: boolean;
      try {
        outcome = evaluateCondition(step.when, templateCtx);
      } catch (error) {
        const code = errorCodeOf(error);
        await ctx.onStepPatch(stepIndex, {
          status: 'failed',
          completedAt: new Date(),
          errorCode: code,
        });
        await auditFlow(ctx.run, 'FLOW_RUN_STEP', false, {
          reason: code,
          metadata: { stepId: step.id, kind: step.kind, status: 'failed' },
        });
        return { status: 'blocked', blockedReason: code };
      }
      const branch = outcome ? step.then : step.else;
      const targetIdx = indexById.get(branch);
      if (targetIdx === undefined) {
        // Unreachable: publish-time validation rejects dangling refs.
        return { status: 'blocked', blockedReason: 'CONDITION_TARGET_MISSING' };
      }
      await ctx.onStepPatch(stepIndex, {
        status: 'ok',
        completedAt: new Date(),
        outputShape: 'boolean',
      });
      ctx.outputs.set(step.id, outcome);
      await auditFlow(ctx.run, 'FLOW_RUN_STEP', true, {
        metadata: { stepId: step.id, kind: step.kind, status: 'ok', branch },
      });
      if (targetIdx > stepIndex + 1) {
        await markSkipped(stepIndex + 1, targetIdx);
      }
      ip = targetIdx;
      continue;
    }

    await ctx.onStepPatch(stepIndex, { status: 'running', startedAt: new Date() });
    const maxAttempts = 1 + (step.retries ?? 0);
    let output: unknown;
    let failureCode: string | null = null;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (attempt > 0) {
        // Small deterministic backoff: 100ms, 200ms, 400ms, …
        await sleep(100 * 2 ** (attempt - 1));
      }
      try {
        if (step.kind === 'tool') {
          output = await executeToolStep(step, ctx, templateCtx);
        } else if (step.kind === 'subflow') {
          output = await executeSubflowStep(step, ctx, templateCtx);
        } else {
          output = await executeAgentStep(step, ctx, templateCtx);
        }
        failureCode = null;
        break;
      } catch (error) {
        failureCode = errorCodeOf(error);
      }
    }

    if (failureCode === null) {
      ctx.outputs.set(step.id, output);
      await ctx.onStepPatch(stepIndex, {
        status: 'ok',
        completedAt: new Date(),
        outputShape: describeOutputShape(output),
      });
      await auditFlow(ctx.run, 'FLOW_RUN_STEP', true, {
        metadata: {
          stepId: step.id,
          kind: step.kind,
          status: 'ok',
          outputShape: describeOutputShape(output),
        },
      });
    } else if (step.continueOnError) {
      await ctx.onStepPatch(stepIndex, {
        status: 'failed',
        completedAt: new Date(),
        errorCode: failureCode,
      });
      await auditFlow(ctx.run, 'FLOW_RUN_STEP', false, {
        reason: failureCode,
        metadata: { stepId: step.id, kind: step.kind, status: 'failed' },
      });
    } else {
      await ctx.onStepPatch(stepIndex, {
        status: 'failed',
        completedAt: new Date(),
        errorCode: failureCode,
      });
      await auditFlow(ctx.run, 'FLOW_RUN_STEP', false, {
        reason: failureCode,
        metadata: { stepId: step.id, kind: step.kind, status: 'failed' },
      });
      return { status: 'blocked', blockedReason: failureCode };
    }
    ip += 1;
  }
  return { status: 'completed' };
}

function summarizeRun(run: FlowRunDoc, steps: FlowRunStepLog[]): string {
  const ok = steps.filter((s) => s.status === 'ok').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  return (
    `Flow "${run.flowName}" v${run.flowVersion} finished: ` +
    `${ok} step(s) ok, ${failed} failed, ${skipped} skipped.`
  );
}

/**
 * Execute one claimed run to a terminal state. Never throws: every failure
 * mode lands the run in `blocked` with a reason and an audit event.
 * Returns the run's final status (for sweep accounting).
 */
export async function runFlow(
  run: FlowRunDoc,
  options: RunFlowOptions = {},
): Promise<FlowRunStatus> {
  const { tenantId, _id: runId } = run;
  const requestId = `flow-run-${runId}`;
  const parentSignal = options.signal;

  const checkCancelled = async (): Promise<boolean> => {
    const current = await getRun(tenantId, runId);
    return !current || current.status !== 'running';
  };

  try {
    // Fail closed on LIVE permissions: the requester must still hold
    // flows:run at run time (a demotion after run creation must not keep
    // driving the run).
    const auth = await liveRequesterAuth({
      _id: run._id,
      requesterUserId: run.requestedBy.userId,
      tenantId: run.tenantId,
    });
    if (!auth || !auth.permissions.includes('flows:run')) {
      await blockRun(tenantId, runId, 'requester-lost-permission');
      await auditFlow(run, 'FLOW_RUN_BLOCKED', false, {
        reason: 'requester-lost-permission',
      });
      return 'blocked';
    }

    // Load the FROZEN version definition — never the mutable draft.
    const entry = await getVersion(tenantId, run.flowName, run.flowVersion);
    if (!entry) {
      await blockRun(tenantId, runId, 'version-not-found');
      await auditFlow(run, 'FLOW_RUN_BLOCKED', false, { reason: 'version-not-found' });
      return 'blocked';
    }

    // Validate inputs against the frozen definition's schema.
    try {
      validateFlowInputs(entry.definition.inputs, run.inputs);
    } catch (error) {
      const code = errorCodeOf(error);
      await blockRun(tenantId, runId, code);
      await auditFlow(run, 'FLOW_RUN_BLOCKED', false, { reason: code });
      return 'blocked';
    }

    await auditFlow(run, 'FLOW_RUN_STARTED', true, {
      metadata: {
        flowName: run.flowName,
        flowVersion: run.flowVersion,
        stepCount: entry.definition.steps.length,
        confirmWrites: run.confirmWrites,
      },
    });

    const outputs = new Map<string, unknown>();
    // No overall run deadline: per-step timeouts plus the per-definition
    // operation cap bound total work deterministically. (Deliberately not
    // AbortSignal.timeout here — that would arm a long-lived timer on
    // every run for no benefit.)
    const runSignal = parentSignal ?? new AbortController().signal;
    const outcome = await executeDefinition(entry.definition, run.inputs, {
      auth,
      classification: auth.clearance,
      confirmWrites: run.confirmWrites,
      requestId,
      run,
      signal: runSignal,
      depth: 0,
      nested: false,
      checkCancelled,
      onStepPatch: (index, patch) => updateRunStep(tenantId, runId, index, patch),
      outputs,
    });

    // Re-read: a cancel (or any external state change) wins over whatever
    // the executor decided — never resurrect a cancelled run.
    const current = await getRun(tenantId, runId);
    if (!current || current.status !== 'running') {
      await auditFlow(run, 'FLOW_RUN_BLOCKED', false, {
        reason: `externally-stopped:${current?.status ?? 'missing'}`,
      });
      return (current?.status ?? 'cancelled') as FlowRunStatus;
    }

    if (outcome.status === 'completed') {
      const summary = summarizeRun(run, current.steps);
      if (await completeRun(tenantId, runId, summary)) {
        await auditFlow(run, 'FLOW_RUN_COMPLETED', true, {
          metadata: {
            stepsOk: current.steps.filter((s) => s.status === 'ok').length,
          },
        });
        return 'completed';
      }
    } else if (outcome.status === 'blocked') {
      const reason = outcome.blockedReason ?? 'STEP_FAILED';
      if (await blockRun(tenantId, runId, reason)) {
        await auditFlow(run, 'FLOW_RUN_BLOCKED', false, { reason });
        return 'blocked';
      }
    }
    const latest = await getRun(tenantId, runId);
    return (latest?.status ?? 'blocked') as FlowRunStatus;
  } catch (error) {
    // Never throws: unexpected runner failures block the run with a reason.
    const code = errorCodeOf(error);
    await blockRun(tenantId, runId, code).catch(() => undefined);
    await auditFlow(run, 'FLOW_RUN_BLOCKED', false, {
      reason: sanitizeReason(error instanceof Error ? error.message : 'flow runner failed') ?? code,
    }).catch(() => undefined);
    return 'blocked';
  }
}

/**
 * One sweep: claim every `queued` run (bounded) and run it. The atomic
 * claim in claimRun is what makes concurrent backends safe; a run whose
 * claim lost (null) is simply skipped.
 */
export async function processQueuedRuns(options: RunFlowOptions = {}): Promise<{
  claimed: number;
  succeeded: number;
  blocked: number;
}> {
  if (!config.FLOW_RUNNER_ENABLED) return { claimed: 0, succeeded: 0, blocked: 0 };
  const runnerId = randomUUID();
  const runs = await findQueuedRuns(config.FLOW_RUNNER_SWEEP_LIMIT);
  let claimed = 0;
  let succeeded = 0;
  let blocked = 0;
  for (const run of runs) {
    const claimedDoc = await claimRun(run.tenantId, run._id, runnerId);
    if (!claimedDoc) continue;
    claimed += 1;
    const finalStatus = await runFlow(claimedDoc, options);
    if (finalStatus === 'completed') succeeded += 1;
    else blocked += 1;
  }
  return { claimed, succeeded, blocked };
}
