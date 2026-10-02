/**
 * deploy.ts — automation deploy / undeploy / manual run / webhook fire.
 *
 * Deploy publishes the compiled flow (versioned, live alias via the Flows
 * platform) and wires the trigger:
 * - `manual`    — nothing to wire; runs fire via POST /:id/run.
 * - `scheduled` — a Schedules API schedule targeting the flow (reused, not
 *                 duplicated). The schedule's `confirmWrites` carries the
 *                 deploy-time destructive approval, if given.
 * - `webhook`   — an unguessable token is issued (stored hashed, shown
 *                 once); POST /studio/hooks/:token fires a run.
 * - `event`     — V1 poll-based: a generated watcher flow is published and
 *                 a schedule polls it; the watcher snapshots upstream state
 *                 and fires the automation flow via subflow on change.
 *
 * Destructive gate: when any step uses a destructive catalog action, deploy
 * REQUIRES explicit `confirmDestructive: true` in the request body —
 * otherwise 409 STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED listing the steps.
 * Destructive automations are never deployed silently.
 *
 * Undeploy pauses/removes the trigger (scheduled/event schedules are
 * paused, webhook tokens invalidated) and marks the deployment superseded;
 * the published flow versions stay as immutable history. Deleting an
 * automation tears down its triggers and its studio-managed flows.
 */

import { config } from '../../config.js';
import { Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import type { AuthContext } from '../../authz/permissions.js';
import {
  createFlow,
  getFlow,
  getLiveDefinition,
  publishVersion,
  setLiveAlias,
  createRun,
  deleteFlow,
  updateFlowDraft,
} from '../../flows/flowStore.js';
import { validateFlowInputs } from '../../flows/flowRunner.js';
import { kickFlowRunner } from '../../flows/flowScheduler.js';
import {
  createSchedule,
  updateSchedule,
  pauseSchedule,
  getScheduleById,
} from '../../schedules/scheduleStore.js';
import { liveRequesterAuth } from '../../syteline/requesterAuth.js';
import { compileAutomation, compileWatcherFlow, type CompiledAutomation } from './compile.js';
import {
  automationFlowName,
  automationWatcherName,
  destructiveStepsOf,
  getAutomation,
  setDeployment,
} from './store.js';
import type { AutomationDeployment, StudioAutomationDoc } from './types.js';
import { findAutomationByWebhookToken, issueWebhookToken } from './webhooks.js';

export function assertStudioAutomationsEnabled(): void {
  if (!config.FLOWS_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'Studio automations are disabled (FLOWS_ENABLED=false)',
    );
  }
}

function assertSchedulesEnabled(): void {
  if (!config.SCHEDULES_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'Scheduled and event triggers are disabled (SCHEDULES_ENABLED=false)',
    );
  }
}

/**
 * Publish the compiled definition: create the flow (or update its draft),
 * publish a new immutable version, and point the live alias at it.
 *
 * createFlow takes the requester's auth; deploy synthesizes the minimal
 * context it needs (tenantId for scoping, userId for provenance).
 */
async function publishAutomationFlow(
  tenantId: string,
  userId: string,
  compiled: CompiledAutomation,
): Promise<{ flowName: string; version: number; definitionHash: string }> {
  const existing = await getFlow(tenantId, compiled.flowName);
  if (existing) {
    await updateFlowDraft(tenantId, compiled.flowName, compiled.definition, userId);
  } else {
    await createFlow({ tenantId, userId } as AuthContext, compiled.definition);
  }
  const { flow, version } = await publishVersion(tenantId, compiled.flowName, userId);
  await setLiveAlias(tenantId, compiled.flowName, version.version, flow.revision);
  return { flowName: compiled.flowName, version: version.version, definitionHash: version.definitionHash };
}

/** Wire (or rewire) a Schedules API schedule for a scheduled/event trigger. */
async function ensureTriggerSchedule(
  auth: AuthContext,
  scheduleName: string,
  flowName: string,
  trigger: { expression: string; timezone: string },
  inputs: Record<string, unknown>,
  confirmWrites: boolean,
  title: string,
  description: string,
  existingScheduleId: string | undefined,
): Promise<{ scheduleId: string; scheduleName: string }> {
  const target = { kind: 'flow' as const, flowName, alias: 'live' as const };
  const cronTrigger = { kind: 'cron' as const, expression: trigger.expression, timezone: trigger.timezone };
  if (existingScheduleId) {
    const current = await getScheduleById(auth.tenantId, existingScheduleId).catch(() => null);
    if (current) {
      const updated = await updateSchedule(auth.tenantId, current.name, {
        title,
        description,
        target,
        trigger: cronTrigger,
        inputs,
        confirmWrites,
        enabled: true,
        runAsUserId: auth.userId,
      });
      return { scheduleId: updated._id, scheduleName: updated.name };
    }
  }
  const created = await createSchedule(auth, {
    name: scheduleName,
    title,
    description,
    target,
    trigger: cronTrigger,
    inputs,
    confirmWrites,
    enabled: true,
    runAsUserId: auth.userId,
  });
  return { scheduleId: created._id, scheduleName: created.name };
}

/** Pause (never delete) the schedule backing a trigger — history stays. */
async function pauseTriggerSchedule(
  tenantId: string,
  deployment: AutomationDeployment,
): Promise<void> {
  if (!deployment.scheduleName) return;
  try {
    await pauseSchedule(tenantId, deployment.scheduleName);
  } catch {
    // Best-effort: the schedule may already be gone (deleted out-of-band).
  }
}

export interface DeployResult {
  automation: StudioAutomationDoc;
  /** Present only when a webhook token was (re)issued by this deploy. */
  webhookToken?: string;
  /** Present only when the deploy rotated/invalidated a previous token. */
  webhookTokenRotated?: boolean;
}

export async function deployAutomation(
  auth: AuthContext,
  automationId: string,
  body: { confirmDestructive?: boolean },
  requestId?: string,
): Promise<DeployResult> {
  assertStudioAutomationsEnabled();
  const tenantId = auth.tenantId;
  const doc = await getAutomation(tenantId, automationId);
  if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');

  // Compile validates steps, catalog membership, and connection existence.
  const compiled = await compileAutomation(tenantId, doc);
  const destructiveSteps = compiled.destructiveSteps;
  const confirmDestructive = body.confirmDestructive === true;
  if (destructiveSteps.length > 0 && !confirmDestructive) {
    await recordAudit({
      tenantId,
      userId: auth.userId,
      requestId,
      action: 'STUDIO_AUTOMATION_DEPLOYED',
      success: false,
      reason: 'destructive confirmation required',
      metadata: {
        automationId,
        destructiveSteps: destructiveSteps.map((s) => s.stepId),
      },
    });
    throw Errors.conflict(
      'STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED',
      `This automation has destructive steps (${destructiveSteps.map((s) => `'${s.stepId}'`).join(', ')}). ` +
        'Deploy again with { "confirmDestructive": true } to approve them explicitly.',
      { destructiveSteps },
    );
  }

  // If the trigger kind changed since the last deploy, tear down the old
  // trigger's wiring before wiring the new one.
  const previous = doc.deployment;
  if (
    previous.status === 'deployed' &&
    previous.triggerKind &&
    previous.triggerKind !== doc.trigger.kind
  ) {
    await pauseTriggerSchedule(tenantId, previous);
  }

  const published = await publishAutomationFlow(tenantId, auth.userId, compiled);

  const deployment: AutomationDeployment = {
    status: 'deployed',
    flowName: published.flowName,
    flowVersion: published.version,
    definitionHash: published.definitionHash,
    triggerKind: doc.trigger.kind,
    // confirmWrites rides the trigger: true only when the deployer
    // explicitly approved destructive steps for THIS deployment.
    confirmWrites: destructiveSteps.length > 0 && confirmDestructive,
    deployedAt: new Date(),
    deployedBy: auth.userId,
    undeployedAt: undefined,
  };

  let webhookToken: string | undefined;
  let webhookTokenRotated = false;

  const trigger = doc.trigger;
  if (trigger.kind === 'scheduled') {
    assertSchedulesEnabled();
    const wired = await ensureTriggerSchedule(
      auth,
      automationFlowName(doc._id),
      published.flowName,
      { expression: trigger.cron, timezone: trigger.timezone },
      trigger.inputs,
      deployment.confirmWrites ?? false,
      doc.title,
      doc.description || `Schedule for Studio automation '${doc.name}'.`,
      previous.triggerKind === 'scheduled' ? previous.scheduleId : undefined,
    );
    deployment.scheduleId = wired.scheduleId;
    deployment.scheduleName = wired.scheduleName;
  } else if (trigger.kind === 'event') {
    assertSchedulesEnabled();
    // Publish the generated watcher flow, then schedule its polling.
    const watcherName = automationWatcherName(doc._id);
    const watcherDefinition = compileWatcherFlow(doc._id, compiled, {
      connectionId: trigger.connectionId,
      actionId: trigger.actionId,
      params: trigger.params,
      watchPath: trigger.watchPath,
    });
    const existingWatcher = await getFlow(tenantId, watcherName);
    if (existingWatcher) {
      await updateFlowDraft(tenantId, watcherName, watcherDefinition, auth.userId);
    } else {
      await createFlow({ tenantId, userId: auth.userId } as AuthContext, watcherDefinition);
    }
    const { flow: watcherFlow, version: watcherVersion } = await publishVersion(
      tenantId,
      watcherName,
      auth.userId,
    );
    await setLiveAlias(tenantId, watcherName, watcherVersion.version, watcherFlow.revision);
    const wired = await ensureTriggerSchedule(
      auth,
      watcherName,
      watcherName,
      { expression: trigger.pollCron, timezone: trigger.timezone },
      {},
      // The watcher flow itself is reads-only; confirmWrites propagates
      // through its subflow step to the automation's destructive steps.
      deployment.confirmWrites ?? false,
      `Watcher for '${doc.title}'`,
      `Poll-based change watcher (V1 event trigger) for Studio automation '${doc.name}'.`,
      previous.triggerKind === 'event' ? previous.scheduleId : undefined,
    );
    deployment.scheduleId = wired.scheduleId;
    deployment.scheduleName = wired.scheduleName;
  } else if (trigger.kind === 'webhook') {
    // Keep the existing token on redeploy (rotating would break the
    // caller's configuration); issue one only when there is none or the
    // trigger kind changed.
    if (!previous.webhookTokenHash || previous.triggerKind !== 'webhook') {
      const issued = issueWebhookToken();
      webhookToken = issued.token;
      webhookTokenRotated = !!previous.webhookTokenHash;
      deployment.webhookTokenHash = issued.tokenHash;
      deployment.webhookTokenIssuedAt = new Date().toISOString();
    } else {
      deployment.webhookTokenHash = previous.webhookTokenHash;
      deployment.webhookTokenIssuedAt = previous.webhookTokenIssuedAt;
    }
  }
  // `manual` needs no trigger wiring.

  const updated = await setDeployment(tenantId, automationId, deployment, 'active');
  await recordAudit({
    tenantId,
    userId: auth.userId,
    requestId,
    action: 'STUDIO_AUTOMATION_DEPLOYED',
    success: true,
    metadata: {
      automationId,
      flowName: published.flowName,
      flowVersion: published.version,
      triggerKind: trigger.kind,
      destructiveSteps: destructiveSteps.map((s) => s.stepId),
      confirmDestructive,
      ...(deployment.scheduleName ? { scheduleName: deployment.scheduleName } : {}),
      ...(webhookToken ? { webhookTokenIssued: true } : {}),
    },
  });
  return { automation: updated, ...(webhookToken ? { webhookToken, webhookTokenRotated } : {}) };
}

export async function undeployAutomation(
  auth: AuthContext,
  automationId: string,
  requestId?: string,
): Promise<StudioAutomationDoc> {
  assertStudioAutomationsEnabled();
  const tenantId = auth.tenantId;
  const doc = await getAutomation(tenantId, automationId);
  if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  if (doc.deployment.status !== 'deployed') return doc; // idempotent

  // Pause/remove the trigger. The published flow versions stay as
  // immutable history; the deployment record marks them superseded.
  await pauseTriggerSchedule(tenantId, doc.deployment);

  const deployment: AutomationDeployment = {
    ...doc.deployment,
    status: 'undeployed',
    undeployedAt: new Date(),
    // A webhook token must not survive undeploy: the trigger is gone.
    webhookTokenHash: undefined,
    webhookTokenIssuedAt: undefined,
  };
  const updated = await setDeployment(tenantId, automationId, deployment, 'paused');
  await recordAudit({
    tenantId,
    userId: auth.userId,
    requestId,
    action: 'STUDIO_AUTOMATION_UNDEPLOYED',
    success: true,
    metadata: {
      automationId,
      flowName: doc.deployment.flowName,
      flowVersion: doc.deployment.flowVersion,
      triggerKind: doc.deployment.triggerKind,
    },
  });
  return updated;
}

/**
 * Tear down everything deploy() built: triggers paused/removed and the
 * studio-managed flows deleted (run history in flow_runs is kept). Used by
 * automation delete.
 */
export async function teardownAutomation(
  tenantId: string,
  doc: StudioAutomationDoc,
): Promise<void> {
  if (doc.deployment.status === 'deployed') {
    await pauseTriggerSchedule(tenantId, doc.deployment);
  }
  for (const flowName of [automationFlowName(doc._id), automationWatcherName(doc._id)]) {
    try {
      await deleteFlow(tenantId, flowName);
    } catch {
      // Best-effort: the flow may never have been published.
    }
  }
}

// ---------------------------------------------------------------------------
// Manual run (the `manual` trigger, also usable on any deployed automation)
// ---------------------------------------------------------------------------

export interface ManualRunResult {
  runId: string;
  status: string;
  flowName: string;
  flowVersion: number;
}

export async function runAutomationNow(
  auth: AuthContext,
  automationId: string,
  body: { inputs?: Record<string, unknown>; confirmWrites?: boolean },
  requestId?: string,
): Promise<ManualRunResult> {
  assertStudioAutomationsEnabled();
  const tenantId = auth.tenantId;
  const doc = await getAutomation(tenantId, automationId);
  if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  if (doc.deployment.status !== 'deployed' || !doc.deployment.flowName) {
    throw Errors.conflict(
      'STUDIO_NOT_DEPLOYED',
      `Automation '${doc.name}' is not deployed; deploy it before running`,
    );
  }
  const live = await getLiveDefinition(tenantId, doc.deployment.flowName);
  if (!live) {
    throw Errors.conflict(
      'STUDIO_NOT_DEPLOYED',
      `Automation '${doc.name}' has no live flow version; deploy it again`,
    );
  }
  // Strict input validation before the run is created: unknown keys and
  // wrong types are a 400, never silent coercion.
  const inputs = body.inputs ?? {};
  validateFlowInputs(live.definition.inputs, inputs);

  const confirmWrites = body.confirmWrites ?? false;
  const destructiveSteps = destructiveStepsOf(doc.steps);
  if (destructiveSteps.length > 0 && !confirmWrites) {
    throw Errors.conflict(
      'STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED',
      `This automation has destructive steps (${destructiveSteps.map((s) => `'${s.stepId}'`).join(', ')}). ` +
        'Run again with { "confirmWrites": true } to approve them explicitly for this run.',
      { destructiveSteps },
    );
  }

  const { run } = await createRun(
    auth,
    doc.deployment.flowName,
    { inputs, confirmWrites, version: live.version },
    auth.clearance,
  );
  await recordAudit({
    tenantId,
    userId: auth.userId,
    requestId,
    action: 'STUDIO_AUTOMATION_RUN',
    success: true,
    metadata: {
      automationId,
      runId: run._id,
      flowName: run.flowName,
      flowVersion: run.flowVersion,
      confirmWrites,
      trigger: 'manual',
    },
  });
  kickFlowRunner();
  return { runId: run._id, status: run.status, flowName: run.flowName, flowVersion: run.flowVersion };
}

// ---------------------------------------------------------------------------
// Webhook fire (the `webhook` trigger)
// ---------------------------------------------------------------------------

export interface WebhookFireResult {
  runId: string;
  status: string;
  automationId: string;
}

/**
 * Fire the automation behind a webhook token. The payload becomes the run's
 * inputs (validated against the live flow's input spec first — a bad
 * payload is a 400, never a blocked run). The run executes as the
 * deployer (live auth re-resolved; a demoted/deactivated deployer fails
 * closed). The token itself never appears in logs, audit, or errors.
 */
export async function fireWebhook(
  token: string,
  payload: unknown,
): Promise<WebhookFireResult> {
  assertStudioAutomationsEnabled();
  const doc = await findAutomationByWebhookToken(token);
  if (!doc) {
    throw Errors.notFound('STUDIO_WEBHOOK_NOT_FOUND', 'Unknown webhook token');
  }
  const tenantId = doc.tenantId;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw Errors.badRequest(
      'STUDIO_WEBHOOK_BAD_PAYLOAD',
      'Webhook payload must be a JSON object (it becomes the run inputs)',
    );
  }
  const live = await getLiveDefinition(tenantId, doc.deployment.flowName);
  if (!live) {
    throw Errors.conflict(
      'STUDIO_NOT_DEPLOYED',
      `Automation '${doc.name}' has no live flow version; deploy it again`,
    );
  }
  const inputs = payload as Record<string, unknown>;
  validateFlowInputs(live.definition.inputs, inputs);

  // The run executes as the deployer: re-resolve their LIVE auth (same
  // fail-closed semantics as scheduled runs).
  const deployerAuth = doc.deployment.deployedBy
    ? await liveRequesterAuth({
        _id: `studio-webhook-${doc._id}`,
        requesterUserId: doc.deployment.deployedBy,
        tenantId,
      }).catch(() => null)
    : null;
  if (!deployerAuth || !deployerAuth.permissions.includes('flows:run')) {
    await recordAudit({
      tenantId,
      userId: doc.deployment.deployedBy ?? 'unknown',
      action: 'STUDIO_WEBHOOK_FIRED',
      success: false,
      reason: 'deployer-lost-permission',
      metadata: { automationId: doc._id, flowName: doc.deployment.flowName },
    });
    throw Errors.forbidden(
      'STUDIO_WEBHOOK_AUTH_REVOKED',
      'The user who deployed this automation can no longer run flows; redeploy it',
    );
  }

  const { run } = await createRun(
    deployerAuth,
    doc.deployment.flowName,
    {
      inputs,
      confirmWrites: doc.deployment.confirmWrites ?? false,
      version: live.version,
      idempotencyKey: undefined,
    },
    deployerAuth.clearance,
  );
  await recordAudit({
    tenantId,
    userId: deployerAuth.userId,
    action: 'STUDIO_WEBHOOK_FIRED',
    success: true,
    metadata: {
      automationId: doc._id,
      runId: run._id,
      flowName: run.flowName,
      flowVersion: run.flowVersion,
      trigger: 'webhook',
    },
  });
  kickFlowRunner();
  return { runId: run._id, status: run.status, automationId: doc._id };
}

/** Rotate an automation's webhook token (old token invalidated immediately). */
export async function rotateWebhookToken(
  auth: AuthContext,
  automationId: string,
  requestId?: string,
): Promise<{ automation: StudioAutomationDoc; webhookToken: string }> {
  assertStudioAutomationsEnabled();
  const tenantId = auth.tenantId;
  const doc = await getAutomation(tenantId, automationId);
  if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  if (doc.trigger.kind !== 'webhook') {
    throw Errors.conflict(
      'STUDIO_WEBHOOK_WRONG_TRIGGER',
      `Automation '${doc.name}' does not use a webhook trigger`,
    );
  }
  const issued = issueWebhookToken();
  const deployment: AutomationDeployment = {
    ...doc.deployment,
    webhookTokenHash: issued.tokenHash,
    webhookTokenIssuedAt: new Date().toISOString(),
  };
  // The hash is kept even when undeployed: rotation is a credential
  // operation, not a deployment; the token only fires while the
  // deployment status is 'deployed' (see findAutomationByWebhookToken).
  const updated = await setDeployment(tenantId, automationId, deployment, doc.status);
  await recordAudit({
    tenantId,
    userId: auth.userId,
    requestId,
    action: 'STUDIO_WEBHOOK_ROTATED',
    success: true,
    metadata: { automationId },
  });
  return { automation: updated, webhookToken: issued.token };
}
