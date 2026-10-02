/**
 * generate.ts — natural language → automation draft (Wave 3: AI generation).
 *
 * POST /api/v1/studio/automations/generate takes a plain-language prompt
 * and returns a NEW automation in `draft` status — never deployed, no
 * trigger wired. The model sees the REAL action catalog (ids, params,
 * which are destructive, and per-connection support) and must emit a
 * draft matching the automation definition schema; anything else fails
 * closed with 502 and nothing is created.
 *
 * Jake's product rule is structural here, not a prompt plea: the draft is
 * created with `status: 'draft'` and `deployment.status: 'never'`; the
 * ONLY path to a live automation is the existing explicit deploy flow
 * (with its destructive-confirm gate). A destructive draft still deploys
 * only via `POST /:id/deploy` with `confirmDestructive: true`.
 *
 * Follows the kanban "generate tasks" precedent (PR #81): gateway call
 * with a test seam, zod-validated JSON output, fail-closed 502 on
 * malformed output, rate limiting at the route, audit.
 */

import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { AuthContext } from '../../authz/permissions.js';
import { AppError, Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import { resolveChatDefault } from '../../ai/gateway/capabilityRouter.js';
import { gatewayStream } from '../../ai/gateway/gateway.js';
import { ACTION_CATALOG, evaluateAvailability, getCatalogAction } from '../catalog/catalog.js';
import { getConnection } from '../connections/store.js';
import {
  automationSchema,
  type AutomationPublicView,
  type AutomationStep,
} from '../automations/types.js';
import { createAutomation, toAutomationView } from '../automations/store.js';

export const generateAutomationInput = z
  .object({
    /** Plain-language description of the automation to draft. */
    prompt: z.string().min(1).max(2000),
    /** Connection the draft's steps target; 'default' when omitted. */
    connectionId: z.string().min(1).max(120).optional(),
  })
  .strict();

export type GenerateAutomationInput = z.infer<typeof generateAutomationInput>;

/** Returns the model's raw draft text for a prompt. */
export type StudioGenerateFn = (
  prompt: string,
  catalogContext: string,
  auth: AuthContext,
  signal: AbortSignal,
) => Promise<string>;

let generateFnOverride: StudioGenerateFn | null = null;

/** Test-only seam: substitute draft generation (mirrors overrideTaskGenerateFn). */
export function overrideStudioGenerateFn(fn: StudioGenerateFn | null): void {
  generateFnOverride = fn;
}

/** One catalog entry rendered as model context. */
function catalogLine(
  entry: (typeof ACTION_CATALOG)[number],
  operations: Parameters<typeof evaluateAvailability>[1],
): string {
  const { supported, supportReason } = evaluateAvailability(entry, operations);
  const params = entry.paramsSchema;
  const paramsSummary =
    params instanceof z.ZodObject
      ? Object.entries(params.shape)
          .map(([k, f]) => {
            const field = f as z.ZodTypeAny;
            const optional = field instanceof z.ZodOptional || field instanceof z.ZodDefault;
            return `${k}${optional ? '?' : ''}`;
          })
          .join(', ')
      : 'object';
  return [
    `- ${entry.id} | ${entry.title} | ${entry.description}`,
    `  params: {${paramsSummary}} | destructive: ${entry.destructive ? 'YES' : 'no'}`,
    `  supported: ${supported ? 'yes' : 'no'} (${supportReason})`,
  ].join('\n');
}

const STUDIO_GENERATOR_SYSTEM_PROMPT = [
  'You are a SyteLine automation designer. Turn the user\'s request into a JSON',
  'automation DRAFT using ONLY the action ids listed below.',
  '',
  'Output ONLY one JSON object. No prose, no markdown fences, no commentary.',
  '{',
  '  "name": "kebab-case-unique-name (<=80 chars)",',
  '  "title": "Human-readable title",',
  '  "description": "1-2 sentences: what this automation does",',
  '  "trigger": {"kind": "manual"}  // or {"kind":"scheduled","cron":"<5-field cron>","timezone":"<IANA>","inputs":{}}',
  '                // or {"kind":"webhook"} // or {"kind":"event","actionId":"<id>","connectionId":"<id>","params":{},"watchPath":"","pollCron":"<5-field cron>","timezone":"<IANA>"}',
  '  "steps": [ ... ]',
  '}',
  '',
  'Step shapes (step "id" must match ^[a-zA-Z0-9_-]{1,64}$, unique):',
  '- {"id":"s1","kind":"action","actionId":"<catalog id>","connectionId":"<connection>","params":{...}}',
  '- {"id":"s2","kind":"condition","when":"{{steps.s1.output.data.status}} == \'open\'","then":"s3","else":"s4"}',
  '    (the "when" grammar: templates resolved strictly, then an optional ==/!= comparison',
  '     against a single-quoted literal, else truthiness; "then"/"else" must name other step ids)',
  '- {"id":"s3","kind":"verify","actionId":"<catalog id>","connectionId":"<connection>","params":{...},',
  '   "assertions":[{"path":"status","operator":"==","value":"open"}]}',
  '    (path: dot-separated body segments like "status" or "lines[0].item"; value: no single quotes)',
  '- {"id":"s4","kind":"log","message":"Checked {{steps.s1.output.data.status}}"}',
  '',
  'Rules:',
  '- Use ONLY the action ids listed below. Never invent an action, a param, or a SyteLine procedure.',
  '- Prefer NON-destructive actions. Include a destructive action ONLY when the user explicitly',
  '  asks for a create/update/delete/write — the draft stays a draft regardless.',
  '- Params must match the listed param shape; use {{inputs.x}} for values the operator supplies at run time.',
  '- Default trigger is {"kind":"manual"} unless the user clearly asks for a schedule, webhook, or event watch.',
  '- "name" must be kebab-case, unique, <=80 chars.',
].join('\n');

/**
 * Default generation: non-streaming call through the authorized AI gateway.
 * Fail-closed: no servable model -> 502; unparseable output -> 502 with no
 * automation created. Never creates a draft from output that fails schema
 * validation.
 */
async function defaultGenerateFn(
  prompt: string,
  catalogContext: string,
  auth: AuthContext,
  signal: AbortSignal,
): Promise<string> {
  const model = await resolveChatDefault(auth.tenantId, auth.userId, auth.roleId);
  if (!model) {
    throw Errors.badGateway('NO_GENERATE_MODEL', 'No servable model available for automation generation');
  }
  const result = await gatewayStream({
    tenantId: auth.tenantId,
    userId: auth.userId,
    roleId: auth.roleId,
    requestId: `studio-automation-generate-${randomBytes(8).toString('hex')}`,
    modelId: model.id,
    classification: auth.clearance,
    messages: [
      {
        role: 'user',
        content: `Request: ${prompt}\n\nDraft this as an automation JSON object.`,
      },
    ],
    systemPrompt: `${STUDIO_GENERATOR_SYSTEM_PROMPT}\n\nAction catalog:\n${catalogContext}`,
    signal,
  });
  let text = '';
  for await (const event of result.events) {
    if (event.type === 'text') text += event.content;
  }
  return text;
}

/** Tolerantly extract the first {...} JSON object from model text. */
export function extractDraftJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Errors.badGateway('STUDIO_GENERATE_SCHEMA_MISMATCH', 'Automation generator did not return a JSON object');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Errors.badGateway('STUDIO_GENERATE_SCHEMA_MISMATCH', 'Automation generator returned malformed JSON');
  }
}

/**
 * Validate the model's draft against the automation definition schema AND
 * the real catalog (every action/verify step must name a known action).
 * Throws 502 on any mismatch — the caller must not create anything.
 */
export function validateGeneratedDraft(raw: unknown): {
  name: string;
  title: string;
  description: string;
  trigger: z.infer<typeof automationSchema>['trigger'];
  steps: AutomationStep[];
} {
  const parsed = automationSchema.safeParse(raw);
  if (!parsed.success) {
    throw Errors.badGateway(
      'STUDIO_GENERATE_SCHEMA_MISMATCH',
      'Automation generator output failed schema validation — no draft created',
      parsed.error.flatten(),
    );
  }
  for (const step of parsed.data.steps) {
    if (step.kind !== 'action' && step.kind !== 'verify') continue;
    if (!getCatalogAction(step.actionId)) {
      throw Errors.badGateway(
        'STUDIO_GENERATE_SCHEMA_MISMATCH',
        `Automation generator used unknown catalog action '${step.actionId}' — no draft created`,
      );
    }
  }
  return parsed.data;
}

function isNameTaken(error: unknown): boolean {
  return error instanceof AppError && error.code === 'STUDIO_AUTOMATION_NAME_TAKEN';
}

/**
 * Generate a draft automation from natural language and persist it as
 * `draft` (never deployed, no trigger wired). Returns the public view.
 *
 * Fail-closed throughout: model/gateway failure, malformed JSON, schema
 * mismatch, or unknown catalog actions all throw 502 with nothing created.
 */
export async function generateAutomationDraft(
  auth: AuthContext,
  input: GenerateAutomationInput,
  signal: AbortSignal,
  requestId: string,
): Promise<AutomationPublicView> {
  const connectionId = input.connectionId ?? 'default';

  // Catalog context: support evaluated against this connection's last
  // probe so the model knows what is real on this upstream. The env-backed
  // 'default' carries no stored probe — the honest "not probed yet" reason
  // is passed through as-is.
  let operations: Parameters<typeof evaluateAvailability>[1];
  if (connectionId !== 'default') {
    const conn = await getConnection(auth.tenantId, connectionId);
    if (!conn) {
      throw Errors.notFound(
        'STUDIO_CONNECTION_NOT_FOUND',
        `Connection '${connectionId}' does not exist in this tenant.`,
      );
    }
    operations = conn.probe?.operations;
  }
  const catalogContext = ACTION_CATALOG.map((entry) => catalogLine(entry, operations)).join('\n');

  const raw = generateFnOverride
    ? await generateFnOverride(input.prompt, catalogContext, auth, signal)
    : await defaultGenerateFn(input.prompt, catalogContext, auth, signal);
  const draft = validateGeneratedDraft(extractDraftJson(raw));

  // Pin every action/verify step to the validated connection: the model
  // must not invent connection ids, and the draft must point at a real one.
  const steps: AutomationStep[] = draft.steps.map((step) =>
    step.kind === 'action' || step.kind === 'verify' ? { ...step, connectionId } : step,
  );

  // Name uniqueness: retry with a short suffix on the (rare) collision.
  let name = draft.name;
  let doc = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      doc = await createAutomation(auth, {
        name,
        title: draft.title,
        description: draft.description,
        trigger: draft.trigger,
        steps,
        inputs: {},
      });
      break;
    } catch (error) {
      if (isNameTaken(error) && attempt < 2) {
        name = `${draft.name.slice(0, 72)}-${randomBytes(3).toString('hex')}`;
        continue;
      }
      throw error;
    }
  }
  if (!doc) throw Errors.internal('Automation draft creation failed');

  const view = toAutomationView(doc);
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    requestId,
    action: 'STUDIO_AUTOMATION_GENERATED',
    success: true,
    // Identifiers and counts only — the prompt may carry operational detail.
    metadata: {
      automationId: doc._id,
      name: doc.name,
      triggerKind: doc.trigger.kind,
      stepCount: doc.steps.length,
      destructiveSteps: view.destructiveSteps.length,
      generated: true,
    },
  });
  return view;
}
