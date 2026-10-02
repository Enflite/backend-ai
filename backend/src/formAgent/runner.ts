/**
 * runner.ts — server-side orchestrator for the SyteLine Form AI Agent.
 *
 * This is where the task-runner pattern plugs in: the orchestrator
 * processes `requested` flow runs — claims them atomically (so concurrent
 * backends never double-run), checks the flow preconditions, executes the
 * declarative flow definition step by step via runFlow (sequential
 * execution, per-step audit evidence, cancellation checks between steps),
 * and writes the completion record. Never throws: every failure mode
 * lands the run in `blocked` with an enumerated reason and an audit
 * event.
 *
 * The pipeline itself lives in flow.ts (data); the step implementations
 * in steps.ts; the agent-escalation seam in agentJudgment.ts.
 */

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { config } from '../config.js';
import { recordAudit, sanitizeReason } from '../audit/audit.js';
import { formProjectsRoot } from '../syteline/forms/index.js';
import { FORM_CUSTOMIZATION_FLOW } from './flow.js';
import {
  runFlow,
  type FlowActor,
  type FlowRunContext,
  type FlowStepOutcome,
} from './flowRunner.js';
import { agentJudge } from './agentJudgment.js';
import { PRECONDITION_CHECKS, STEP_HANDLERS, cleanupInbox, type CustomizationPlan } from './steps.js';
import {
  appendStepOutcome,
  blockCustomization,
  claimCustomization,
  completeCustomization,
  findRequestedCustomizations,
  getCustomization,
  saveCustomizationPlan,
} from './store.js';
import { FORM_CUSTOMIZATION_FLOW_VERSION } from './version.js';
import type { CustomizationResult, FormCustomizationDoc } from './types.js';

export interface RunCustomizationOptions {
  signal?: AbortSignal;
}

async function auditRun(
  doc: FormCustomizationDoc,
  action: string,
  success: boolean,
  extra?: { reason?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordAudit({
    tenantId: doc.tenantId,
    userId: doc.requesterUserId,
    requestId: `form-customization-${doc._id}`,
    action,
    success,
    reason: extra?.reason ? sanitizeReason(extra.reason) : undefined,
    metadata: { customizationId: doc._id, ...(extra?.metadata ?? {}) },
  });
}

/** Rebuild the run context from the persisted run (inbox + request fields). */
function buildRunContext(doc: FormCustomizationDoc): FlowRunContext {
  const actor: FlowActor = {
    tenantId: doc.tenantId,
    userId: doc.requesterUserId,
    roleId: doc.authSnapshot.roleId,
    clearance: doc.authSnapshot.clearance,
    displayName: doc.authSnapshot.displayName,
  };
  return {
    runId: doc._id,
    flowName: doc.flowName,
    flowVersion: doc.flowVersion,
    actor,
    values: {
      'request.formName': doc.formName,
      'request.title': doc.title,
      'request.requestedBy': doc.requestedBy,
      'request.instructions': doc.instructions,
      repo: doc.repo,
      'inbox.dir': join(formProjectsRoot(), doc.inboxDir),
      'validated.formName': doc.formName,
    },
  };
}

function buildResult(doc: FormCustomizationDoc, ctx: FlowRunContext): CustomizationResult {
  const plan = ctx.values['plan'] as CustomizationPlan;
  const formName = doc.formName;
  const prUrl = ctx.values['pr.url'] as string;
  const repo = ctx.values['pr.repo'] as string;
  const sha256Prefix = ctx.values['originals.sha256Prefix'] as string;
  const deckRel = `plan/${formName}_Implementation_Plan.pptx`;
  const openItems = plan.openItems;
  const assumptions = [
    `Table alias "${plan.aliasPrefix}" assumed until Staging check A`,
    'UET design assumed until the TRN UET setup',
    ...(doc.inlineNormalized ? ['Request content arrived inline and was normalized to CRLF+BOM on staging'] : []),
  ];
  const fieldCount = plan.fields.length;
  const fieldNames = plan.fields.map((f) => f.field).join(', ');
  return {
    prUrl,
    repoUrl: `https://github.com/${repo}`,
    resultSummary:
      `The SyteLine Form AI Agent built ${formName}.xml from the TRN original with ${fieldCount} new UET field(s)` +
      (fieldNames ? ` (${fieldNames})` : '') +
      (plan.relabels.length > 0 ? ` and ${plan.relabels.length} relabel(s)` : '') +
      `, highlighted in purple. Implementation plan and deck written; review PR open for a person to review — never merged by automation.`,
    evidence: {
      formXml: `${formName}.xml`,
      deck: deckRel,
      inputs: {
        formXml: `original/${formName}.trn.original.xml`,
        idoPropertiesCsv: 'context/ido-properties.csv',
        sqlColumnsCsv: 'context/sql-columns.csv',
      },
      originals: {
        trn: `original/${formName}.trn.original.xml`,
        prd: `original/${formName}.production.original.xml`,
        sha256Prefix,
      },
      openItems,
      assumptions,
    },
  };
}

/**
 * Execute one claimed flow run to a terminal state. Never throws: every
 * failure mode lands the run in `blocked` with a reason and an audit
 * event. Returns the run's final status (for sweep accounting).
 */
export async function runCustomization(
  doc: FormCustomizationDoc,
  options: RunCustomizationOptions = {},
): Promise<string> {
  const { tenantId, _id: id } = doc;
  const timeoutMs = config.FORM_CUSTOMIZATION_RUNNER_TASK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ?? controller.signal;

  const onStepOutcome = async (outcome: FlowStepOutcome): Promise<void> => {
    await appendStepOutcome(tenantId, id, outcome).catch(() => undefined);
    if (outcome.name === 'plan-changes' && outcome.status === 'done' && outcome.outputs?.['plan']) {
      await saveCustomizationPlan(tenantId, id, outcome.outputs['plan']).catch(() => undefined);
    }
    await auditRun(doc, 'FORM_CUSTOMIZATION_STEP', outcome.status === 'done', {
      metadata: {
        step: outcome.name,
        ...(outcome.blockedCode ? { blockedCode: outcome.blockedCode } : {}),
      },
    }).catch(() => undefined);
  };

  /** Still ours to run? A cancel stops the flow promptly. */
  const shouldStop = async (): Promise<boolean> => {
    const current = await getCustomization(tenantId, id).catch(() => null);
    return !current || current.status !== 'in_progress';
  };

  try {
    const ctx = buildRunContext(doc);
    await auditRun(doc, 'FORM_CUSTOMIZATION_STARTED', true, {
      metadata: { flow: doc.flowName, flowVersion: doc.flowVersion },
    }).catch(() => undefined);

    // Flow preconditions (declared in flow.ts): fail closed, never half-run.
    for (const precondition of FORM_CUSTOMIZATION_FLOW.preconditions) {
      const check = PRECONDITION_CHECKS[precondition.checkRef];
      const ok = check ? (await check(ctx).catch(() => ({ ok: false }))).ok : false;
      if (!ok) {
        await blockCustomization(tenantId, id, precondition.blockedCode, precondition.blockedDetail).catch(() => undefined);
        await auditRun(doc, 'FORM_CUSTOMIZATION_BLOCKED', false, {
          reason: precondition.blockedDetail,
          metadata: { blockedCode: precondition.blockedCode, phase: 'precondition' },
        }).catch(() => undefined);
        return 'blocked';
      }
    }

    const result = await runFlow(
      FORM_CUSTOMIZATION_FLOW,
      ctx,
      { stepHandlers: STEP_HANDLERS, judge: agentJudge, onStepOutcome, shouldStop },
      { skipSteps: ['intake'], signal },
    );

    if (result.status === 'stopped') {
      // Someone else owns the state now (e.g. the requester cancelled).
      // Do not overwrite it.
      const current = await getCustomization(tenantId, id).catch(() => null);
      return current?.status ?? 'cancelled';
    }

    if (result.status === 'done') {
      const completion = buildResult(doc, ctx);
      cleanupInbox(join(formProjectsRoot(), doc.inboxDir));
      if (await completeCustomization(tenantId, id, completion)) {
        await auditRun(doc, 'FORM_CUSTOMIZATION_AWAITING_REVIEW', true, {
          metadata: { repoUrl: completion.repoUrl, prUrl: completion.prUrl, flowVersion: FORM_CUSTOMIZATION_FLOW_VERSION },
        }).catch(() => undefined);
        return 'awaiting_review';
      }
      const current = await getCustomization(tenantId, id).catch(() => null);
      return current?.status ?? 'cancelled';
    }

    // blocked (or failed — normalized to blocked with the step's code).
    const blockedCode = result.blockedCode ?? 'build-check-failed';
    const blockedDetail = result.blockedDetail ?? 'The flow stopped.';
    await blockCustomization(tenantId, id, blockedCode, blockedDetail).catch(() => undefined);
    await auditRun(doc, 'FORM_CUSTOMIZATION_BLOCKED', false, {
      reason: blockedDetail,
      metadata: { blockedCode },
    }).catch(() => undefined);
    return 'blocked';
  } catch (error) {
    // Never throws: unexpected orchestrator failures block the run.
    const detail = sanitizeReason(error instanceof Error ? error.message : 'flow runner failed') ?? 'STEP_FAILED';
    await blockCustomization(tenantId, id, 'build-check-failed', detail).catch(() => undefined);
    await auditRun(doc, 'FORM_CUSTOMIZATION_BLOCKED', false, {
      reason: detail,
      metadata: { blockedCode: 'build-check-failed', phase: 'runner' },
    }).catch(() => undefined);
    return 'blocked';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One sweep: claim every `requested` run (bounded) and execute it. The
 * atomic claim in claimCustomization is what makes concurrent backends
 * safe; a run whose claim lost (null) is simply skipped.
 */
export async function processRequestedCustomizations(
  options: RunCustomizationOptions = {},
): Promise<{ claimed: number; succeeded: number; blocked: number }> {
  if (!config.FORM_CUSTOMIZATION_RUNNER_ENABLED) return { claimed: 0, succeeded: 0, blocked: 0 };
  const runnerId = randomUUID();
  const docs = await findRequestedCustomizations(config.FORM_CUSTOMIZATION_RUNNER_SWEEP_LIMIT);
  let claimed = 0;
  let succeeded = 0;
  let blocked = 0;
  for (const doc of docs) {
    const claimedDoc = await claimCustomization(doc.tenantId, doc._id, runnerId);
    if (!claimedDoc) continue;
    claimed += 1;
    const finalStatus = await runCustomization(claimedDoc, options);
    if (finalStatus === 'awaiting_review') succeeded += 1;
    else blocked += 1;
  }
  return { claimed, succeeded, blocked };
}
