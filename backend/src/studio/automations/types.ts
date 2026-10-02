/**
 * types.ts — the Studio automation model (Wave 2: backend automation model).
 *
 * An automation is a Flow definition (the versioned, deterministic pipeline
 * from ADR-022) plus a trigger plus a deployment record. The Studio builds
 * no workflow engine: `compileAutomation()` (compile.ts) lowers these steps
 * to a flow definition the Flows platform already knows how to version,
 * run, and audit.
 *
 * Step kinds:
 * - `action`    — one catalog action against a named connection
 *                 (params may carry {{inputs.x}} / {{steps.y.output...}}
 *                 templates, resolved by the flow runner at run time).
 * - `condition` — a flow `when` expression over prior step outputs with
 *                 then/else step ids (the flow template grammar — no eval).
 * - `verify`    — re-fetch via a catalog action, then field assertions over
 *                 the fetched output. Compiles to a fetch tool step plus one
 *                 condition step per assertion; a failed assertion jumps to a
 *                 generated fail step that blocks the run.
 * - `log`       — a message template written to the audit log.
 *
 * Trigger kinds:
 * - `manual`    — fired on demand via POST /:id/run.
 * - `scheduled` — a Schedules API schedule targeting the compiled flow
 *                 (reused, not duplicated).
 * - `webhook`   — POST /studio/hooks/:token fires a run; the token is
 *                 unguessable, stored hashed, and shown exactly once.
 * - `event`     — V1 is poll-based and labeled as such: a schedule runs a
 *                 generated watcher flow that snapshots upstream state in
 *                 `studio_snapshots` and fires the automation flow via a
 *                 subflow step when the watched value changes.
 */

import { z } from 'zod';
import { isValidCronExpression, isValidTimezone } from '../../schedules/cron.js';
import { flowInputSpecSchema, type FlowInputSpec } from '../../flows/flowTypes.js';

/** Automation step ids share the flow step-id character class so compiled
 *  flow steps can reuse them directly. */
export const automationStepIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'step id must match ^[a-zA-Z0-9_-]{1,64}$');

export type AutomationStepId = z.infer<typeof automationStepIdSchema>;

const actionStepSchema = z
  .object({
    id: automationStepIdSchema,
    kind: z.literal('action'),
    /** Catalog action id, e.g. 'syteline.getItem'. Must exist in the catalog. */
    actionId: z.string().min(1).max(120),
    /** Named studio connection (or 'default'). Must exist at deploy time. */
    connectionId: z.string().min(1).max(120),
    /** Validated against the catalog entry's params schema at run time.
     *  Values may be {{inputs.x}} / {{steps.y.output...}} templates. */
    params: z.record(z.string(), z.unknown()).default({}),
    retries: z.number().int().min(0).max(5).default(0),
    continueOnError: z.boolean().default(false),
  })
  .strict();

export type ActionAutomationStep = z.infer<typeof actionStepSchema>;

const conditionStepSchema = z
  .object({
    id: automationStepIdSchema,
    kind: z.literal('condition'),
    /** Flow `when` grammar: templates resolved strictly, then an optional
     *  `==`/`!=` comparison against a quoted literal, else truthiness. */
    when: z.string().min(1).max(2000),
    then: automationStepIdSchema,
    else: automationStepIdSchema,
  })
  .strict();

export type ConditionAutomationStep = z.infer<typeof conditionStepSchema>;

/** One field assertion over a verify step's fetched response body. The
 *  value is compared as a string (the flow condition grammar compares the
 *  resolved template text against a quoted literal). */
const verifyAssertionSchema = z
  .object({
    /** Dotted path into the fetched response body, e.g. 'status' or
     *  'lines[0].item'. (The action tool's output envelope is
     *  { status, data, ... }; the compiler resolves this under `data`.) */
    path: z
      .string()
      .min(1)
      .max(200)
      .regex(
        /^[A-Za-z0-9_-]+(\[\d+\])?(\.[A-Za-z0-9_-]+(\[\d+\])?)*$/,
        'assertion path must be dot-separated segments like "status" or "lines[0].item"',
      ),
    operator: z.enum(['==', '!=']).default('=='),
    /** Compared as a string; may not contain a single quote (the flow
     *  `when` grammar has no escape syntax). */
    value: z
      .string()
      .max(500)
      .refine((v) => !v.includes("'"), {
        message: "assertion value may not contain a single quote (')",
      }),
  })
  .strict();

export type VerifyAssertion = z.infer<typeof verifyAssertionSchema>;

const verifyStepSchema = z
  .object({
    id: automationStepIdSchema,
    kind: z.literal('verify'),
    /** Catalog action id to re-fetch with. */
    actionId: z.string().min(1).max(120),
    connectionId: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).default({}),
    assertions: z.array(verifyAssertionSchema).min(1).max(20),
  })
  .strict();

export type VerifyAutomationStep = z.infer<typeof verifyStepSchema>;

const logStepSchema = z
  .object({
    id: automationStepIdSchema,
    kind: z.literal('log'),
    /** Message template ({{inputs.x}} / {{steps.y.output...}} resolved at run time). */
    message: z.string().min(1).max(2000),
  })
  .strict();

export type LogAutomationStep = z.infer<typeof logStepSchema>;

export const automationStepSchema = z.discriminatedUnion('kind', [
  actionStepSchema,
  conditionStepSchema,
  verifyStepSchema,
  logStepSchema,
]);

export type AutomationStep = z.infer<typeof automationStepSchema>;

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

const cronExpressionSchema = z
  .string()
  .min(1)
  .max(120)
  .refine(isValidCronExpression, {
    message: 'invalid cron expression (expected 5 fields: minute hour dom month dow)',
  });

const timezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine(isValidTimezone, { message: 'invalid IANA timezone name' });

const manualTriggerSchema = z.object({ kind: z.literal('manual') }).strict();

const scheduledTriggerSchema = z
  .object({
    kind: z.literal('scheduled'),
    cron: cronExpressionSchema,
    timezone: timezoneSchema,
    /** Inputs passed to every fired flow run. */
    inputs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const webhookTriggerSchema = z.object({ kind: z.literal('webhook') }).strict();

const eventTriggerSchema = z
  .object({
    kind: z.literal('event'),
    /** Catalog action id whose output is watched for changes. */
    actionId: z.string().min(1).max(120),
    connectionId: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()).default({}),
    /** Dotted path into the action output to watch; empty watches the whole output. */
    watchPath: z
      .string()
      .max(200)
      .regex(
        /^([A-Za-z0-9_-]+(\[\d+\])?(\.[A-Za-z0-9_-]+(\[\d+\])?)*)?$/,
        'watchPath must be dot-separated segments like "status" or "lines[0].item"',
      )
      .default(''),
    /** Poll timetable for the generated watcher flow. */
    pollCron: cronExpressionSchema,
    timezone: timezoneSchema,
  })
  .strict();

export const automationTriggerSchema = z.discriminatedUnion('kind', [
  manualTriggerSchema,
  scheduledTriggerSchema,
  webhookTriggerSchema,
  eventTriggerSchema,
]);

export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;

// ---------------------------------------------------------------------------
// Automation document
// ---------------------------------------------------------------------------

export const AUTOMATION_STATUSES = ['draft', 'active', 'paused', 'failed'] as const;

export type AutomationStatus = (typeof AUTOMATION_STATUSES)[number];

export const AUTOMATION_NAME_MAX = 80;

/**
 * Structural validation shared by create and update:
 * - step ids are unique;
 * - every condition's then/else targets an existing step id (never itself).
 * Catalog membership and connection existence are checked in compile.ts,
 * where the tenant is known (they need store lookups, not just the shape).
 */
function validateAutomationSteps(steps: AutomationStep[], ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  for (const step of steps) {
    if (seen.has(step.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate step id: ${step.id}`,
        path: ['steps'],
      });
    }
    seen.add(step.id);
  }
  for (const step of steps) {
    if (step.kind !== 'condition') continue;
    for (const target of [step.then, step.else] as const) {
      if (!seen.has(target)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `condition step "${step.id}" references unknown step id "${target}"`,
          path: ['steps'],
        });
      }
      if (target === step.id) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `condition step "${step.id}" must not target itself`,
          path: ['steps'],
        });
      }
    }
  }
}

const automationBase = z.object({
  /** Operator label, unique per tenant (case-insensitive). */
  name: z.string().trim().min(1).max(AUTOMATION_NAME_MAX),
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2000).default(''),
  trigger: automationTriggerSchema,
  steps: z.array(automationStepSchema).min(1).max(100),
  /**
   * Declared flow inputs (type/required/description). Merged over the
   * inputs compile-time scanning finds referenced in step templates;
   * declared entries win on key conflicts.
   */
  inputs: z.record(z.string().regex(/^[a-zA-Z0-9_]{1,64}$/), flowInputSpecSchema).default({}),
});

export const automationSchema = automationBase
  .strict()
  .superRefine((doc, ctx) => validateAutomationSteps(doc.steps, ctx));

export type AutomationInput = z.infer<typeof automationSchema>;

/** Deployment record: what deploy() published and wired. */
export interface AutomationDeployment {
  status: 'never' | 'deployed' | 'undeployed';
  /** Deterministic flow name: `studio-<automationId>`. */
  flowName: string;
  /** The published flow version this deployment points at. */
  flowVersion?: number;
  /** sha256 of the canonical compiled definition (change detection). */
  definitionHash?: string;
  triggerKind?: AutomationTrigger['kind'];
  /** Schedules API schedule backing a scheduled/event trigger. */
  scheduleId?: string;
  scheduleName?: string;
  /** confirmWrites carried by the trigger (true only when the deployer
   *  explicitly confirmed destructive steps). */
  confirmWrites?: boolean;
  /** sha256 of the webhook token (the raw token is never stored). */
  webhookTokenHash?: string;
  webhookTokenIssuedAt?: string;
  deployedAt?: Date;
  deployedBy?: string;
  undeployedAt?: Date;
}

/** Mongo document shape for the `studio_automations` collection (tenant-scoped). */
export interface StudioAutomationDoc {
  _id: string;
  tenantId: string;
  name: string;
  title: string;
  description: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  inputs: Record<string, FlowInputSpec>;
  deployment: AutomationDeployment;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** One destructive step, for the deploy approval gate. */
export interface DestructiveStepInfo {
  stepId: string;
  actionId: string;
  title: string;
}

/** The wire shape: everything except secret material (the webhook token
 *  hash is never exposed; the raw token is returned exactly once, in the
 *  deploy response that issues it). */
export interface AutomationPublicView {
  id: string;
  name: string;
  title: string;
  description: string;
  status: AutomationStatus;
  trigger: AutomationTrigger;
  steps: AutomationStep[];
  inputs: Record<string, FlowInputSpec>;
  destructiveSteps: DestructiveStepInfo[];
  deployment: {
    status: AutomationDeployment['status'];
    flowName: string;
    flowVersion?: number;
    triggerKind?: AutomationTrigger['kind'];
    scheduleId?: string;
    scheduleName?: string;
    confirmWrites?: boolean;
    webhookConfigured: boolean;
    webhookTokenIssuedAt?: string;
    deployedAt?: string;
    deployedBy?: string;
    undeployedAt?: string;
  };
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Route input schemas
// ---------------------------------------------------------------------------

export const createAutomationInput = automationSchema;

export const updateAutomationInput = automationBase
  .partial()
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.steps) validateAutomationSteps(doc.steps, ctx);
  });

export const automationIdParam = z.object({ id: z.string().min(1).max(120) });

export const deployAutomationInput = z
  .object({
    /** Required when any step uses a destructive action. The explicit
     *  human approval for this deployment's destructive steps. */
    confirmDestructive: z.boolean().optional(),
  })
  .strict();

export const runAutomationInput = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    /** Scoped human approval for this run's destructive steps. Default
     *  false: without it, destructive steps block per the tool's own
     *  confirmation policy. */
    confirmWrites: z.boolean().default(false),
  })
  .strict();

export const testAutomationInput = z
  .object({
    /** Inputs for the dry run (validated against the compiled inputs). */
    inputs: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

export const listAutomationsInput = z
  .object({
    status: z.enum(AUTOMATION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const listStudioRunsInput = z
  .object({
    automationId: z.string().min(1).max(120).optional(),
    status: z
      .enum(['queued', 'running', 'completed', 'blocked', 'cancelled'])
      .optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateAutomationInput = z.infer<typeof createAutomationInput>;
export type UpdateAutomationInput = z.infer<typeof updateAutomationInput>;
