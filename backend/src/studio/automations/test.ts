/**
 * test.ts — automation dry-run (`POST /api/v1/studio/automations/:id/test`).
 *
 * Executes the automation's CURRENT DRAFT steps without the flow runner:
 * - non-destructive action/verify steps run FOR REAL against the
 *   connection's upstream (same shared core as the test endpoint and the
 *   flow tools — probe-gated, token zero-filled);
 * - destructive steps are SKIPPED, never executed — a dry run can never
 *   mutate SyteLine state;
 * - condition steps evaluate for real against accumulated step outputs;
 * - log steps resolve their message and write the audit event (marked
 *   test:true).
 *
 * No fake executions: every non-skipped step really ran, and the per-step
 * results say exactly what happened:
 * `{ stepId, kind, status, skipped, request?, response?, durationMs?, error?, detail? }`.
 */

import { AppError } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import type { AuthContext } from '../../authz/permissions.js';
import { validateFlowInputs } from '../../flows/flowRunner.js';
import { evaluateCondition, resolveParams, resolveValue } from '../../flows/template.js';
import { getCatalogAction } from '../catalog/catalog.js';
import {
  executeCatalogAction,
  resolveProbeOperations,
  type FetchFn,
} from '../execution/executeAction.js';
import { compileAutomation, type CompiledAutomation } from './compile.js';
import { toStepOutput } from './tools.js';
import type { AutomationStep, StudioAutomationDoc } from './types.js';

export interface StudioTestStepResult {
  stepId: string;
  kind: AutomationStep['kind'];
  status: 'ok' | 'failed' | 'skipped';
  skipped: boolean;
  durationMs?: number;
  request?: { method: string; url: string; params: Record<string, unknown> };
  response?: { status: number | null; bodyPreview: string; truncated: boolean };
  error?: string;
  detail?: unknown;
}

export interface StudioTestReport {
  automationId: string;
  automationName: string;
  executedAt: string;
  dryRun: true;
  steps: StudioTestStepResult[];
}

export interface DryRunOptions {
  fetchFn?: FetchFn;
}

function errorCodeOf(error: unknown): string {
  return error instanceof AppError && typeof error.code === 'string'
    ? error.code
    : 'STEP_FAILED';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Resolve {{inputs.x}} / {{steps.y.output...}} templates in a step's
 *  params, exactly as the flow runner would before tool execution. */
function resolveStepParams(
  params: Record<string, unknown>,
  templateCtx: { inputs: Record<string, unknown>; stepOutputs: Map<string, unknown> },
): Record<string, unknown> {
  const resolved = resolveParams(params, templateCtx);
  if (!isPlainObject(resolved)) {
    throw new Error('step params must resolve to an object');
  }
  return resolved;
}

function stringifyActual(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return JSON.stringify(value) ?? '';
}

export async function dryRunAutomation(
  auth: AuthContext,
  doc: StudioAutomationDoc,
  inputs: Record<string, unknown>,
  options: DryRunOptions = {},
): Promise<StudioTestReport> {
  const tenantId = auth.tenantId;
  // Compile validates steps, catalog membership, and connection existence.
  const compiled: CompiledAutomation = await compileAutomation(tenantId, doc);
  // Inputs validated against the compiled flow's input spec (strict: unknown
  // keys and wrong types are a 400, never silent coercion).
  validateFlowInputs(compiled.definition.inputs, inputs);

  const steps = doc.steps;
  const indexById = new Map(steps.map((s, i) => [s.id, i] as const));
  const outputs = new Map<string, unknown>();
  const results: StudioTestStepResult[] = [];
  const visited = new Set<number>();

  const skipRemaining = (reason: string): void => {
    for (let i = 0; i < steps.length; i++) {
      if (visited.has(i)) continue;
      visited.add(i);
      const step = steps[i]!;
      results.push({
        stepId: step.id,
        kind: step.kind,
        status: 'skipped',
        skipped: true,
        detail: { reason },
      });
    }
  };

  let ip = 0;
  let stopped = false;
  // Bound total step executions (condition back-jumps), mirroring the flow
  // runner's maxOperations: a backward-jumping condition must terminate.
  let operations = 0;
  const operationLimit = steps.length * 10 + 10;
  while (ip < steps.length && !stopped) {
    operations += 1;
    if (operations > operationLimit) {
      const limitedStep = steps[ip]!;
      visited.add(ip);
      results.push({
        stepId: limitedStep.id,
        kind: limitedStep.kind,
        status: 'failed',
        skipped: false,
        error: 'step limit exceeded: the automation does not terminate',
        detail: { errorCode: 'STEP_LIMIT_EXCEEDED' },
      });
      stopped = true;
      break;
    }
    const step: AutomationStep = steps[ip]!;
    visited.add(ip);
    const templateCtx = { inputs, stepOutputs: outputs };

    if (step.kind === 'action') {
      const entry = getCatalogAction(step.actionId)!;
      if (entry.destructive) {
        outputs.set(step.id, { skipped: true });
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'skipped',
          skipped: true,
          detail: { reason: 'destructive step: never executed in test mode' },
        });
        ip += 1;
        continue;
      }
      const startedAt = Date.now();
      try {
        const probeOperations = await resolveProbeOperations(tenantId, step.connectionId);
        const result = await executeCatalogAction(
          tenantId,
          step.connectionId,
          step.actionId,
          resolveStepParams(step.params, templateCtx),
          probeOperations,
          { fetchFn: options.fetchFn },
        );
        outputs.set(step.id, toStepOutput(result));
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'ok',
          skipped: false,
          durationMs: Date.now() - startedAt,
          request: result.request,
          response: {
            status: result.status,
            bodyPreview: result.bodyText,
            truncated: result.bodyTruncated,
          },
        });
      } catch (error) {
        const code = errorCodeOf(error);
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'failed',
          skipped: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message.slice(0, 500) : code,
          detail: { errorCode: code },
        });
        stopped = true;
      }
      ip += 1;
      continue;
    }

    if (step.kind === 'condition') {
      try {
        const outcome = evaluateCondition(step.when, templateCtx);
        const branch = outcome ? step.then : step.else;
        outputs.set(step.id, outcome);
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'ok',
          skipped: false,
          detail: { result: outcome, branch },
        });
        ip = indexById.get(branch)!;
      } catch (error) {
        const code = errorCodeOf(error);
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'failed',
          skipped: false,
          error: error instanceof Error ? error.message.slice(0, 500) : code,
          detail: { errorCode: code },
        });
        stopped = true;
      }
      continue;
    }

    if (step.kind === 'verify') {
      const entry = getCatalogAction(step.actionId)!;
      if (entry.destructive) {
        outputs.set(step.id, { skipped: true });
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'skipped',
          skipped: true,
          detail: { reason: 'destructive step: never executed in test mode' },
        });
        ip += 1;
        continue;
      }
      const startedAt = Date.now();
      try {
        const probeOperations = await resolveProbeOperations(tenantId, step.connectionId);
        const result = await executeCatalogAction(
          tenantId,
          step.connectionId,
          step.actionId,
          resolveStepParams(step.params, templateCtx),
          probeOperations,
          { fetchFn: options.fetchFn },
        );
        const output = toStepOutput(result);
        outputs.set(`${step.id}_fetch`, output);
        outputs.set(step.id, output);
        const assertionResults = step.assertions.map((assertion) => {
          let actual: unknown;
          let passed = false;
          let error: string | undefined;
          try {
            actual = resolveValue(
              `{{steps.${step.id}_fetch.output.data.${assertion.path}}}`,
              templateCtx,
            );
            const actualText = stringifyActual(actual);
            passed =
              assertion.operator === '=='
                ? actualText === assertion.value
                : actualText !== assertion.value;
          } catch (err) {
            error = err instanceof Error ? err.message.slice(0, 200) : 'resolution failed';
          }
          return {
            path: assertion.path,
            operator: assertion.operator,
            expected: assertion.value,
            actual: error ?? stringifyActual(actual),
            passed: error === undefined && passed,
            ...(error ? { error } : {}),
          };
        });
        const allPassed = assertionResults.every((a) => a.passed);
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: allPassed ? 'ok' : 'failed',
          skipped: false,
          durationMs: Date.now() - startedAt,
          request: result.request,
          response: {
            status: result.status,
            bodyPreview: result.bodyText,
            truncated: result.bodyTruncated,
          },
          detail: { assertions: assertionResults },
        });
        if (!allPassed) stopped = true;
      } catch (error) {
        const code = errorCodeOf(error);
        results.push({
          stepId: step.id,
          kind: step.kind,
          status: 'failed',
          skipped: false,
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message.slice(0, 500) : code,
          detail: { errorCode: code },
        });
        stopped = true;
      }
      ip += 1;
      continue;
    }

    // log: resolve the message and write the audit event for real (marked
    // as a test so it never masquerades as a production run's log).
    const resolved = resolveValue(step.message, templateCtx);
    const message = typeof resolved === 'string' ? resolved : JSON.stringify(resolved);
    await recordAudit({
      tenantId,
      userId: auth.userId,
      action: 'STUDIO_AUTOMATION_LOG',
      success: true,
      metadata: { automationId: doc._id, stepId: step.id, message, test: true },
    });
    outputs.set(step.id, { logged: true });
    results.push({
      stepId: step.id,
      kind: step.kind,
      status: 'ok',
      skipped: false,
      detail: { message },
    });
    ip += 1;
  }

  if (stopped) skipRemaining('not reached: an earlier step failed');

  const report: StudioTestReport = {
    automationId: doc._id,
    automationName: doc.name,
    executedAt: new Date().toISOString(),
    dryRun: true,
    steps: results,
  };
  await recordAudit({
    tenantId,
    userId: auth.userId,
    action: 'STUDIO_AUTOMATION_TESTED',
    success: !stopped,
    reason: stopped ? 'dry run stopped at a failed step' : undefined,
    metadata: {
      automationId: doc._id,
      dryRun: true,
      stepsOk: results.filter((r) => r.status === 'ok').length,
      stepsFailed: results.filter((r) => r.status === 'failed').length,
      stepsSkipped: results.filter((r) => r.status === 'skipped').length,
    },
  });
  return report;
}
