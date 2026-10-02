/**
 * runner.ts — server-side orchestrator for the SyteLine Form AI Agent.
 *
 * The pipeline executes as a versioned flow on the Flows platform
 * (flows/syteline-form-customization.flow.json). This orchestrator:
 *
 *  1. claims `requested` customizations atomically (concurrent backends
 *     never double-run),
 *  2. checks the preconditions (syteline:forms live, GitHub available;
 *     the platform itself re-checks flows:run at run time),
 *  3. ensures the flow is live from the repo JSON (per-tenant converge),
 *  4. creates + claims a platform run and drives it via runFlow,
 *  5. maps the terminal state back onto the customization — same 8-step
 *     log, same blocked codes/details, same audit events as the bespoke
 *     runner.
 *
 * Never throws: every failure mode lands the run in `blocked` with an
 * enumerated reason and an audit event.
 */

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../config.js';
import { recordAudit, sanitizeReason } from '../audit/audit.js';
import { getDb } from '../db/mongo.js';
import { formProjectsRoot, githubPrAvailable } from '../syteline/forms/index.js';
import { liveRequesterAuth } from '../syteline/requesterAuth.js';
import { cancelRun, createRun, getRun } from '../flows/flowStore.js';
import { runFlow } from '../flows/flowRunner.js';
import { FORM_CUSTOMIZATION_FLOW_NAME, ensureFlowLive } from './flowEnsure.js';
import { cleanupInbox, type CustomizationPlan } from './steps.js';
import {
  blockCustomization,
  claimCustomization,
  clearPendingBlocked,
  completeCustomization,
  findRequestedCustomizations,
  getCustomization,
  saveCustomizationPlan,
  setFlowRunId,
} from './store.js';
import type { CustomizationResult, FormCustomizationDoc } from './types.js';

export interface RunCustomizationOptions {
  signal?: AbortSignal;
}

/** Platform step id -> the customization step-log name (8-step log). */
const STEP_LOG_NAMES: Record<string, string> = {
  intake: 'intake',
  validate_inputs: 'validate-inputs',
  backup_originals: 'backup-originals',
  compare_trn_prd: 'compare-trn-prd',
  plan_changes: 'plan-changes',
  apply_changes_trn: 'apply-changes-trn',
  verify: 'verify',
  open_pr: 'open-pr',
};

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

async function blockWith(
  doc: FormCustomizationDoc,
  blockedCode: string,
  blockedDetail: string,
  phase: string,
): Promise<'blocked'> {
  const { tenantId, _id: id } = doc;
  await blockCustomization(tenantId, id, blockedCode, blockedDetail).catch(() => undefined);
  await auditRun(doc, 'FORM_CUSTOMIZATION_BLOCKED', false, {
    reason: blockedDetail,
    metadata: { blockedCode, phase },
  }).catch(() => undefined);
  return 'blocked';
}

/**
 * Build the platform flow inputs from the persisted request. The content
 * bytes come from the staged inbox (the route already validated them);
 * the intake tool short-circuits on the manifest, so they are carried
 * for portability, not re-processed.
 */
function buildFlowInputs(doc: FormCustomizationDoc): Record<string, unknown> {
  const inboxDir = join(formProjectsRoot(), doc.inboxDir);
  const manifest = JSON.parse(readFileSync(join(inboxDir, 'manifest.json'), 'utf8')) as {
    source: 'json' | 'multipart';
    attachmentNames: string[];
  };
  const attachmentContents = manifest.attachmentNames.map((name) =>
    readFileSync(join(inboxDir, 'attachments', name)).toString('base64'),
  );
  return {
    formName: doc.formName,
    title: doc.title,
    requestedBy: doc.requestedBy ?? '',
    instructions: doc.instructions,
    formXml: readFileSync(join(inboxDir, 'form.xml'), 'utf8'),
    idoPropertiesCsv: readFileSync(join(inboxDir, 'ido.csv'), 'utf8'),
    sqlColumnsCsv: readFileSync(join(inboxDir, 'sql.csv'), 'utf8'),
    attachmentNames: manifest.attachmentNames,
    attachmentContents,
    source: manifest.source,
    repo: doc.repo,
    customizationId: doc._id,
  };
}

/**
 * Sync the platform run's step log into the customization's 8-step log.
 * Tool steps already noted their own `done` outcomes progressively (the
 * sync skips those); this covers the agent step, failed steps, and any
 * gap, and persists the planner output. Missing steps are INSERTED in
 * pipeline order (not appended), so the log always reads
 * intake → … → open-pr.
 */
async function syncStepLog(
  doc: FormCustomizationDoc,
  flowRunId: string,
  outputs: Map<string, unknown>,
): Promise<void> {
  const { tenantId, _id: id } = doc;
  const run = await getRun(tenantId, flowRunId).catch(() => null);
  if (!run) return;
  const db = await getDb();
  const col = db.collection<FormCustomizationDoc>('form_customizations');
  const current = await col.findOne({ _id: id, tenantId }).catch(() => null);
  if (!current) return;
  const steps = [...(current.steps ?? [])];
  const added: string[] = [];

  for (let platformIdx = 0; platformIdx < run.steps.length; platformIdx++) {
    const step = run.steps[platformIdx]!;
    const name = STEP_LOG_NAMES[step.stepId];
    if (!name || steps.some((s) => s.name === name)) continue;
    const ok = step.status === 'ok';
    let detail: string | undefined;
    if (step.stepId === 'plan_changes' && ok) {
      const plan = outputs.get('plan_changes') as CustomizationPlan | undefined;
      detail = `fields=${plan?.fields.length ?? 0}`;
      if (plan) await saveCustomizationPlan(tenantId, id, plan).catch(() => undefined);
    } else if (!ok) {
      detail = step.errorCode;
    }
    const entry = {
      name,
      status: (ok ? 'done' : 'failed') as 'done' | 'failed',
      startedAt: step.startedAt ?? new Date(),
      completedAt: step.completedAt ?? new Date(),
      detail,
    };
    // Insert right after the predecessor in platform order.
    let insertAt = steps.length;
    for (let i = platformIdx - 1; i >= 0; i--) {
      const prevName = STEP_LOG_NAMES[run.steps[i]!.stepId];
      const prevIdx = prevName ? steps.findIndex((s) => s.name === prevName) : -1;
      if (prevIdx >= 0) {
        insertAt = prevIdx + 1;
        break;
      }
    }
    steps.splice(insertAt, 0, entry);
    added.push(name);
    await auditRun(doc, 'FORM_CUSTOMIZATION_STEP', ok, {
      metadata: { step: name, ...(step.errorCode ? { blockedCode: step.errorCode } : {}) },
    }).catch(() => undefined);
  }

  if (added.length > 0) {
    await col
      .updateOne({ _id: id, tenantId }, { $set: { steps, updatedAt: new Date() } })
      .catch(() => undefined);
  }
}

/** Resolve the blocked (code, detail): side-channel first, run reason fallback. */
async function resolveBlocked(
  tenantId: string,
  id: string,
  flowRunId: string,
): Promise<{ code: string; detail: string }> {
  const doc = await getCustomization(tenantId, id).catch(() => null);
  if (doc?.pendingBlocked) {
    return { code: doc.pendingBlocked.code, detail: doc.pendingBlocked.detail };
  }
  const run = await getRun(tenantId, flowRunId).catch(() => null);
  const reason = run?.blockedReason ?? 'build-check-failed';
  // The platform's agent-step schema failure is the pipeline's "the agent
  // couldn't turn the instructions into a valid plan" — keep the
  // user-facing enumerated code and detail.
  if (reason === 'AGENT_OUTPUT_SCHEMA_MISMATCH') {
    return {
      code: 'invalid-requirements',
      detail:
        'The SyteLine Form AI Agent could not turn the instructions into a valid plan. ' +
        'Restate them more concretely (field type, label, tab, position) and create a new request.',
    };
  }
  return { code: reason, detail: 'The flow stopped.' };
}

function buildResult(doc: FormCustomizationDoc, outputs: Map<string, unknown>): CustomizationResult {
  const plan = outputs.get('plan_changes') as CustomizationPlan;
  const formName = doc.formName;
  const openPr = (outputs.get('open_pr') as { prUrl: string; prRepo: string } | undefined) ?? {
    prUrl: '',
    prRepo: doc.repo,
  };
  const backup = (outputs.get('backup_originals') as { sha256Prefix: string } | undefined) ?? {
    sha256Prefix: '',
  };
  const repo = openPr.prRepo;
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
    prUrl: openPr.prUrl,
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
        sha256Prefix: backup.sha256Prefix,
      },
      openItems,
      assumptions,
    },
  };
}

/**
 * Execute one claimed customization to a terminal state. Never throws:
 * every failure mode lands the run in `blocked` with an enumerated
 * reason and an audit event. Returns the run's final status (for sweep
 * accounting).
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
  const runnerId = randomUUID();

  try {
    await auditRun(doc, 'FORM_CUSTOMIZATION_STARTED', true, {
      metadata: { flow: FORM_CUSTOMIZATION_FLOW_NAME, flowVersion: 'live' },
    }).catch(() => undefined);

    // Preconditions (were flow.ts preconditions): fail closed, never half-run.
    const auth = await liveRequesterAuth(doc).catch(() => null);
    if (!auth || !auth.permissions.includes('syteline:forms')) {
      return blockWith(
        doc,
        'requester-lost-permission',
        'The requester no longer holds the syteline:forms permission.',
        'precondition',
      );
    }
    if (!githubPrAvailable()) {
      return blockWith(
        doc,
        'missing-github-token',
        'GitHub is not available: set a valid token before requesting form customizations.',
        'precondition',
      );
    }

    // Ensure the pipeline flow is live from the repo JSON (per-tenant).
    let flowVersion: number;
    try {
      flowVersion = await ensureFlowLive(auth);
    } catch (error) {
      return blockWith(
        doc,
        'build-check-failed',
        error instanceof Error ? error.message : 'The form-customization flow could not be ensured live.',
        'precondition',
      );
    }

    // Create the platform run already claimed (atomic create-and-claim:
    // it never sits `queued` where the generic sweep could pick it up).
    const { run } = await createRun(
      auth,
      FORM_CUSTOMIZATION_FLOW_NAME,
      { inputs: buildFlowInputs(doc), claimBy: runnerId },
      'PROPRIETARY',
    );
    await setFlowRunId(tenantId, id, run._id).catch(() => undefined);
    await clearPendingBlocked(tenantId, id).catch(() => undefined);

    // Drive the platform flow in-process.
    const outputs = new Map<string, unknown>();
    const finalStatus = await runFlow(run, { signal, collectOutputs: outputs });

    if (finalStatus !== 'completed' && finalStatus !== 'blocked') {
      // Cancelled (or otherwise externally stopped): never overwrite the newer state.
      const current = await getCustomization(tenantId, id).catch(() => null);
      return current?.status ?? 'cancelled';
    }

    await syncStepLog(doc, run._id, outputs);

    if (finalStatus === 'completed') {
      const completion = buildResult(doc, outputs);
      cleanupInbox(join(formProjectsRoot(), doc.inboxDir));
      if (await completeCustomization(tenantId, id, completion)) {
        await auditRun(doc, 'FORM_CUSTOMIZATION_AWAITING_REVIEW', true, {
          metadata: { repoUrl: completion.repoUrl, prUrl: completion.prUrl, flowVersion },
        }).catch(() => undefined);
        return 'awaiting_review';
      }
      const current = await getCustomization(tenantId, id).catch(() => null);
      return current?.status ?? 'cancelled';
    }

    // blocked — map the platform outcome back to the enumerated code/detail.
    const { code, detail } = await resolveBlocked(tenantId, id, run._id);
    await blockCustomization(tenantId, id, code, detail).catch(() => undefined);
    await auditRun(doc, 'FORM_CUSTOMIZATION_BLOCKED', false, {
      reason: detail,
      metadata: { blockedCode: code },
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

/** Cancel the platform run behind a customization (cancel bridge). */
export async function cancelCustomizationRun(doc: FormCustomizationDoc): Promise<void> {
  if (!doc.flowRunId) return;
  await cancelRun(doc.tenantId, doc.flowRunId).catch(() => undefined);
}

/**
 * One sweep: claim every `requested` customization (bounded) and execute
 * it. The atomic claim in claimCustomization is what makes concurrent
 * backends safe; a run whose claim lost (null) is simply skipped.
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
