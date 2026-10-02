/**
 * flowRunner.ts — a small generic runner that executes a flow definition
 * step by step.
 *
 * Takes a flow definition + run context, resolves each step's handler
 * from the registry, enforces the declared input/output contracts, and
 * produces per-step outcomes with audit evidence. Deterministic steps run
 * inline; `agentJudgment` steps pause deterministic execution and escalate
 * through the judge seam (agentJudgment.ts).
 *
 * This is where the task-runner pattern plugs in: the product runner
 * (runner.ts) drives runFlow with an atomic claim, sequential execution,
 * per-step audit evidence, and cancellation checks between steps.
 */

import type { AgentJudgmentFn } from './agentJudgment.js';
import type { FlowDefinition, FlowStepDef } from './flow.js';

export interface FlowActor {
  tenantId: string;
  userId: string;
  roleId: string;
  clearance: string;
  displayName: string;
}

export interface FlowRunContext {
  runId: string;
  flowName: string;
  flowVersion: string;
  actor: FlowActor;
  /**
   * Declared inputs + accumulated step outputs, keyed by the def's keys
   * (e.g. 'request.formName', 'plan', 'pr.url'). Handlers read inputs
   * from here and return outputs; the runner merges them back.
   */
  values: Record<string, unknown>;
}

export type FlowStepStatus = 'done' | 'blocked' | 'failed';

export interface FlowStepOutcome {
  name: string;
  status: FlowStepStatus;
  startedAt: string;
  completedAt: string;
  outputs?: Record<string, unknown>;
  blockedCode?: string;
  blockedDetail?: string;
  errorCode?: string;
  /** Identifier keys only — never values. */
  detail?: string;
}

export interface StepResult {
  status: FlowStepStatus;
  outputs?: Record<string, unknown>;
  blockedCode?: string;
  blockedDetail?: string;
  errorCode?: string;
  detail?: string;
}

export interface StepHandlerContext {
  step: FlowStepDef;
  ctx: FlowRunContext;
  judge: AgentJudgmentFn;
  signal: AbortSignal;
}

export type StepHandler = (hctx: StepHandlerContext) => Promise<StepResult>;

export interface FlowRunnerDeps {
  stepHandlers: Record<string, StepHandler>;
  judge: AgentJudgmentFn;
  /** Persist + audit each outcome as it lands. */
  onStepOutcome?: (outcome: FlowStepOutcome) => Promise<void>;
  /** Stop between steps when the run is no longer ours (e.g. cancelled). */
  shouldStop?: () => Promise<boolean>;
}

export interface FlowRunResult {
  status: 'done' | 'blocked' | 'failed' | 'stopped';
  outcomes: FlowStepOutcome[];
  blockedCode?: string;
  blockedDetail?: string;
}

/**
 * Error thrown by step handlers for bad step inputs. At intake the route
 * maps it onto HTTP (400 VALIDATION_ERROR / 413 PART_TOO_LARGE); inside a
 * run it is a programming error and surfaces as a failed step.
 */
export class StepInputError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly httpStatus: number;
  constructor(code: string, message: string, details?: unknown, httpStatus = 400) {
    super(message);
    this.name = 'StepInputError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'STEP_FAILED';
}

/**
 * Execute a single flow step by ref. Used by runFlow and directly by the
 * route for the `intake` step (which runs at request creation, before any
 * run record exists).
 */
export async function runFlowStep(
  def: FlowDefinition,
  stepName: string,
  ctx: FlowRunContext,
  deps: FlowRunnerDeps,
  signal: AbortSignal,
): Promise<FlowStepOutcome> {
  const step = def.steps.find((s) => s.name === stepName);
  if (!step) throw new Error(`unknown flow step "${stepName}"`);
  const startedAt = nowIso();
  const fail = (errorCode: string, detail?: string): FlowStepOutcome => ({
    name: step.name,
    status: 'failed',
    startedAt,
    completedAt: nowIso(),
    errorCode,
    ...(detail ? { detail } : {}),
  });
  try {
    for (const key of step.inputs) {
      if (!(key in ctx.values)) return fail('missing-input', `input "${key}"`);
    }
    const handler = deps.stepHandlers[step.handlerRef];
    if (!handler) return fail('missing-handler', `handler "${step.handlerRef}"`);
    const result = await handler({ step, ctx, judge: deps.judge, signal });
    if (result.status === 'done') {
      for (const key of step.outputs) {
        if (!(key in (result.outputs ?? {}))) return fail('missing-output', `output "${key}"`);
      }
      Object.assign(ctx.values, result.outputs);
    }
    return {
      name: step.name,
      status: result.status,
      startedAt,
      completedAt: nowIso(),
      ...(result.outputs ? { outputs: result.outputs } : {}),
      ...(result.blockedCode ? { blockedCode: result.blockedCode } : {}),
      ...(result.blockedDetail ? { blockedDetail: result.blockedDetail } : {}),
      ...(result.errorCode ? { errorCode: result.errorCode } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    };
  } catch (error) {
    // StepInputError propagates to the caller (the route maps it to HTTP).
    if (error instanceof StepInputError) throw error;
    return fail(errorCodeOf(error));
  }
}

/**
 * Execute every step of the definition in order. Stops at the first
 * non-`done` outcome. Never throws (except StepInputError, which only
 * the intake path produces).
 */
export async function runFlow(
  def: FlowDefinition,
  ctx: FlowRunContext,
  deps: FlowRunnerDeps,
  options: { skipSteps?: string[]; signal?: AbortSignal } = {},
): Promise<FlowRunResult> {
  const signal = options.signal ?? AbortSignal.timeout(600000);
  const outcomes: FlowStepOutcome[] = [];
  for (const step of def.steps) {
    if (options.skipSteps?.includes(step.name)) continue;
    if (await deps.shouldStop?.()) {
      return { status: 'stopped', outcomes };
    }
    const outcome = await runFlowStep(def, step.name, ctx, deps, signal);
    outcomes.push(outcome);
    await deps.onStepOutcome?.(outcome);
    if (outcome.status !== 'done') {
      return {
        status: outcome.status,
        outcomes,
        blockedCode: outcome.blockedCode,
        blockedDetail: outcome.blockedDetail,
      };
    }
  }
  return { status: 'done', outcomes };
}
