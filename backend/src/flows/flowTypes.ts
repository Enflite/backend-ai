/**
 * flowTypes.ts — Flows platform data model (ADR-022).
 *
 * A flow is a deterministic, versioned pipeline: an ordered list of steps
 * with no per-step LLM reasoning. The runner (flowRunner.ts) executes the
 * published version's definition exactly: tool calls, subflows, bounded
 * agent calls with schema-validated JSON output, and condition jumps.
 *
 * Flow names live in the tool-name character class (lowercase letters,
 * digits, hyphens) so a future flow→tool conversion needs no renaming.
 *
 * Hooks intentionally left open (not built here): schedule triggers,
 * batch-over-record-set, client-token scoping, flow→tool conversion.
 */

import { z } from 'zod';

/** Flow names: lowercase, digits, hyphens — a subset of the tool-name class. */
export const flowNameSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, 'flow name must match ^[a-z0-9-]{1,64}$');

export type FlowName = z.infer<typeof flowNameSchema>;

/** Step ids: letters, digits, underscore, hyphen. */
export const flowStepIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9_-]{1,64}$/, 'step id must match ^[a-zA-Z0-9_-]{1,64}$');

export type FlowStepId = z.infer<typeof flowStepIdSchema>;

/** Registered tool names referenced by tool steps (e.g. `syteline.task.create`). */
export const flowToolNameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9.:_-]{0,99}$/,
    'tool name must match ^[a-z0-9][a-z0-9.:_-]{0,99}$',
  );

export const FLOW_INPUT_TYPES = ['string', 'number', 'boolean', 'string[]'] as const;

export type FlowInputType = (typeof FLOW_INPUT_TYPES)[number];

export const flowInputSpecSchema = z
  .object({
    type: z.enum(FLOW_INPUT_TYPES),
    required: z.boolean().default(false),
    description: z.string().max(500).optional(),
  })
  .strict();

export type FlowInputSpec = z.infer<typeof flowInputSpecSchema>;

export const flowOutputSpecSchema = z
  .object({
    type: z.enum(FLOW_INPUT_TYPES),
    description: z.string().max(500).optional(),
  })
  .strict();

export type FlowOutputSpec = z.infer<typeof flowOutputSpecSchema>;

const inputKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9_]{1,64}$/, 'input/output key must match ^[a-zA-Z0-9_]{1,64}$');

/** Retry/backoff knobs shared by tool, subflow, and agent steps. */
const retryableStepBase = {
  retries: z.number().int().min(0).max(5).default(0),
  continueOnError: z.boolean().default(false),
};

const toolFlowStepSchema = z
  .object({
    id: flowStepIdSchema,
    kind: z.literal('tool'),
    tool: flowToolNameSchema,
    params: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().positive().max(600000).optional(),
    ...retryableStepBase,
  })
  .strict();

export type ToolFlowStep = z.infer<typeof toolFlowStepSchema>;

const subflowStepSchema = z
  .object({
    id: flowStepIdSchema,
    kind: z.literal('subflow'),
    flow: flowNameSchema,
    version: z.number().int().positive().optional(),
    alias: z.enum(['live']).default('live'),
    inputs: z.record(z.string(), z.unknown()).default({}),
    timeoutMs: z.number().int().positive().max(600000).optional(),
    ...retryableStepBase,
  })
  .strict();

export type SubflowStep = z.infer<typeof subflowStepSchema>;

const agentStepSchema = z
  .object({
    id: flowStepIdSchema,
    kind: z.literal('agent'),
    prompt: z.string().min(1).max(8000),
    /**
     * JSON Schema (draft-07 subset — see validateJsonSchemaOutput in
     * flowRunner.ts for the supported keywords) validated against the
     * model's parsed JSON output at runtime.
     */
    outputSchema: z.unknown(),
    maxTokens: z.number().int().positive().max(16000).default(2000),
    timeoutMs: z.number().int().positive().max(600000).optional(),
    ...retryableStepBase,
  })
  .strict();

export type AgentFlowStep = z.infer<typeof agentStepSchema>;

const conditionStepSchema = z
  .object({
    id: flowStepIdSchema,
    kind: z.literal('condition'),
    when: z.string().min(1).max(2000),
    then: flowStepIdSchema,
    else: flowStepIdSchema,
  })
  .strict();

export type ConditionFlowStep = z.infer<typeof conditionStepSchema>;

export const flowStepSchema = z.discriminatedUnion('kind', [
  toolFlowStepSchema,
  subflowStepSchema,
  agentStepSchema,
  conditionStepSchema,
]);

export type FlowStep = z.infer<typeof flowStepSchema>;

export const MAX_FLOW_STEPS = 200;

/**
 * Structural validation shared by draft create/update and publish:
 * - step ids are unique;
 * - every condition's then/else targets an existing step id;
 * - no condition targets itself (a self-jump can never terminate).
 */
function validateStepGraph(
  steps: FlowStep[],
  ctx: z.RefinementCtx,
): void {
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

const flowDefinitionBase = z.object({
  name: flowNameSchema,
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  inputs: z.record(inputKeySchema, flowInputSpecSchema).default({}),
  outputs: z.record(inputKeySchema, flowOutputSpecSchema).default({}),
  steps: z.array(flowStepSchema).min(1).max(MAX_FLOW_STEPS),
  onError: z.enum(['stop']).default('stop'),
});

export const flowDefinitionSchema = flowDefinitionBase
  .strict()
  .superRefine((definition, ctx) => validateStepGraph(definition.steps, ctx));

export type FlowDefinition = z.infer<typeof flowDefinitionSchema>;

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

export const FLOW_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'blocked',
  'cancelled',
] as const;

export type FlowRunStatus = (typeof FLOW_RUN_STATUSES)[number];

export const TERMINAL_FLOW_RUN_STATUSES: readonly FlowRunStatus[] = [
  'completed',
  'blocked',
  'cancelled',
];

export const FLOW_STEP_STATUSES = [
  'pending',
  'running',
  'ok',
  'failed',
  'skipped',
] as const;

export type FlowStepStatus = (typeof FLOW_STEP_STATUSES)[number];

/**
 * Per-step execution log persisted on the run document. `outputShape` is a
 * compact type descriptor (e.g. `object{keys:[a,b]}`, `string[42]`) —
 * never the value itself: template values may carry secrets, and secrets
 * must not persist in step logs (ADR-004). The real values live only in
 * the runner's memory for the duration of the run.
 */
export interface FlowRunStepLog {
  stepId: string;
  kind: FlowStep['kind'];
  status: FlowStepStatus;
  startedAt?: Date;
  completedAt?: Date;
  /** Output shape descriptor, never the value (see above). */
  outputShape?: string;
  errorCode?: string;
}

/**
 * Snapshot of the requester's auth context, taken at run creation —
 * identifiers only, never secrets. The runner re-resolves the requester's
 * LIVE auth at run start (same permission resolution as login) and fails
 * closed when the live context is gone or no longer holds `flows:run` —
 * a demotion after run creation must not keep driving the run.
 */
export interface FlowAuthSnapshot {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
  clearance: string;
  roleId: string;
  roleName: string;
  permissions: string[];
  classification: string;
}

/** Mongo document shape for the `flows` collection (tenant-scoped). */
export interface FlowVersionEntry {
  version: number;
  /** The frozen, validated definition this version executes. */
  definition: FlowDefinition;
  /** sha256 of the canonical definition JSON (change detection). */
  definitionHash: string;
  publishedBy: string;
  publishedAt: Date;
}

export interface FlowDoc {
  _id: string;
  tenantId: string;
  name: string;
  /** Mutable working copy; validated on every write. */
  draft: FlowDefinition;
  draftUpdatedAt: Date;
  draftUpdatedBy: string;
  /** Bumped on every draft write and every publish; If-Match guard for setLiveAlias. */
  revision: number;
  liveVersion: number | null;
  versions: FlowVersionEntry[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Mongo document shape for the `flow_runs` collection (tenant-scoped). */
export interface FlowRunDoc {
  _id: string;
  tenantId: string;
  flowName: string;
  /** Resolved version number (live alias or explicit) at run creation. */
  flowVersion: number;
  status: FlowRunStatus;
  inputs: Record<string, unknown>;
  steps: FlowRunStepLog[];
  resultSummary?: string;
  blockedReason?: string;
  idempotencyKey?: string;
  /**
   * Scoped human confirmation for this run's writes: `true` on run
   * creation IS the explicit confirmation for that run's tool steps —
   * bounded to this run and audited. Default false: runToolCall still
   * enforces each tool's own confirmation policy.
   */
  confirmWrites: boolean;
  requestedBy: FlowAuthSnapshot;
  runnerId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

// ---------------------------------------------------------------------------
// Route input schemas
// ---------------------------------------------------------------------------

export const createFlowInput = flowDefinitionSchema;

export const updateFlowDraftInput = flowDefinitionBase.omit({ name: true }).strict();

export const publishFlowInput = z.object({}).strict();

export const setLiveAliasInput = z
  .object({
    version: z.number().int().positive(),
    /** If-Match revision guard: mismatch → 412 REVISION_MISMATCH. */
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();

export const createFlowRunInput = z
  .object({
    inputs: z.record(z.string(), z.unknown()).default({}),
    confirmWrites: z.boolean().default(false),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const listFlowRunsInput = z
  .object({
    flowName: flowNameSchema.optional(),
    status: z.enum(FLOW_RUN_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateFlowRunInput = z.infer<typeof createFlowRunInput>;
