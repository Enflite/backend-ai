/**
 * scheduleTypes.ts — Schedules platform data model (ADR-023).
 *
 * A schedule runs a flow on a timetable. It is the daily-SOP engine:
 * "buyer routine weekdays at 7am", "TRN/PRD drift check nightly".
 *
 * Design points (mirroring the Flows platform, ADR-022):
 * - Config-as-code: schedules are plain data, validated on every write.
 * - Names live in the flow-name character class (lowercase, digits, hyphens).
 * - The scheduler claims due schedules atomically (nextRunAt advance in a
 *   single findOneAndUpdate), so concurrent backends never double-fire.
 * - Each firing creates a flow run via the flows platform: scheduled runs
 *   land in `flow_runs` with a `scheduleRef`, so the kanban board's
 *   "what did the AI do today" view covers scheduled runs automatically.
 * - Approval gating: `confirmWrites` on the schedule IS the scoped human
 *   confirmation for every run it fires (same semantics as an interactive
 *   flow run's confirmWrites). Default false: destructive tool steps in a
 *   scheduled run hit the tool's own confirmation policy and block —
 *   scheduled runs are read-only/recon unless explicitly approved.
 * - The run executes as `runAsUserId` (the schedule owner's auth is
 *   re-resolved live at fire time; a demoted/deactivated owner fails
 *   closed and the tick is skipped with an audit event).
 *
 * HOOK (designed, not built): event triggers. The planned shape is
 *   trigger: { kind: 'event', event: 'po.created' | 'form.changed' | ... }
 * The schema below accepts cron only; the union is the extension point.
 */

import { z } from 'zod';
import { flowNameSchema, FLOW_RUN_STATUSES } from '../flows/flowTypes.js';
import {
  isValidCronExpression,
  isValidTimezone,
  parseCronExpression,
  nextCronRun,
  CronNoOccurrenceError,
} from './cron.js';

/** Schedule names: same character class as flow names. */
export const scheduleNameSchema = z
  .string()
  .regex(/^[a-z0-9-]{1,64}$/, 'schedule name must match ^[a-z0-9-]{1,64}$');

export type ScheduleName = z.infer<typeof scheduleNameSchema>;

/** What a schedule fires: a published flow (live alias or pinned version). */
export const scheduleTargetSchema = z
  .object({
    kind: z.literal('flow'),
    flowName: flowNameSchema,
    /** Pinned version; when omitted the live alias is resolved at fire time. */
    version: z.number().int().positive().optional(),
    alias: z.enum(['live']).default('live'),
  })
  .strict();

export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

const cronTriggerSchema = z
  .object({
    kind: z.literal('cron'),
    /** 5-field cron: `minute hour day-of-month month day-of-week`. */
    expression: z
      .string()
      .min(1)
      .max(120)
      .refine(isValidCronExpression, {
        message: 'invalid cron expression (expected 5 fields: minute hour dom month dow)',
      }),
    /** IANA timezone the expression is evaluated in. */
    timezone: z
      .string()
      .min(1)
      .max(64)
      .refine(isValidTimezone, { message: 'invalid IANA timezone name' }),
  })
  .strict();

/**
 * Trigger union. Cron is the only built variant; `event` is the designed
 * hook (see module docstring) — add the variant here when it is built.
 */
export const scheduleTriggerSchema = z.discriminatedUnion('kind', [cronTriggerSchema]);

export type ScheduleTrigger = z.infer<typeof scheduleTriggerSchema>;

/** Compute the next fire time strictly after `from` for a trigger. */
export function nextFireTime(trigger: ScheduleTrigger, from: Date): Date {
  switch (trigger.kind) {
    case 'cron':
      return nextCronRun(parseCronExpression(trigger.expression), from, trigger.timezone);
    default:
      throw new Error(`unsupported trigger kind: ${(trigger as { kind: string }).kind}`);
  }
}

export { CronNoOccurrenceError };

/** Outcome recorded on the schedule when a tick fires (or fails to). */
export const SCHEDULE_TICK_STATUSES = [
  'triggered',
  'skipped-auth',
  'skipped-flow-missing',
  'create-failed',
] as const;

export type ScheduleTickStatus = (typeof SCHEDULE_TICK_STATUSES)[number];

/** Mongo document shape for the `schedules` collection (tenant-scoped). */
export interface ScheduleDoc {
  _id: string;
  tenantId: string;
  name: string;
  title: string;
  description: string;
  target: ScheduleTarget;
  trigger: ScheduleTrigger;
  /** Inputs passed to every fired flow run (may be overridden per run-now). */
  inputs: Record<string, unknown>;
  /**
   * Scoped human confirmation for writes in runs fired by this schedule.
   * Default false: scheduled runs are read-only/recon unless the schedule
   * owner explicitly approves writes here.
   */
  confirmWrites: boolean;
  enabled: boolean;
  /** The user whose live auth the fired runs execute as. */
  runAsUserId: string;
  /** Next scheduled fire time; null while disabled. Recomputed on every write. */
  nextRunAt: Date | null;
  lastRunAt?: Date;
  lastRunId?: string;
  lastTickStatus?: ScheduleTickStatus;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Per-status counts over a schedule's fired runs (derived from flow_runs). */
export interface ScheduleStats {
  scheduleId: string;
  scheduleName: string;
  nextRunAt: Date | null;
  enabled: boolean;
  lastRunAt?: Date;
  lastRunId?: string;
  lastTickStatus?: ScheduleTickStatus;
  /** All-time counts by flow-run status. */
  byStatus: Partial<Record<(typeof FLOW_RUN_STATUSES)[number], number>>;
  /** Counts over the trailing 30 days, by flow-run status. */
  last30Days: Partial<Record<(typeof FLOW_RUN_STATUSES)[number], number>>;
  totalRuns: number;
}

// ---------------------------------------------------------------------------
// Route input schemas
// ---------------------------------------------------------------------------

const scheduleBase = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(2000).optional().default(''),
  target: scheduleTargetSchema,
  trigger: scheduleTriggerSchema,
  inputs: z.record(z.string(), z.unknown()).default({}),
  confirmWrites: z.boolean().default(false),
  enabled: z.boolean().default(true),
  runAsUserId: z.string().min(1).max(128),
});

export const createScheduleInput = scheduleBase
  .extend({ name: scheduleNameSchema })
  .strict();

export const updateScheduleInput = scheduleBase.partial().strict();

export const listSchedulesInput = z
  .object({
    enabled: z.coerce.boolean().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const runNowInput = z
  .object({
    /** Override the schedule's inputs for this one-off run. */
    inputs: z.record(z.string(), z.unknown()).optional(),
    /** Override the schedule's confirmWrites for this one-off run. */
    confirmWrites: z.boolean().optional(),
    idempotencyKey: z.string().min(1).max(128).optional(),
  })
  .strict();

export const listScheduleRunsInput = z
  .object({
    status: z.enum(FLOW_RUN_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export type CreateScheduleInput = z.infer<typeof createScheduleInput>;
export type UpdateScheduleInput = z.infer<typeof updateScheduleInput>;
export type RunNowInput = z.infer<typeof runNowInput>;
