/**
 * tools.ts — the Studio's flow-step tools.
 *
 * Compiled automations (automations/compile.ts) execute through these
 * tools; they are the catalog's tool binding:
 *
 * - `studio.executeAction`      — run a NON-DESTRUCTIVE catalog action
 *                                 against a named connection (real upstream,
 *                                 probe-gated, never faked).
 * - `studio.executeWriteAction` — run a DESTRUCTIVE catalog action. Marked
 *                                 `destructive: true` so the tool gateway
 *                                 requires scoped confirmation
 *                                 (CONFIRMATION_REQUIRED without it).
 * - `studio.log`                — write a message to the automation audit log.
 * - `studio.fail`               — always fails; compiled verify assertions
 *                                 route here to block the run with a clear
 *                                 reason.
 * - `studio.snapshotCheck`      — poll-based event trigger change detection:
 *                                 compares a value against the stored
 *                                 snapshot in `studio_snapshots`.
 *
 * Security notes (same posture as the rest of the Studio):
 * - Tenant comes from ctx.auth.tenantId — never from parameters.
 * - Permission 'studio:run' on every tool, enforced in application code.
 * - No secrets in logs. Errors via Errors.* with client-safe messages.
 * - The bearer token is decrypted for the single request and zero-filled
 *   after (in the shared execution core).
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import { canonicalize } from '../../flows/flowStore.js';
import type { ToolDefinition } from '../../tools/gateway.js';
import type { Classification } from '../../authz/permissions.js';
import { getCatalogAction } from '../catalog/catalog.js';
import {
  executeCatalogAction,
  resolveProbeOperations,
  type CatalogActionHttpResult,
} from '../execution/executeAction.js';
import { getSnapshot, putSnapshot, SNAPSHOT_VALUE_CAP } from './store.js';

export const STUDIO_EXECUTE_ACTION_TOOL = 'studio.executeAction';
export const STUDIO_EXECUTE_WRITE_ACTION_TOOL = 'studio.executeWriteAction';
export const STUDIO_LOG_TOOL = 'studio.log';
export const STUDIO_FAIL_TOOL = 'studio.fail';
export const STUDIO_SNAPSHOT_CHECK_TOOL = 'studio.snapshotCheck';

const STUDIO_TOOL_CLASSIFICATIONS: Classification[] = [
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'PROPRIETARY',
];

const executeActionSchema = z
  .object({
    connectionId: z.string().min(1).max(120),
    actionId: z.string().min(1).max(120),
    params: z.record(z.string(), z.unknown()),
  })
  .strict();

type ExecuteActionInput = z.infer<typeof executeActionSchema>;

/**
 * The step output for action executions: the upstream HTTP status plus the
 * parsed response body (or the raw text when it is not JSON). A non-2xx
 * upstream status is DATA, not a tool failure — the request executed; the
 * automation can branch on `{{steps.<id>.output.status}}` or assert on it
 * with a verify step. Only transport failures throw (step fails, run blocks).
 */
export function toStepOutput(result: CatalogActionHttpResult): {
  status: number;
  data: unknown;
  durationMs: number;
} {
  let data: unknown = result.bodyText;
  const trimmed = result.bodyText.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      data = JSON.parse(trimmed);
    } catch {
      data = result.bodyText;
    }
  }
  return { status: result.status, data, durationMs: result.durationMs };
}

async function runCatalogAction(
  input: ExecuteActionInput,
  ctx: { auth: { tenantId: string } },
  signal: AbortSignal,
  opts: { destructive: boolean },
): Promise<{ status: number; data: unknown; durationMs: number }> {
  const entry = getCatalogAction(input.actionId);
  if (!entry) {
    throw Errors.notFound('STUDIO_ACTION_NOT_FOUND', `Unknown action '${input.actionId}'`);
  }
  if (opts.destructive && !entry.destructive) {
    throw Errors.conflict(
      'STUDIO_WRITE_ACTION_MISMATCH',
      `Action '${input.actionId}' is not destructive: use ${STUDIO_EXECUTE_ACTION_TOOL}`,
    );
  }
  if (!opts.destructive && entry.destructive) {
    // Defense in depth: the read tool never runs a destructive action even
    // if a hand-written flow definition tries it. The write tool (with its
    // confirmation gate) is the only path.
    throw Errors.conflict(
      'STUDIO_WRITE_ACTION_MISMATCH',
      `Action '${input.actionId}' is destructive: use ${STUDIO_EXECUTE_WRITE_ACTION_TOOL}`,
    );
  }
  const probeOperations = await resolveProbeOperations(ctx.auth.tenantId, input.connectionId);
  const result = await executeCatalogAction(
    ctx.auth.tenantId,
    input.connectionId,
    input.actionId,
    input.params,
    probeOperations,
    { signal },
  );
  return toStepOutput(result);
}

const logSchema = z
  .object({
    message: z.string().min(1).max(2000),
    automationId: z.string().min(1).max(120),
    stepId: z.string().min(1).max(120),
  })
  .strict();

const failSchema = z
  .object({
    message: z.string().min(1).max(500),
    automationId: z.string().min(1).max(120),
    stepId: z.string().min(1).max(120),
  })
  .strict();

const snapshotCheckSchema = z
  .object({
    snapshotKey: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9:._-]+$/, 'snapshotKey must match ^[a-zA-Z0-9:._-]+$'),
    /** The watched value (usually a {{steps.fetch.output...}} template,
     *  resolved to its raw value by the flow runner before this runs). */
    value: z.unknown(),
  })
  .strict();

export const studioAutomationToolDefinitions: ToolDefinition[] = [
  {
    name: STUDIO_EXECUTE_ACTION_TOOL,
    description:
      'Execute a non-destructive Studio catalog action (e.g. syteline.getItem) ' +
      'against a named SyteLine connection and return the upstream response. ' +
      'The action runs for real against the connection upstream, gated on the ' +
      'connection capability probe. Refuses destructive actions.',
    action: 'read',
    destructive: false,
    permission: 'studio:run',
    allowedClassifications: STUDIO_TOOL_CLASSIFICATIONS,
    schema: executeActionSchema,
    execute: (input, ctx, signal) =>
      runCatalogAction(input as ExecuteActionInput, ctx, signal, { destructive: false }),
  },
  {
    name: STUDIO_EXECUTE_WRITE_ACTION_TOOL,
    description:
      'Execute a DESTRUCTIVE Studio catalog action (e.g. syteline.record.update) ' +
      'against a named SyteLine connection. Requires scoped confirmation: ' +
      'without it the call is refused and the run blocks. Refuses ' +
      'non-destructive actions (use studio.executeAction for those).',
    action: 'write',
    destructive: true,
    permission: 'studio:run',
    allowedClassifications: STUDIO_TOOL_CLASSIFICATIONS,
    schema: executeActionSchema,
    execute: (input, ctx, signal) =>
      runCatalogAction(input as ExecuteActionInput, ctx, signal, { destructive: true }),
  },
  {
    name: STUDIO_LOG_TOOL,
    description:
      'Write a message to the Studio automation audit log (compiled log ' +
      'steps and watcher bookkeeping). Audited as STUDIO_AUTOMATION_LOG.',
    action: 'log',
    destructive: false,
    permission: 'studio:run',
    allowedClassifications: STUDIO_TOOL_CLASSIFICATIONS,
    schema: logSchema,
    execute: async (input, ctx) => {
      const parsed = input as z.infer<typeof logSchema>;
      await recordAudit({
        tenantId: ctx.auth.tenantId,
        userId: ctx.auth.userId,
        requestId: ctx.requestId,
        action: 'STUDIO_AUTOMATION_LOG',
        success: true,
        metadata: {
          automationId: parsed.automationId,
          stepId: parsed.stepId,
          message: parsed.message,
        },
      });
      return { logged: true };
    },
  },
  {
    name: STUDIO_FAIL_TOOL,
    description:
      'Always fails with the given message. Compiled automations route ' +
      'failed verify assertions here so the run blocks with a clear reason. ' +
      'Not for general use.',
    action: 'fail',
    destructive: false,
    permission: 'studio:run',
    allowedClassifications: STUDIO_TOOL_CLASSIFICATIONS,
    schema: failSchema,
    execute: async (input) => {
      const parsed = input as z.infer<typeof failSchema>;
      throw Errors.conflict('STUDIO_VERIFY_FAILED', parsed.message);
    },
  },
  {
    name: STUDIO_SNAPSHOT_CHECK_TOOL,
    description:
      'Poll-based change detection for Studio event triggers: compares the ' +
      'given value against the stored snapshot and stores the new value. ' +
      'Returns { changed, firstRun }. The first observation stores the ' +
      'baseline and reports changed=false (no spurious fire).',
    action: 'check',
    destructive: false,
    permission: 'studio:run',
    allowedClassifications: STUDIO_TOOL_CLASSIFICATIONS,
    schema: snapshotCheckSchema,
    execute: async (input, ctx) => {
      const parsed = input as z.infer<typeof snapshotCheckSchema>;
      const canonical = canonicalize(parsed.value);
      const valueHash = createHash('sha256').update(canonical).digest('hex');
      const previous = await getSnapshot(ctx.auth.tenantId, parsed.snapshotKey);
      const changed = previous !== null && previous.valueHash !== valueHash;
      await putSnapshot(
        ctx.auth.tenantId,
        parsed.snapshotKey,
        valueHash,
        canonical.slice(0, SNAPSHOT_VALUE_CAP),
      );
      return { changed, firstRun: previous === null };
    },
  },
];
