/**
 * sytelineUi.ts — agentic SyteLine UI automation tools (syteline.ui.*).
 *
 * The assistant drives the SyteLine web client in a real browser session as
 * the requesting user: it logs in with the user's own stored credentials
 * (or the tenant service-account fallback), navigates forms, fills fields,
 * clicks buttons, and reads results back.
 *
 * Hard guards (enforced here, in application code — never in prompts):
 * - Every tool requires the `syteline:ui` permission (Admin / AI Admin only).
 * - Master kill-switch SYTELINE_UI_ENABLED (default false): every tool fails
 *   fast when the feature is off.
 * - Write actions (fillField, clickButton, runTaskPlan, save/delete
 *   credentials) are destructive:true and ride the agentic loop's explicit
 *   confirmation gate — no new bypass.
 * - Screenshots are stored server-side (tenant-scoped); the model only ever
 *   sees evidence ids, never pixels.
 * - The decrypted password lives in memory for a single login call and is
 *   zero-filled immediately after. It is never logged, persisted, echoed in
 *   tool output, or returned in errors (failure paths go through
 *   sanitizeReason).
 * - `syteline.ui.saveCredentials` sets secretParams:['password'] so the
 *   gateway redacts it from persisted tool_executions parameters.
 *
 * Browser behavior here REQUIRES REAL SYTELINE; CI exercises the whole tool
 * family through the deterministic FakeDriver (VALIDATED IN CI).
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { recordAudit, sanitizeReason } from '../audit/audit.js';
import type { AuthContext, Classification } from '../authz/permissions.js';
import type { ToolDefinition, ToolExecutionContext } from './gateway.js';
import { loginSyteline, type UiDriver } from '../syteline/ui/driver.js';
import { PlaywrightDriver } from '../syteline/ui/playwrightDriver.js';
import {
  UiSessionManager,
  type UiConnectFn,
  type UiDriverFactory,
  type UiSessionHandle,
} from '../syteline/ui/sessionManager.js';
import {
  deleteCredential,
  listCredentials,
  resolveUiCredentials,
  saveCredential,
} from '../syteline/ui/credentialStore.js';

const UI_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

// Strict character classes keep model-supplied values from becoming injection
// vectors at the driver layer (same posture as the SyteLine read tools).
const formNameSchema = () => z.string().trim().min(1).max(60).regex(/^[A-Za-z0-9_]+$/);
const controlLabelSchema = () => z.string().trim().min(1).max(120);

// ---------------------------------------------------------------------------
// Feature gates
// ---------------------------------------------------------------------------

/** Fail closed: every UI tool refuses when the master kill-switch is off. */
function assertUiEnabled(): void {
  if (!config.SYTELINE_UI_ENABLED) {
    throw Errors.forbidden(
      'SYTELINE_UI_DISABLED',
      'SyteLine UI automation is disabled (SYTELINE_UI_ENABLED=false)',
    );
  }
}

function uiBaseUrl(): string {
  const url = config.SYTELINE_UI_URL;
  if (!url) {
    throw Errors.badRequest('SYTELINE_UI_NOT_CONFIGURED', 'SYTELINE_UI_URL is not configured');
  }
  return url;
}

// ---------------------------------------------------------------------------
// Session wiring (driver factory override is the test seam)
// ---------------------------------------------------------------------------

let driverFactoryOverride: UiDriverFactory | null = null;
let sessionManager: UiSessionManager | null = null;

/**
 * Test-only seam: substitute the browser driver factory (the FakeDriver).
 * Production always launches real Chromium via PlaywrightDriver. Not for
 * production use.
 */
export function overrideUiDriverFactory(factory: UiDriverFactory | null): void {
  driverFactoryOverride = factory;
  sessionManager = null;
}

/**
 * Server-side accessor for the shared UI session manager (task runner).
 * Respects the driver factory override, so tests drive the FakeDriver.
 */
export function getUiSessionManager(): UiSessionManager {

  if (!sessionManager) {
    const factory: UiDriverFactory =
      driverFactoryOverride ?? (async () => PlaywrightDriver.launch());
    sessionManager = new UiSessionManager({ driverFactory: factory });
  }
  return sessionManager;
}

/**
 * Resolve the caller's login credentials and run the SyteLine form login.
 * The decrypted password buffer is zero-filled in the finally block — the
 * single login call is its only use. (The string copy handed to the driver
 * is unavoidable in JS; the Buffer holding the decrypted secret is what we
 * control, and it is wiped immediately.)
 */
function connectWithUserCredentials(
  auth: AuthContext,
  requestId?: string,
): UiConnectFn {
  return async (driver: UiDriver, signal: AbortSignal) => {
    const creds = await resolveUiCredentials(auth);
    if (!creds) {
      throw Errors.badRequest(
        'NO_UI_CREDENTIALS',
        'No SyteLine credentials available: save them with syteline.ui.saveCredentials ' +
          'or configure the SYTELINE_UI_USERNAME / SYTELINE_UI_PASSWORD service account',
      );
    }
    try {
      await loginSyteline(driver, creds.username, creds.password.toString('utf8'), uiBaseUrl(), signal);
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId,
        action: 'SYTELINE_UI_LOGIN',
        success: true,
        metadata: { username: creds.username, source: creds.source },
      });
    } catch (error) {
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId,
        action: 'SYTELINE_UI_LOGIN',
        success: false,
        reason: sanitizeReason(error instanceof Error ? error.message : 'Login failed'),
        metadata: { username: creds.username, source: creds.source },
      });
      throw error instanceof Error
        ? error
        : Errors.badRequest('SYTELINE_UI_LOGIN_FAILED', 'SyteLine login failed');
    } finally {
      creds.password.fill(0);
    }
  };
}

async function acquireSession(
  ctx: ToolExecutionContext,
  signal: AbortSignal,
): Promise<UiSessionHandle> {
  return acquireUiSession(ctx.auth, signal, ctx.requestId);
}

/**
 * Acquire (or reuse) the requester's logged-in browser session outside the
 * tool pipeline — used by the SyteLine task runner, which acts as the task's
 * requester. Same login/credential semantics as the tools; the caller owns
 * releasing the session when done.
 */
export async function acquireUiSession(
  auth: AuthContext,
  signal: AbortSignal,
  requestId?: string,
): Promise<UiSessionHandle> {
  assertUiEnabled();
  uiBaseUrl();
  const handle = await getUiSessionManager().acquire(auth, {
    connect: connectWithUserCredentials(auth, requestId),
    signal,
    requestId,
  });
  handle.touch();
  return handle;
}

/** Release the requester's browser session (task runner cleanup). */
export async function releaseUiSession(
  auth: AuthContext,
  reason: string,
  requestId?: string,
): Promise<boolean> {
  return getUiSessionManager().release(auth, reason, requestId);
}

/** The caller's live session; throws NO_UI_SESSION when startSession was never called. */
function requireSession(ctx: ToolExecutionContext): UiSessionHandle {
  assertUiEnabled();
  const handle = getUiSessionManager().peek(ctx.auth);
  if (!handle) {
    throw Errors.badRequest(
      'NO_UI_SESSION',
      'No SyteLine browser session: call syteline.ui.startSession first',
    );
  }
  handle.touch();
  return handle;
}

// ---------------------------------------------------------------------------
// Screenshot evidence (server-side, tenant-scoped; model sees ids only)
// ---------------------------------------------------------------------------

function evidenceDir(tenantId: string): string {
  const root = config.SYTELINE_UI_EVIDENCE_DIR;
  const dir = join(root, tenantId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Capture evidence helper shared with the task runner: persists a
 * screenshot server-side (tenant-scoped) and returns the evidence id.
 */
export async function storeScreenshotEvidence(
  auth: AuthContext,
  png: Buffer,
  requestId?: string,
): Promise<{ evidenceId: string; capturedAt: string }> {
  // Local tenant dir for now (TODO: migrate to the object-storage
  // abstraction when UI automation needs multi-instance evidence).
  const evidenceId = randomUUID();
  writeFileSync(join(evidenceDir(auth.tenantId), `${evidenceId}.png`), png);
  const capturedAt = new Date().toISOString();
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    requestId,
    action: 'SYTELINE_UI_SCREENSHOT',
    success: true,
    metadata: { evidenceId, bytes: png.length },
  });
  return { evidenceId, capturedAt };
}

// ---------------------------------------------------------------------------
// Task-plan DSL
// ---------------------------------------------------------------------------

const MAX_PLAN_STEPS = 25;

const taskStepSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('gotoForm'), form: formNameSchema() }).strict(),
  z.object({
    action: z.literal('fillField'),
    label: controlLabelSchema(),
    value: z.string().min(1).max(2000),
  }).strict(),
  z.object({ action: z.literal('clickButton'), label: controlLabelSchema() }).strict(),
  z.object({ action: z.literal('readScreen') }).strict(),
  z.object({ action: z.literal('assertText'), text: z.string().min(1).max(500) }).strict(),
]);

/**
 * The task-plan DSL schema — shared with the task runner, which
 * zod-validates model-generated plans against it before executing.
 */
export const runTaskPlanInput = z
  .object({ steps: z.array(taskStepSchema).min(1).max(MAX_PLAN_STEPS) })
  .strict();

export type TaskStep = z.infer<typeof taskStepSchema>;

interface PlanStepOutcome {
  step: number;
  action: string;
  ok: boolean;
  /** Identifier the step targeted (label/form) — never field values. */
  target?: string;
  resultChars?: number;
  errorCode?: string;
}

function toolErrorCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code).slice(0, 100)
    : 'UI_STEP_FAILED';
}

/**
 * Execute one validated plan step against a live driver.
 * Shared with the task runner (per-step screenshot evidence).
 */
export async function runPlanStep(
  driver: UiDriver,
  step: TaskStep,
  signal: AbortSignal,
): Promise<{ target?: string; resultChars?: number; data?: unknown }> {
  switch (step.action) {
    case 'gotoForm': {
      await driver.goto(`${uiBaseUrl()}?form=${encodeURIComponent(step.form)}`, signal);
      return { target: step.form };
    }
    case 'fillField': {
      await driver.fillField(step.label, step.value, signal);
      return { target: step.label };
    }
    case 'clickButton': {
      await driver.clickButton(step.label, signal);
      return { target: step.label };
    }
    case 'readScreen': {
      const text = await driver.readScreen(signal);
      const capped = text.slice(0, 4000);
      return { resultChars: text.length, data: { text: capped, truncated: text.length > capped.length } };
    }
    case 'assertText': {
      await driver.waitForText(step.text, signal);
      return { target: `${step.text.length} chars` };
    }
  }
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const sytelineUiToolDefinitions: readonly ToolDefinition<any>[] = [
  {
    name: 'syteline.ui.saveCredentials',
    description:
      'Save (or rotate) YOUR SyteLine web-client login credentials for UI automation. ' +
      'The password is AES-256-GCM encrypted at rest and only ever decrypted in memory ' +
      'for the login step. This is destructive (it replaces any saved credentials) and ' +
      'needs explicit confirmation. Only ever run when the user explicitly asks to save ' +
      'their SyteLine login.',
    action: 'save-credentials',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    secretParams: ['password'],
    schema: z
      .object({
        username: z.string().trim().min(1).max(120),
        password: z.string().min(1).max(512),
        label: z.string().trim().min(1).max(80).optional(),
      })
      .strict(),
    execute: async (
      input: { username: string; password: string; label?: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertUiEnabled();
      const summary = await saveCredential(ctx.auth, input.username, input.password, input.label, ctx.requestId);
      return { saved: true, username: summary.username, updatedAt: summary.updatedAt.toISOString() };
    },
  },
  {
    name: 'syteline.ui.deleteCredentials',
    description:
      'Revoke YOUR saved SyteLine UI credentials (they can no longer be used for ' +
      'browser login). Destructive: needs explicit confirmation.',
    action: 'delete-credentials',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertUiEnabled();
      const deleted = await deleteCredential(ctx.auth, ctx.requestId);
      return { deleted };
    },
  },
  {
    name: 'syteline.ui.listCredentials',
    description:
      'List YOUR saved SyteLine UI credentials (username/label only — never secret material).',
    action: 'list-credentials',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertUiEnabled();
      const creds = await listCredentials(ctx.auth);
      return {
        credentials: creds.map((c) => ({
          username: c.username,
          ...(c.label ? { label: c.label } : {}),
          updatedAt: c.updatedAt.toISOString(),
          ...(c.lastUsedAt ? { lastUsedAt: c.lastUsedAt.toISOString() } : {}),
        })),
      };
    },
  },
  {
    name: 'syteline.ui.startSession',
    description:
      'Open a browser session to the SyteLine web client and log in AS YOU (your ' +
      'stored credentials, or the tenant service account). Only run when the user ' +
      'explicitly asks for UI automation — never start a session speculatively.',
    action: 'start-session',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = await acquireSession(ctx, signal);
      return {
        sessionId: handle.record.sessionId,
        startedAt: handle.record.startedAt.toISOString(),
        url: uiBaseUrl(),
      };
    },
  },
  {
    name: 'syteline.ui.gotoForm',
    description:
      'Navigate the browser session to a SyteLine form by name (formName must match ' +
      '^[A-Za-z0-9_]+$). Requires an active session from syteline.ui.startSession.',
    action: 'goto-form',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({ formName: formNameSchema() }).strict(),
    execute: async (
      input: { formName: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = requireSession(ctx);
      await handle.driver.goto(`${uiBaseUrl()}?form=${encodeURIComponent(input.formName)}`, signal);
      return { navigated: true, form: input.formName };
    },
  },
  {
    name: 'syteline.ui.readScreen',
    description:
      'Read the current browser screen as accessible snapshot text. Requires an active session.',
    action: 'read-screen',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = requireSession(ctx);
      const text = await handle.driver.readScreen(signal);
      const capped = text.slice(0, 4000);
      return { text: capped, truncated: text.length > capped.length };
    },
  },
  {
    name: 'syteline.ui.screenshot',
    description:
      'Capture a screenshot of the current browser screen. Stored server-side ' +
      '(tenant-scoped); returns an evidence id only — never raw pixels. Requires ' +
      'an active session.',
    action: 'screenshot',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = requireSession(ctx);
      const png = await handle.driver.screenshot(signal);
      return storeScreenshotEvidence(ctx.auth, png, ctx.requestId);
    },
  },
  {
    name: 'syteline.ui.fillField',
    description:
      'Fill a field on the current screen, identified by its accessible label. ' +
      'Destructive (writes into SyteLine): needs explicit confirmation. Requires ' +
      'an active session.',
    action: 'fill-field',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z
      .object({ label: controlLabelSchema(), value: z.string().min(1).max(2000) })
      .strict(),
    execute: async (
      input: { label: string; value: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = requireSession(ctx);
      await handle.driver.fillField(input.label, input.value, signal);
      return { filled: true, label: input.label };
    },
  },
  {
    name: 'syteline.ui.clickButton',
    description:
      'Click a button on the current screen, identified by its accessible name ' +
      '(may submit or save). Destructive: needs explicit confirmation. Requires ' +
      'an active session.',
    action: 'click-button',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({ label: controlLabelSchema() }).strict(),
    execute: async (
      input: { label: string },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      const handle = requireSession(ctx);
      await handle.driver.clickButton(input.label, signal);
      return { clicked: true, label: input.label };
    },
  },
  {
    name: 'syteline.ui.runTaskPlan',
    description:
      'Execute an ordered task plan in the browser session: gotoForm, fillField, ' +
      'clickButton, readScreen, and assertText steps run sequentially (max 25), ' +
      'each step audit-logged, stopping at the first failure. Destructive: needs ' +
      'explicit confirmation. Acquires a session (logging in as you) when none exists.',
    action: 'run-task-plan',
    destructive: true,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: runTaskPlanInput,
    execute: async (
      input: { steps: TaskStep[] },
      ctx: ToolExecutionContext,
      signal: AbortSignal,
    ) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertUiEnabled();
      const handle = await acquireSession(ctx, signal);
      const outcomes: PlanStepOutcome[] = [];
      // readScreen payloads are for the model only (never audited — see below).
      const observations: Array<{ step: number; text: string; truncated: boolean }> = [];
      let failedStep: number | null = null;
      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i]!;
        try {
          const result = await runPlanStep(handle.driver, step, signal);
          outcomes.push({ step: i, action: step.action, ok: true, target: result.target, resultChars: result.resultChars });
          if (step.action === 'readScreen' && result.data) {
            observations.push({ step: i, ...(result.data as { text: string; truncated: boolean }) });
          }
        } catch (error) {
          const errorCode = toolErrorCode(error);
          outcomes.push({ step: i, action: step.action, ok: false, errorCode });
          failedStep = i;
          break;
        } finally {
          // Per-step audit: step index, action, and identifier keys only —
          // field values never enter the audit trail (AGENTIC_LOOP_STEP pattern).
          const outcome = outcomes[outcomes.length - 1]!;
          await recordAudit({
            tenantId: ctx.auth.tenantId,
            userId: ctx.auth.userId,
            action: 'SYTELINE_UI_PLAN_STEP',
            success: outcome.ok,
            reason: outcome.ok ? null : outcome.errorCode,
            metadata: {
              sessionId: handle.record.sessionId,
              step: outcome.step,
              stepAction: outcome.action,
              ...(outcome.target ? { target: outcome.target } : {}),
              ...(outcome.resultChars !== undefined ? { resultChars: outcome.resultChars } : {}),
            },
          });
        }
        handle.touch();
      }
      return {
        completed: failedStep === null,
        stepsExecuted: outcomes.length,
        failedStep,
        steps: outcomes.map((o) => ({
          step: o.step,
          action: o.action,
          ok: o.ok,
          ...(o.target ? { target: o.target } : {}),
          ...(o.errorCode ? { errorCode: o.errorCode } : {}),
        })),
        // readScreen payloads flow to model context only — the audit block
        // above records counts and identifiers, never screen text or values.
        observations: observations.length > 0 ? observations : undefined,
      };
    },
  },
  {
    name: 'syteline.ui.endSession',
    description:
      'Close the browser session and release it. Writes a session-summary audit event.',
    action: 'end-session',
    destructive: false,
    permission: 'syteline:ui',
    allowedClassifications: UI_CLASSIFICATIONS,
    schema: z.object({}).strict(),
    execute: async (_input: unknown, ctx: ToolExecutionContext, signal: AbortSignal) => {
      if (signal.aborted) throw Errors.badRequest('TOOL_ABORTED', 'Tool call aborted');
      assertUiEnabled();
      const ended = await getUiSessionManager().release(ctx.auth, 'user_requested', ctx.requestId);
      return { ended };
    },
  },
];
