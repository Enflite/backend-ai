/**
 * taskRunner.ts — server-side worker for the SyteLine task-agent system
 * (DESIGN.md §11.3).
 *
 * The runner processes `assigned` tasks: it claims them atomically (so
 * concurrent backends never double-run), asks the model for a plan in the
 * runTaskPlan DSL, zod-validates the plan, executes it step-by-step as the
 * task's requester through their own UI session (their saved credentials,
 * §2), captures per-step screenshot evidence, and reports back — the task
 * record is the durable report, plus an assistant message appended to the
 * originating conversation when one is set.
 *
 * Write approval (§11.4): `autoApproveWrites: true` on the task IS the
 * requester's explicit confirmation for that task's write steps — bounded to
 * this task's plan and audited. Default false: the runner executes only the
 * read-only reconnaissance prefix, records the proposed write plan, and
 * marks the task blocked/awaiting-write-approval.
 *
 * Cross-user execution is impossible by construction: the runner always acts
 * as the task's requester (their own saved creds), never as someone else.
 */

import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { getDb, tenantOp } from '../../db/mongo.js';
import { recordAudit, sanitizeReason } from '../../audit/audit.js';
import { Errors } from '../../errors.js';
import type { AuthContext, Classification } from '../../authz/permissions.js';
import { buildAuth, type MembershipRow } from '../../auth/routes.js';
import { gatewayStream } from '../../ai/gateway/gateway.js';
import { resolveChatDefault } from '../../ai/gateway/capabilityRouter.js';
import {
  acquireUiSession,
  releaseUiSession,
  runPlanStep,
  runTaskPlanInput,
  storeScreenshotEvidence,
  type TaskStep,
} from '../../tools/sytelineUi.js';
import {
  blockTask,
  claimTask,
  completeTask,
  findAssignedTasks,
  getTask,
  savePlan,
  setResultSummary,
  updateStep,
} from './taskStore.js';
import type { SytelineTaskDoc, TaskStepLog } from './taskTypes.js';

// ---------------------------------------------------------------------------
// Planner prompt: DSL contract + standing safety rules (DESIGN.md §11.9)
// ---------------------------------------------------------------------------

/**
 * Standing planner guidance, encoded from Jake's canonical PO Detail Report
 * Viewer walkthrough (DESIGN.md §11.9):
 * - "backup before any form change" is a standing safety rule;
 * - the "string or binary data would be truncated" gotcha is a known
 *   SyteLine form-designer pitfall (pasted long text landing in a component
 *   NAME field; keep names short, long text only in value/caption);
 * - live production forms are off-limits unless the goal explicitly names
 *   them (the live Purchase Order Report form changes were deferred to a
 *   live meeting because they immediately affect Purchasing).
 */
export const TASK_PLANNER_SYSTEM_PROMPT = `You are the planner for a SyteLine ERP web-client automation agent. Output ONE JSON object and nothing else: no markdown fences, no commentary.

Schema:
{ "steps": [ { "action": "gotoForm", "form": "FormName" } | { "action": "fillField", "label": "Field label", "value": "value to type" } | { "action": "clickButton", "label": "Button label" } | { "action": "readScreen" } | { "action": "assertText", "text": "expected text" } ] }

Plan rules:
- At most 25 steps. Form names match ^[A-Za-z0-9_]+$ (no spaces).
- Steps run sequentially in a real Chromium browser logged in as the requesting user. Login is already handled; start from the SyteLine home screen.
- readScreen returns the screen's accessible text; assertText fails the task if the text is absent.
- Prefer verifying with readScreen/assertText after writes.

STANDING SAFETY RULES (never violate):
1. BACKUP BEFORE FORM CHANGES: when the goal changes a SyteLine form, the FIRST steps must export a backup of that form through the FormSync form (default scope) before any change. No form changes without a backup.
2. LIVE PRODUCTION FORMS ARE OFF-LIMITS unless the goal explicitly names them. Changes to forms in active daily use (for example the live Purchase Order Report form used by the Purchasing department) are deferred: plan only the safe, explicitly requested scope. A goal that explicitly names a live production form is honored, but the backup step still comes first.
3. KNOWN FORM-DESIGNER PITFALL ("string or binary data would be truncated"): pasting long text can land in a component's NAME field and cause save errors. Keep component names short; put long text only in string value/caption fields. When a step pastes long text, target the caption/value control, never the name control.`;

function buildPlannerUserMessage(goal: string): string {
  return `Goal: ${goal}\n\nProduce the plan JSON now.`;
}

// ---------------------------------------------------------------------------
// Plan generation (model) — with a test seam
// ---------------------------------------------------------------------------

/** Returns the model's raw plan text for a goal. */
export type TaskPlanFn = (
  goal: string,
  auth: AuthContext,
  signal: AbortSignal,
) => Promise<string>;

let planFnOverride: TaskPlanFn | null = null;

/** Test-only seam: substitute plan generation (mirrors overrideUiDriverFactory). */
export function overrideTaskPlanFn(fn: TaskPlanFn | null): void {
  planFnOverride = fn;
}

/**
 * Default plan generation: non-streaming call through the authorized AI
 * gateway (the eval/live.ts accumulation pattern). The requester's serving
 * model plans their own task; classification rides on the task snapshot.
 */
async function defaultPlanFn(
  goal: string,
  auth: AuthContext,
  signal: AbortSignal,
): Promise<string> {
  const model = await resolveChatDefault(auth.tenantId, auth.userId, auth.roleId);
  if (!model) {
    throw Errors.internal('No servable model available for task planning', undefined, 'NO_PLAN_MODEL');
  }
  const result = await gatewayStream({
    tenantId: auth.tenantId,
    userId: auth.userId,
    roleId: auth.roleId,
    requestId: `syteline-task-plan-${randomUUID()}`,
    modelId: model.id,
    classification: auth.clearance,
    messages: [{ role: 'user', content: buildPlannerUserMessage(goal) }],
    systemPrompt: TASK_PLANNER_SYSTEM_PROMPT,
    signal,
  });
  let text = '';
  for await (const event of result.events) {
    if (event.type === 'text') text += event.content;
  }
  return text;
}

/** Tolerantly extract the first {...} JSON object from model text. */
export function extractPlanJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Errors.badRequest('INVALID_PLAN', 'Planner did not return JSON');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Errors.badRequest('INVALID_PLAN', 'Planner returned malformed JSON');
  }
}

// ---------------------------------------------------------------------------
// Runner identity
// ---------------------------------------------------------------------------

/**
 * Rebuild the requester's auth context from the snapshot taken at task
 * creation. The runner is a background worker: sessionId is synthetic and
 * audit events identify the actor as the task runner acting-as-requester.
 *
 * The snapshot is the creation-time record (identity key + what the
 * requester was allowed to do when they asked). Live permission checks use
 * liveRequesterAuth below — never this.
 */
export function authFromSnapshot(task: SytelineTaskDoc): AuthContext {
  const snap = task.authSnapshot;
  return {
    userId: snap.userId,
    email: snap.email,
    displayName: snap.displayName,
    clearance: snap.clearance as Classification,
    tenantId: snap.tenantId,
    roleId: snap.roleId,
    roleName: snap.roleName,
    permissions: [...snap.permissions] as AuthContext['permissions'],
    sessionId: `task-runner:${task._id}`,
  };
}

/**
 * Resolve the requester's LIVE auth context at run time, through the same
 * permission resolution as login (buildAuth). Returns null when the user
 * is gone, deactivated, no longer a member of the task's tenant, or their
 * tenant/role records are missing. A task created before a demotion must
 * not keep driving the user's SyteLine session after revocation — the
 * runner fails closed on anything but a live `syteline:ui` grant.
 */
async function liveRequesterAuth(task: SytelineTaskDoc): Promise<AuthContext | null> {
  const db = await getDb();
  const user = await db.collection<{
    _id: string; email: string; passwordHash: string; displayName: string;
    isActive: boolean; clearance: Classification;
  }>('users').findOne({ _id: task.requesterUserId });
  if (!user || user.isActive === false) return null;
  const membership = await db.collection<{ _id: string; userId: string; tenantId: string; roleId: string }>(
    'memberships',
  ).findOne({ userId: task.requesterUserId, tenantId: task.tenantId });
  if (!membership) return null;
  const [tenant, role] = await Promise.all([
    db.collection<{ _id: string; name: string }>('tenants').findOne({ _id: membership.tenantId }),
    db.collection<{ _id: string; name: string }>('roles').findOne({ _id: membership.roleId }),
  ]);
  if (!tenant || !role) return null;
  const row: MembershipRow = {
    tenantId: membership.tenantId,
    tenantName: tenant.name,
    roleId: membership.roleId,
    roleName: role.name,
  };
  const base = await buildAuth(
    {
      id: user._id, email: user.email, passwordHash: user.passwordHash,
      displayName: user.displayName, isActive: user.isActive, clearance: user.clearance,
    },
    row,
  );
  return { ...base, sessionId: `task-runner:${task._id}` };
}

// ---------------------------------------------------------------------------
// Step classification
// ---------------------------------------------------------------------------

function isWriteStep(step: TaskStep): boolean {
  return step.action === 'fillField' || step.action === 'clickButton';
}

/** Identifier keys only — never values — for audit and the step log. */
function stepDetail(step: TaskStep): string {
  switch (step.action) {
    case 'gotoForm':
      return `form=${step.form}`;
    case 'fillField':
      return `label=${step.label}`;
    case 'clickButton':
      return `label=${step.label}`;
    case 'assertText':
      return `text=${step.text.length} chars`;
    case 'readScreen':
      return 'screen';
  }
}

function errorCodeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof (error as { code: unknown }).code === 'string') {
    return (error as { code: string }).code;
  }
  return 'STEP_FAILED';
}

// ---------------------------------------------------------------------------
// Single-task execution
// ---------------------------------------------------------------------------

export interface RunTaskOptions {
  signal?: AbortSignal;
}

interface MessageDoc {
  _id: string;
  conversationId: string;
  tenantId: string;
  role: string;
  content: string;
  createdAt: Date;
}

async function auditTask(
  task: SytelineTaskDoc,
  action: string,
  success: boolean,
  extra?: { reason?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  await recordAudit({
    tenantId: task.tenantId,
    userId: task.requesterUserId,
    requestId: `syteline-task-${task._id}`,
    action,
    success,
    reason: extra?.reason ? sanitizeReason(extra.reason) : undefined,
    metadata: { taskId: task._id, ...(extra?.metadata ?? {}) },
  });
}

function summarizeOutcome(task: SytelineTaskDoc, steps: TaskStepLog[]): string {
  const ok = steps.filter((s) => s.status === 'ok').length;
  const failed = steps.filter((s) => s.status === 'failed').length;
  const skipped = steps.filter((s) => s.status === 'skipped').length;
  const lines = steps
    .filter((s) => s.status === 'ok' || s.status === 'failed')
    .map((s, i) => `${i + 1}. ${s.action}${s.detail ? ` (${s.detail})` : ''} — ${s.status}`);
  const lastObservation = [...steps].reverse().find((s) => s.observation)?.observation;
  return [
    `Task "${task.title}" finished: ${ok} step(s) ok, ${failed} failed, ${skipped} skipped.`,
    ...lines,
    ...(lastObservation ? [`Last observation: ${lastObservation}`] : []),
  ].join('\n');
}

/**
 * Append the completion report to the originating conversation (when set).
 * The conversation must belong to the task's tenant and requester; the
 * message is a plain assistant message with the summary + evidence ids.
 */
async function reportToConversation(
  task: SytelineTaskDoc,
  summary: string,
): Promise<void> {
  if (!task.conversationId) return;
  const conversationId = task.conversationId;
  await tenantOp(task.tenantId, async (db) => {
    const conversation = await db.collection<{ _id: string }>('conversations').findOne({
      _id: conversationId,
      tenantId: task.tenantId,
      userId: task.requesterUserId,
    });
    if (!conversation) return;
    const evidenceIds = task.steps.flatMap((s) => s.evidenceIds);
    const content = [
      `SyteLine task update — "${task.title}"`,
      `Status: ${task.status}${task.blockedReason ? ` (${task.blockedReason})` : ''}`,
      '',
      summary,
      ...(evidenceIds.length > 0 ? ['', `Screenshot evidence: ${evidenceIds.join(', ')}`] : []),
    ].join('\n');
    await db.collection<MessageDoc>('messages').insertOne({
      _id: randomUUID(),
      conversationId,
      tenantId: task.tenantId,
      role: 'assistant',
      content,
      createdAt: new Date(),
    });
    await db
      .collection<{ _id: string }>('conversations')
      .updateOne({ _id: conversationId }, { $set: { updatedAt: new Date() } });
  });
}

/**
 * Execute one claimed task to a terminal state. Never throws: every failure
 * mode lands the task in `blocked` with a reason and an audit event.
 * Returns the task's final status (for sweep accounting).
 */
export async function runTask(
  task: SytelineTaskDoc,
  options: RunTaskOptions = {},
): Promise<string> {
  const { tenantId, _id: taskId } = task;
  const requestId = `syteline-task-${taskId}`;
  const timeoutMs = config.SYTELINE_TASK_RUNNER_TASK_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const signal = options.signal ?? controller.signal;
  const signalOf = (parent: AbortSignal): AbortSignal => {
    if (parent === controller.signal) return controller.signal;
    const combined = new AbortController();
    const onAbort = (): void => combined.abort();
    parent.addEventListener('abort', onAbort, { once: true });
    controller.signal.addEventListener('abort', onAbort, { once: true });
    return combined.signal;
  };
  const taskSignal = signalOf(signal);

  try {
    // Fail closed on LIVE permissions: the requester must still hold
    // syteline:ui at run time (demotion/deactivation after task creation
    // must not keep driving their SyteLine session).
    const auth = await liveRequesterAuth(task);
    if (!auth || !auth.permissions.includes('syteline:ui')) {
      await blockTask(tenantId, taskId, 'requester-lost-permission');
      await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
        reason: 'requester-lost-permission',
      });
      return 'blocked';
    }

    // 1. Plan (model-generated, zod-validated).
    let steps: TaskStep[];
    try {
      const raw = await (planFnOverride ?? defaultPlanFn)(task.goal, auth, taskSignal);
      steps = runTaskPlanInput.parse(extractPlanJson(raw)).steps;
    } catch (error) {
      const code = errorCodeOf(error);
      // Malformed/non-JSON plans and schema violations are the planner's
      // fault: normalize to 'invalid-plan'. Model/gateway failures keep
      // their own code so operators can tell them apart.
      const reason = code === 'STEP_FAILED' || code === 'INVALID_PLAN' ? 'invalid-plan' : code;
      await blockTask(tenantId, taskId, reason);
      await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
        reason: sanitizeReason(error instanceof Error ? error.message : 'plan validation failed') ?? 'invalid-plan',
        metadata: { phase: 'plan' },
      });
      return 'blocked';
    }

    // 2. Write approval gate (§11.4).
    const firstWriteIdx = steps.findIndex(isWriteStep);
    const needsApproval = firstWriteIdx >= 0 && !task.autoApproveWrites;
    // Without write approval, only the read-only reconnaissance prefix runs;
    // write steps and everything after them are skipped and proposed.
    const executableIdx = new Set<number>();
    steps.forEach((step, i) => {
      if (!needsApproval || (i < firstWriteIdx && !isWriteStep(step))) {
        executableIdx.add(i);
      }
    });

    const stepLogs: TaskStepLog[] = steps.map((step, i) => ({
      action: step.action,
      detail: stepDetail(step),
      status: executableIdx.has(i) ? 'pending' : 'skipped',
      evidenceIds: [],
    }));
    await savePlan(tenantId, taskId, steps, stepLogs);
    await auditTask(task, 'SYTELINE_TASK_STARTED', true, {
      metadata: {
        planSteps: steps.length,
        writeSteps: steps.filter(isWriteStep).length,
        autoApproveWrites: task.autoApproveWrites,
      },
    });

    // 3. Execute as the requester through their own UI session.
    const handle = await acquireUiSession(auth, taskSignal, requestId);
    let finalStatus = 'in_progress';
    try {
      let failedIdx = -1;
      let failedCode = '';
      let externallyStopped = false;
      for (const i of [...executableIdx].sort((a, b) => a - b)) {
        // A cancel (or any external state change) stops execution promptly:
        // the runner never drives the browser for a task that is no longer
        // its to run.
        const current = await getTask(tenantId, taskId);
        if (!current || current.status !== 'in_progress') {
          externallyStopped = true;
          if (current) {
            task.status = current.status;
            task.blockedReason = current.blockedReason;
          }
          break;
        }
        const step = steps[i]!;
        const log = stepLogs[i]!;
        log.status = 'running';
        log.startedAt = new Date();
        await updateStep(tenantId, taskId, i, { status: 'running', startedAt: log.startedAt });
        try {
          const outcome = await runPlanStep(handle.driver, step, taskSignal);
          const png = await handle.driver.screenshot(taskSignal);
          const { evidenceId } = await storeScreenshotEvidence(auth, png, requestId);
          log.status = 'ok';
          log.completedAt = new Date();
          log.evidenceIds = [evidenceId];
          if (step.action === 'readScreen' && typeof outcome.data === 'object' && outcome.data !== null) {
            const text = (outcome.data as { text?: unknown }).text;
            if (typeof text === 'string') log.observation = text.slice(0, 500);
          }
          await updateStep(tenantId, taskId, i, {
            status: 'ok',
            completedAt: log.completedAt,
            evidenceIds: log.evidenceIds,
            ...(log.observation ? { observation: log.observation } : {}),
          });
          await auditTask(task, 'SYTELINE_TASK_STEP', true, {
            metadata: { stepIndex: i, action: step.action, detail: log.detail, evidenceId },
          });
        } catch (error) {
          const code = errorCodeOf(error);
          // Capture the failure state as evidence too.
          try {
            const png = await handle.driver.screenshot(taskSignal);
            const { evidenceId } = await storeScreenshotEvidence(auth, png, requestId);
            log.evidenceIds = [evidenceId];
          } catch {
            // Evidence is best-effort; the failure itself is what matters.
          }
          log.status = 'failed';
          log.completedAt = new Date();
          log.errorCode = code;
          await updateStep(tenantId, taskId, i, {
            status: 'failed',
            completedAt: log.completedAt,
            evidenceIds: log.evidenceIds,
            errorCode: code,
          });
          await auditTask(task, 'SYTELINE_TASK_STEP', false, {
            reason: sanitizeReason(error instanceof Error ? error.message : 'step failed') ?? code,
            metadata: { stepIndex: i, action: step.action, detail: log.detail },
          });
          failedIdx = i;
          failedCode = code;
          break;
        }
      }

      if (externallyStopped) {
        // Someone else owns the state now (e.g. the requester cancelled).
        // Do not overwrite it; just report where the run stopped.
        task.steps = stepLogs;
        finalStatus = task.status;
        await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
          reason: `externally-stopped:${task.status}`,
        });
      } else if (failedIdx >= 0) {
        if (await blockTask(tenantId, taskId, failedCode)) {
          task.status = 'blocked';
          task.blockedReason = failedCode;
          task.steps = stepLogs;
          finalStatus = 'blocked';
        } else {
          const current = await getTask(tenantId, taskId);
          if (current) {
            task.status = current.status;
            task.blockedReason = current.blockedReason;
            finalStatus = current.status;
          }
        }
        await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
          reason: failedCode,
          metadata: { failedStep: failedIdx },
        });
      } else if (needsApproval) {
        const proposed = steps
          .map((s, i) => (executableIdx.has(i) ? null : `${i + 1}. ${s.action} (${stepDetail(s)})`))
          .filter((x): x is string => x !== null);
        const summary =
          `Read-only reconnaissance complete. Proposed write plan (awaiting approval):\n` +
          proposed.join('\n');
        if (await blockTask(tenantId, taskId, 'awaiting-write-approval')) {
          task.status = 'blocked';
          task.blockedReason = 'awaiting-write-approval';
          task.steps = stepLogs;
          task.resultSummary = summary;
          await setResultSummary(tenantId, taskId, summary);
          finalStatus = 'blocked';
        } else {
          const current = await getTask(tenantId, taskId);
          if (current) {
            task.status = current.status;
            task.blockedReason = current.blockedReason;
            finalStatus = current.status;
          }
        }
        await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
          reason: 'awaiting-write-approval',
          metadata: { proposedWriteSteps: proposed.length },
        });
      } else {
        const summary = summarizeOutcome(task, stepLogs);
        if (await completeTask(tenantId, taskId, summary)) {
          task.status = 'completed';
          task.resultSummary = summary;
          task.steps = stepLogs;
          finalStatus = 'completed';
        } else {
          const current = await getTask(tenantId, taskId);
          if (current) {
            task.status = current.status;
            task.blockedReason = current.blockedReason;
            finalStatus = current.status;
          }
        }
        await auditTask(task, 'SYTELINE_TASK_COMPLETED', true, {
          metadata: { stepsOk: stepLogs.filter((s) => s.status === 'ok').length },
        });
      }
      await reportToConversation(task, task.resultSummary ?? summarizeOutcome(task, stepLogs));
    } finally {
      await releaseUiSession(auth, `task-${task.status}`, requestId);
    }
    return finalStatus;
  } catch (error) {
    // Never throws: unexpected runner failures block the task with a reason.
    const code = errorCodeOf(error);
    await blockTask(tenantId, taskId, code).catch(() => undefined);
    await auditTask(task, 'SYTELINE_TASK_BLOCKED', false, {
      reason: sanitizeReason(error instanceof Error ? error.message : 'task runner failed') ?? code,
      metadata: { phase: 'runner' },
    }).catch(() => undefined);
    return 'blocked';
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One sweep: claim every `assigned` task (bounded) and run it. The atomic
 * claim in claimTask is what makes concurrent backends safe; a task whose
 * claim lost (null) is simply skipped.
 */
export async function processAssignedTasks(options: RunTaskOptions = {}): Promise<{
  claimed: number;
  succeeded: number;
  blocked: number;
}> {
  if (!config.SYTELINE_TASK_RUNNER_ENABLED) return { claimed: 0, succeeded: 0, blocked: 0 };
  const runnerId = randomUUID();
  const tasks = await findAssignedTasks(config.SYTELINE_TASK_RUNNER_SWEEP_LIMIT);
  let claimed = 0;
  let succeeded = 0;
  let blocked = 0;
  for (const task of tasks) {
    const claimedDoc = await claimTask(task.tenantId, task._id, runnerId);
    if (!claimedDoc) continue;
    claimed += 1;
    const finalStatus = await runTask(claimedDoc, options);
    if (finalStatus === 'completed') succeeded += 1;
    else blocked += 1;
  }
  return { claimed, succeeded, blocked };
}
