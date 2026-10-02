/**
 * compile.ts — lowers a Studio automation to a Flows platform definition.
 *
 * The Studio builds no workflow engine: this module translates the
 * automation's steps to flow steps (ADR-022) and registers the result via
 * the flows platform (versioned, live alias). Mapping:
 *
 * - `action`    → one `tool` step calling `studio.executeAction` (reads) or
 *                 `studio.executeWriteAction` (destructive catalog actions).
 *                 Params pass through verbatim: {{inputs.x}} /
 *                 {{steps.y.output...}} templates are resolved by the flow
 *                 runner at run time. retries/continueOnError map directly.
 * - `condition` → one flow `condition` step (then/else rewired to the
 *                 compiled step ids).
 * - `verify`    → a fetch `tool` step, then one `condition` step per field
 *                 assertion (`{{steps.<fetch>.output.<path>}} == '<value>'`),
 *                 then a `studio.fail` tool step. Each assertion's `then`
 *                 jumps to the next assertion (or the next automation step);
 *                 every `else` jumps to the fail step, which blocks the run.
 *                 The fail step sits directly after the last assertion and
 *                 the last assertion's `then` jumps OVER it, so normal flow
 *                 never falls through into it (the runner marks it skipped).
 * - `log`       → one `tool` step calling `studio.log`.
 *
 * Every compiled automation ends with a terminal `__complete` log step so
 * a trailing verify's assertions always have a forward jump target.
 *
 * Compile-time checks (deploy/test/run time, tenant known):
 * - every action/verify step's actionId exists in the catalog (also checked
 *   at authoring time in routes.ts);
 * - every action/verify step's connection exists (or is 'default').
 *
 * Run-time honesty is enforced by the tools themselves: an action executes
 * only when its operation probed `ok` on the connection (STUDIO_ACTION_UNPROBED
 * otherwise), and destructive actions execute only with scoped confirmation.
 */

import { Errors } from '../../errors.js';
import {
  flowDefinitionSchema,
  type FlowDefinition,
  type FlowInputSpec,
  type FlowStep,
} from '../../flows/flowTypes.js';
import { definitionHash } from '../../flows/flowStore.js';
import { getConnection } from '../connections/store.js';
import { DEFAULT_CONNECTION_ID } from '../types.js';
import { getCatalogAction } from '../catalog/catalog.js';
import {
  STUDIO_EXECUTE_ACTION_TOOL,
  STUDIO_EXECUTE_WRITE_ACTION_TOOL,
  STUDIO_FAIL_TOOL,
  STUDIO_LOG_TOOL,
  STUDIO_SNAPSHOT_CHECK_TOOL,
} from './tools.js';
import {
  automationFlowName,
  destructiveStepsOf,
} from './store.js';
import type {
  AutomationStep,
  DestructiveStepInfo,
  StudioAutomationDoc,
} from './types.js';

export interface CompiledAutomation {
  flowName: string;
  definition: FlowDefinition;
  destructiveSteps: DestructiveStepInfo[];
  /** sha256 of the canonical compiled definition (change detection). */
  definitionHash: string;
}

function badStep(stepId: string, message: string): never {
  throw Errors.badRequest('STUDIO_AUTOMATION_BAD_STEP', `Step '${stepId}': ${message}`);
}

/**
 * Structural step-graph checks. The route schemas enforce these at
 * authoring time too; compile re-checks because it is also called
 * programmatically (deploy/test/run of stored docs).
 */
function assertValidStructure(steps: AutomationStep[]): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) badStep(step.id, `duplicate step id: ${step.id}`);
    seen.add(step.id);
  }
  for (const step of steps) {
    if (step.kind !== 'condition') continue;
    for (const target of [step.then, step.else] as const) {
      if (!seen.has(target)) {
        badStep(step.id, `condition references unknown step id "${target}"`);
      }
      if (target === step.id) {
        badStep(step.id, 'condition must not target itself');
      }
    }
  }
}

/** Emit ids for generated flow steps, disambiguating against automation
 *  step ids and already-emitted ids (deterministic). */
function makeIdEmitter(automationStepIds: Set<string>): (base: string) => string {
  const taken = new Set(automationStepIds);
  return (base: string): string => {
    let candidate = base;
    let n = 2;
    while (taken.has(candidate)) {
      candidate = `${base}_${n}`;
      n += 1;
    }
    taken.add(candidate);
    return candidate;
  };
}

const INPUT_REF_PATTERN = /\{\{\s*inputs\.([A-Za-z0-9_]+)/g;

/** Scan step templates for `inputs.<key>` references. */
function scanInputRefs(doc: StudioAutomationDoc): string[] {
  const keys = new Set<string>();
  const scan = (text: string): void => {
    INPUT_REF_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = INPUT_REF_PATTERN.exec(text)) !== null) {
      keys.add(match[1]!);
    }
  };
  for (const step of doc.steps) {
    if (step.kind === 'action' || step.kind === 'verify') {
      scan(JSON.stringify(step.params));
    } else if (step.kind === 'condition') {
      scan(step.when);
    } else {
      scan(step.message);
    }
  }
  return [...keys].sort();
}

function buildInputs(doc: StudioAutomationDoc): Record<string, FlowInputSpec> {
  const inputs: Record<string, FlowInputSpec> = {};
  for (const key of scanInputRefs(doc)) {
    inputs[key] = {
      type: 'string',
      required: false,
      description: 'Referenced by automation steps (auto-detected)',
    };
  }
  // Declared inputs win on key conflicts (e.g. to type a scanned key as a
  // number or mark it required).
  for (const [key, spec] of Object.entries(doc.inputs)) {
    inputs[key] = spec;
  }
  return inputs;
}

function actionToolFor(actionId: string): string {
  const entry = getCatalogAction(actionId);
  return entry?.destructive ? STUDIO_EXECUTE_WRITE_ACTION_TOOL : STUDIO_EXECUTE_ACTION_TOOL;
}

/**
 * Lower an automation to a flow definition. Throws 400/409 on invalid
 * steps or missing connections. Pure except for the connection-existence
 * checks (tenant-scoped store reads).
 */
export async function compileAutomation(
  tenantId: string,
  doc: StudioAutomationDoc,
): Promise<CompiledAutomation> {
  const flowName = automationFlowName(doc._id);
  const automationStepIds = new Set(doc.steps.map((s) => s.id));
  const emitId = makeIdEmitter(automationStepIds);

  // --- Compile-time checks -------------------------------------------------
  assertValidStructure(doc.steps);
  for (const step of doc.steps) {
    if (step.kind === 'action' || step.kind === 'verify') {
      const entry = getCatalogAction(step.actionId);
      if (!entry) {
        badStep(step.id, `unknown catalog action '${step.actionId}'`);
      }
      if (step.connectionId !== DEFAULT_CONNECTION_ID) {
        const connection = await getConnection(tenantId, step.connectionId);
        if (!connection) {
          badStep(
            step.id,
            `connection '${step.connectionId}' does not exist in this tenant`,
          );
        }
      }
    }
  }

  // Map each automation step to the FIRST flow step it compiles to, so
  // condition then/else targets can be rewired. Automation step ids are
  // used verbatim (they are unique and flow-id-safe by schema); only
  // GENERATED ids (verify fetch/assert/fail, __complete) go through the
  // emitter, which disambiguates them against automation step ids.
  const firstFlowStep = new Map<string, string>();
  const terminalId = emitId('__complete');
  for (const step of doc.steps) {
    if (step.kind === 'verify') {
      firstFlowStep.set(step.id, emitId(`${step.id}_fetch`));
    } else {
      firstFlowStep.set(step.id, step.id);
    }
  }
  const targetOf = (automationStepId: string): string =>
    firstFlowStep.get(automationStepId) ?? terminalId;

  const flowSteps: FlowStep[] = [];
  const stepList = doc.steps;
  for (let i = 0; i < stepList.length; i++) {
    const step: AutomationStep = stepList[i]!;
    const nextTarget =
      i + 1 < stepList.length ? targetOf(stepList[i + 1]!.id) : terminalId;

    if (step.kind === 'action') {
      flowSteps.push({
        id: firstFlowStep.get(step.id)!,
        kind: 'tool',
        tool: actionToolFor(step.actionId),
        params: {
          connectionId: step.connectionId,
          actionId: step.actionId,
          params: step.params,
        },
        retries: step.retries,
        continueOnError: step.continueOnError,
      });
      continue;
    }

    if (step.kind === 'condition') {
      flowSteps.push({
        id: firstFlowStep.get(step.id)!,
        kind: 'condition',
        when: step.when,
        then: targetOf(step.then),
        else: targetOf(step.else),
      });
      continue;
    }

    if (step.kind === 'verify') {
      const fetchId = firstFlowStep.get(step.id)!;
      flowSteps.push({
        id: fetchId,
        kind: 'tool',
        tool: actionToolFor(step.actionId),
        params: {
          connectionId: step.connectionId,
          actionId: step.actionId,
          params: step.params,
        },
        retries: 0,
        continueOnError: false,
      });
      const failId = emitId(`${step.id}_failed`);
      // All assert ids are minted upfront: minting is stateful (it
      // disambiguates on collision), so the `then` chain must reference the
      // same ids the steps are emitted with.
      const assertIds = step.assertions.map((_, index) => emitId(`${step.id}_assert_${index}`));
      step.assertions.forEach((assertion, index) => {
        const isLast = index === step.assertions.length - 1;
        flowSteps.push({
          id: assertIds[index]!,
          kind: 'condition',
          // The action tool's output envelope is { status, data, ... }:
          // assertion paths are body-relative, so they resolve under
          // `data`. The flow condition grammar compares the resolved
          // template text against the quoted literal; non-string fields
          // stringify.
          when: `{{steps.${fetchId}.output.data.${assertion.path}}} ${assertion.operator} '${assertion.value}'`,
          then: isLast ? nextTarget : assertIds[index + 1]!,
          else: failId,
        });
      });
      // Placed directly after the last assertion: the last assertion's
      // `then` jumps OVER it (marked skipped), so normal flow never falls
      // through into it. A failed assertion jumps here and blocks the run.
      flowSteps.push({
        id: failId,
        kind: 'tool',
        tool: STUDIO_FAIL_TOOL,
        params: {
          message: `Verify step '${step.id}' failed an assertion`,
          automationId: doc._id,
          stepId: step.id,
        },
        retries: 0,
        continueOnError: false,
      });
      continue;
    }

    // log
    flowSteps.push({
      id: firstFlowStep.get(step.id)!,
      kind: 'tool',
      tool: STUDIO_LOG_TOOL,
      params: {
        message: step.message,
        automationId: doc._id,
        stepId: step.id,
      },
      retries: 0,
      continueOnError: false,
    });
  }

  flowSteps.push({
    id: terminalId,
    kind: 'tool',
    tool: STUDIO_LOG_TOOL,
    params: {
      message: `Automation '${doc.name}' completed.`,
      automationId: doc._id,
      stepId: terminalId,
    },
    retries: 0,
    continueOnError: false,
  });

  const definition = {
    name: flowName,
    title: doc.title,
    description: doc.description || `Compiled from Studio automation '${doc.name}'.`,
    inputs: buildInputs(doc),
    outputs: {},
    steps: flowSteps,
    onError: 'stop' as const,
  };

  let parsed: FlowDefinition;
  try {
    parsed = flowDefinitionSchema.parse(definition);
  } catch (error) {
    throw Errors.badRequest(
      'INVALID_FLOW_DEFINITION',
      `Automation '${doc.name}' does not compile to a valid flow definition`,
      error instanceof Error ? error.message.slice(0, 500) : undefined,
    );
  }

  const destructiveSteps = destructiveStepsOf(doc.steps);
  return {
    flowName,
    definition: parsed,
    destructiveSteps,
    definitionHash: definitionHash(parsed),
  };
}

/**
 * Build the poll-based watcher flow for an `event` trigger (V1, honestly
 * labeled): poll the watched action, snapshot the watched value, and fire
 * the automation's flow via a subflow step when the value changes.
 *
 * The automation's inputs must all be optional: the watcher fires the
 * subflow with empty inputs (V1 — the automation re-fetches the state it
 * needs with its own steps).
 *
 * The watched action must be non-destructive: a watcher polls on a
 * timetable, and polling must never mutate upstream state.
 */
export function compileWatcherFlow(
  automationId: string,
  compiled: CompiledAutomation,
  event: {
    connectionId: string;
    actionId: string;
    params: Record<string, unknown>;
    watchPath: string;
  },
): FlowDefinition {
  const entry = getCatalogAction(event.actionId);
  if (!entry) {
    throw Errors.badRequest(
      'STUDIO_AUTOMATION_BAD_STEP',
      `Event trigger: unknown catalog action '${event.actionId}'`,
    );
  }
  if (entry.destructive) {
    throw Errors.conflict(
      'STUDIO_EVENT_DESTRUCTIVE_ACTION',
      `Event trigger cannot watch destructive action '${event.actionId}': polling must never mutate upstream state`,
    );
  }
  const requiredInputs = Object.entries(compiled.definition.inputs)
    .filter(([, spec]) => spec.required)
    .map(([key]) => key);
  if (requiredInputs.length > 0) {
    throw Errors.badRequest(
      'STUDIO_EVENT_INPUTS_REQUIRED',
      `Event-triggered automations cannot declare required inputs (V1 fires with empty inputs): ${requiredInputs.join(', ')}`,
    );
  }
  const automationFlow = compiled.flowName;
  const valueTemplate = event.watchPath
    ? `{{steps.fetch.output.${event.watchPath}}}`
    : '{{steps.fetch.output}}';
  const definition = {
    name: `${automationFlow}-watch`,
    title: `Watcher for ${automationFlow}`,
    description:
      'Poll-based change watcher (V1 event trigger): snapshots the watched upstream value and fires the automation flow on change.',
    inputs: {},
    outputs: {},
    steps: [
      {
        id: 'fetch',
        kind: 'tool',
        tool: STUDIO_EXECUTE_ACTION_TOOL,
        params: {
          connectionId: event.connectionId,
          actionId: event.actionId,
          params: event.params,
        },
        retries: 0,
        continueOnError: false,
      },
      {
        id: 'check',
        kind: 'tool',
        tool: STUDIO_SNAPSHOT_CHECK_TOOL,
        params: {
          snapshotKey: `studio:${automationId}:event`,
          value: valueTemplate,
        },
        retries: 0,
        continueOnError: false,
      },
      {
        id: 'decide',
        kind: 'condition',
        when: `{{steps.check.output.changed}} == 'true'`,
        then: 'fire',
        else: 'done',
      },
      {
        id: 'fire',
        kind: 'subflow',
        flow: automationFlow,
        alias: 'live' as const,
        inputs: {},
        retries: 0,
        continueOnError: false,
      },
      {
        id: 'done',
        kind: 'tool',
        tool: STUDIO_LOG_TOOL,
        params: {
          message: `Watcher check for automation '${automationId}' completed.`,
          automationId,
          stepId: 'done',
        },
        retries: 0,
        continueOnError: false,
      },
    ],
    onError: 'stop' as const,
  };
  try {
    return flowDefinitionSchema.parse(definition);
  } catch (error) {
    throw Errors.badRequest(
      'INVALID_FLOW_DEFINITION',
      'Event watcher does not compile to a valid flow definition',
      error instanceof Error ? error.message.slice(0, 500) : undefined,
    );
  }
}
