/**
 * agentJudgment.ts — the agent-escalation seam.
 *
 * Any flow step that needs judgment (kind `agentJudgment`) pauses
 * deterministic execution and escalates through this narrow, typed
 * interface: planner prompt in, structured decision out, zod-validated.
 * A step asks the model and continues with the validated decision —
 * the model never executes steps itself and never enforces anything.
 */

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { gatewayStream } from '../ai/gateway/gateway.js';
import { resolveChatDefault } from '../ai/gateway/capabilityRouter.js';
import type { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import type { FlowRunContext } from './flowRunner.js';

export interface AgentJudgmentRequest {
  /** Registry ref of the prompt builder (for audit). */
  judgmentRef: string;
  systemPrompt: string;
  userMessage: string;
  /** The model's decision must satisfy this schema. */
  schema: z.ZodType<unknown>;
}

export type AgentJudgmentResult =
  | { ok: true; decision: unknown }
  | { ok: false; code: 'invalid-decision' | 'judge-unavailable'; detail: string };

export type AgentJudgmentFn = (
  ctx: FlowRunContext,
  request: AgentJudgmentRequest,
  signal: AbortSignal,
) => Promise<AgentJudgmentResult>;

let judgeOverride: AgentJudgmentFn | null = null;

/** Test-only seam: substitute the judge. */
export function overrideAgentJudge(fn: AgentJudgmentFn | null): void {
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
  ctx: FlowRunContext,
  request: AgentJudgmentRequest,
  signal: AbortSignal,
): Promise<AgentJudgmentResult> {
  let model: { id: string } | null = null;
  try {
    model = await resolveChatDefault(ctx.actor.tenantId, ctx.actor.userId, ctx.actor.roleId);
  } catch {
    model = null;
  }
  if (!model) {
    return { ok: false, code: 'judge-unavailable', detail: 'No servable model is available for agent judgment.' };
  }
  try {
    const result = await gatewayStream({
      tenantId: ctx.actor.tenantId,
      userId: ctx.actor.userId,
      roleId: ctx.actor.roleId,
      requestId: `flow-judge-${randomUUID()}`,
      modelId: model.id,
      classification: ctx.actor.clearance as Classification,
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
export async function agentJudge(
  ctx: FlowRunContext,
  request: AgentJudgmentRequest,
  signal: AbortSignal,
): Promise<AgentJudgmentResult> {
  return (judgeOverride ?? defaultJudge)(ctx, request, signal);
}
