/**
 * agentJudgment.ts — the APS Planning Agent's agent-escalation seam.
 *
 * Reconciliation note (contracts.md): the sibling-owned
 * aps-exception-analysis / aps-exception-verify flows carry their own
 * four schema-validated agent steps (classify, root-cause, recommendation,
 * syteline-steps) — THOSE are the pipeline's system of record. THIS seam
 * is the standalone/chat-context judge: explaining, correlating, and
 * prioritizing APS findings outside a flow run (e.g. "what should I work
 * on first?" over an already-recorded analysis). The two must stay
 * consistent (same knowledge pack, same honesty rules); prompts are not
 * duplicated — the flow owns the pipeline prompts, this module owns the
 * chat-context prompts.
 *
 * PRIVACY HARD RULE: prompts built here carry AGGREGATES ONLY — issue
 * counts, severity rollups, per-issue summaries (id, type, severity,
 * days-late, item). NEVER full report rows to cloud models. Uploaded
 * exports carry supplier/pricing data (proprietary/finance); the gateway's
 * privacy routing decides the serving model, but this seam never widens
 * what the model sees beyond aggregates.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { gatewayStream } from '../ai/gateway/gateway.js';
import { resolveChatDefault } from '../ai/gateway/capabilityRouter.js';
import type { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { APS_PLANNING_KNOWLEDGE } from './knowledge.js';
import { recommendationSchema, rootCauseSchema } from './types.js';

/** The caller's auth context for a judgment call (identifiers only). */
export interface ApsJudgmentActor {
  tenantId: string;
  userId: string;
  roleId: string;
  clearance: Classification;
  displayName?: string;
}

export interface ApsJudgmentRequest {
  /** Registry ref of the prompt builder (for audit). */
  judgmentRef: string;
  systemPrompt: string;
  userMessage: string;
  /** The model's decision must satisfy this schema. */
  schema: z.ZodType<unknown>;
}

export type ApsJudgmentResult =
  | { ok: true; decision: unknown }
  | { ok: false; code: 'invalid-decision' | 'judge-unavailable'; detail: string };

export type ApsJudgmentFn = (
  actor: ApsJudgmentActor,
  request: ApsJudgmentRequest,
  signal: AbortSignal,
) => Promise<ApsJudgmentResult>;

let judgeOverride: ApsJudgmentFn | null = null;

/** Test-only seam: substitute the judge. */
export function overrideApsJudge(fn: ApsJudgmentFn | null): void {
  judgeOverride = fn;
}

/** Tolerantly extract the first {...} JSON object from model text. */
function extractDecisionJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw Errors.badRequest('INVALID_DECISION', 'The judge did not return JSON');
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw Errors.badRequest('INVALID_DECISION', 'The judge returned malformed JSON');
  }
}

/**
 * Default judge: a non-streaming call through the authorized AI gateway.
 * The requester's serving model produces the decision; the zod schema
 * validates it. Any failure is a typed result, never a throw.
 */
async function defaultJudge(
  actor: ApsJudgmentActor,
  request: ApsJudgmentRequest,
  signal: AbortSignal,
): Promise<ApsJudgmentResult> {
  let model: { id: string } | null = null;
  try {
    model = await resolveChatDefault(actor.tenantId, actor.userId, actor.roleId);
  } catch {
    model = null;
  }
  if (!model) {
    return { ok: false, code: 'judge-unavailable', detail: 'No servable model is available for agent judgment.' };
  }
  try {
    const result = await gatewayStream({
      tenantId: actor.tenantId,
      userId: actor.userId,
      roleId: actor.roleId,
      requestId: `aps-judge-${randomUUID()}`,
      modelId: model.id,
      classification: actor.clearance,
      messages: [{ role: 'user', content: request.userMessage }],
      systemPrompt: request.systemPrompt,
      signal,
    });
    let text = '';
    for await (const event of result.events) {
      if (event.type === 'text') text += event.content;
    }
    let decision: unknown;
    try {
      decision = extractDecisionJson(text);
    } catch {
      return { ok: false, code: 'invalid-decision', detail: 'The agent judgment did not return a decision object.' };
    }
    const parsed = request.schema.safeParse(decision);
    if (!parsed.success) {
      return { ok: false, code: 'invalid-decision', detail: 'The agent judgment did not satisfy the decision schema.' };
    }
    return { ok: true, decision: parsed.data };
  } catch (error) {
    return {
      ok: false,
      code: 'judge-unavailable',
      detail: error instanceof Error ? error.message : 'Agent judgment failed.',
    };
  }
}

/** Escalate to the judge (override in tests). */
export async function apsJudge(
  actor: ApsJudgmentActor,
  request: ApsJudgmentRequest,
  signal: AbortSignal,
): Promise<ApsJudgmentResult> {
  return (judgeOverride ?? defaultJudge)(actor, request, signal);
}

// ---------------------------------------------------------------------------
// Judgment builders — aggregates only, never full report rows.
// ---------------------------------------------------------------------------

const BASE_SYSTEM = `${APS_PLANNING_KNOWLEDGE}

JUDGMENT RULES
- You receive AGGREGATES (counts, per-issue summaries), never full report rows. Reason only from what is given.
- Ground every claim in the aggregates; cite issue ids, types, and severities.
- Never invent SyteLine records, procedures, forms, fields, or buttons.
- Return JSON matching the requested schema exactly.`;

/** Aggregate per-issue summary: the most detail a prompt may carry. */
export const issueSummarySchema = z.object({
  id: z.string().max(120),
  type: z.string().max(40),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  item: z.string().max(80).optional(),
  daysLate: z.number().optional(),
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;

const explainDecisionSchema = z.object({
  explanation: z.string().trim().min(1).max(2000),
  keyEvidence: z.array(z.string().trim().min(1).max(300)).max(10),
});

/**
 * `aps-explain`: explain one issue from its aggregate summary +
 * deterministic evidence keys. Returns a short explanation and the key
 * evidence the planner should look at.
 */
export function buildExplainRequest(summary: IssueSummary, evidenceKeys: string[]): ApsJudgmentRequest {
  const parsed = issueSummarySchema.safeParse(summary);
  if (!parsed.success) throw Errors.badRequest('INVALID_SUMMARY', 'Issue summary is invalid');
  return {
    judgmentRef: 'aps-explain',
    systemPrompt: BASE_SYSTEM,
    userMessage:
      `Explain this APS exception to a planner in plain language (2-4 sentences), then list the key evidence to check.\n` +
      `Issue: ${JSON.stringify(parsed.data)}\nEvidence keys: ${JSON.stringify(evidenceKeys.slice(0, 10))}\n` +
      `Return JSON: { "explanation": string, "keyEvidence": string[] }`,
    schema: explainDecisionSchema,
  };
}

const prioritizeDecisionSchema = z.object({
  order: z.array(z.string().trim().min(1).max(120)).min(1).max(200),
  rationale: z.string().trim().min(1).max(2000),
});

/**
 * `aps-prioritize`: order issue summaries by planner priority
 * (customer-commit risk first). Aggregates only.
 */
export function buildPrioritizeRequest(summaries: IssueSummary[]): ApsJudgmentRequest {
  if (summaries.length === 0 || summaries.length > 200) {
    throw Errors.badRequest('INVALID_SUMMARIES', 'Provide 1-200 issue summaries');
  }
  const parsed = z.array(issueSummarySchema).safeParse(summaries);
  if (!parsed.success) throw Errors.badRequest('INVALID_SUMMARIES', 'Issue summaries are invalid');
  return {
    judgmentRef: 'aps-prioritize',
    systemPrompt: BASE_SYSTEM,
    userMessage:
      `Prioritize these APS exceptions for a planner's work queue. Customer-commit risk first (projected-late / critical severity), then planning hygiene (move in/out, not-needed).\n` +
      `Issues: ${JSON.stringify(parsed.data)}\n` +
      `Return JSON: { "order": string[] (issue ids, highest priority first), "rationale": string }`,
    schema: prioritizeDecisionSchema,
  };
}

const recommendDecisionSchema = z.object({
  recommendations: z.array(recommendationSchema).min(1).max(50),
  rootCauses: z.array(rootCauseSchema).max(50).optional(),
});

/**
 * `aps-recommend`: recommend planner actions from aggregate summaries.
 * SyteLine procedure steps are NOT produced here — those come from
 * procedures.ts (verified/unverified marked), never from the model.
 */
export function buildRecommendRequest(summaries: IssueSummary[]): ApsJudgmentRequest {
  if (summaries.length === 0 || summaries.length > 200) {
    throw Errors.badRequest('INVALID_SUMMARIES', 'Provide 1-200 issue summaries');
  }
  const parsed = z.array(issueSummarySchema).safeParse(summaries);
  if (!parsed.success) throw Errors.badRequest('INVALID_SUMMARIES', 'Issue summaries are invalid');
  return {
    judgmentRef: 'aps-recommend',
    systemPrompt: BASE_SYSTEM,
    userMessage:
      `Recommend concrete planner actions for these APS exceptions. Each action must be executable by a human planner (expedite a PO, firm a PLN order, reschedule supply, fix bad data) — not a restatement of the problem. Do NOT write SyteLine click-paths; procedure steps come from a separate verified source.\n` +
      `Issues: ${JSON.stringify(parsed.data)}\n` +
      `Return JSON: { "recommendations": [{ "action": string, "priority": "p0"|"p1"|"p2", "expectedImpact": string }], "rootCauses"?: [{ "category": "supplier"|"capacity"|"planning-parameter"|"data"|"unknown", "confidence": "high"|"medium"|"low", "reasoning": string }] }`,
    schema: recommendDecisionSchema,
  };
}
