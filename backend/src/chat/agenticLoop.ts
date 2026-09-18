/**
 * agenticLoop.ts — Phase 6: the generalized agentic tool loop.
 *
 * Phase 5 built the SyteLine diagnostic chain inline in the chat route; this
 * module extracts that loop into a first-class, reusable engine any tool
 * family can run through. The contract:
 *
 * - **Bounded iteration budget.** `maxIterations` tool rounds per run; the
 *   loop stops cleanly at the budget instead of looping forever, and says
 *   so in the transcript (via the sink).
 * - **Per-step audit.** Every tool round writes one `AGENTIC_LOOP_STEP`
 *   audit event: step index, serving model, tool names, argument *keys*
 *   (never values — arguments can carry PII), and per-call outcomes. Full
 *   traceability without leaking data into the audit trail.
 * - **Dependent chaining.** Each round's tool results are appended to the
 *   working message list as zone-4 delimited tool messages, so later rounds
 *   see earlier results — the mechanism behind multi-step investigations.
 * - **Brief plan narration.** Before executing a round's tools the loop
 *   narrates a one-line plan through the sink (e.g. "I'll look up sales
 *   order SO-123, then check availability for its lines."). The narration
 *   is derived deterministically from the tool calls — no extra model
 *   round-trip, no invented detail.
 * - **Approval-gated destructive tools.** The loop never auto-executes a
 *   destructive tool. `approvalFor(toolName)` decides per tool; unapproved
 *   destructive calls are skipped and reported back to the model as a
 *   `TOOL_REQUIRES_APPROVAL` error so it can explain and ask. A future
 *   human-in-the-loop approval flow can pre-approve specific call IDs via
 *   `approvedCallIds` — until then, write-capable tools stay out of
 *   auto-execution by construction.
 * - **Streaming honesty.** Text deltas flow through the sink as they arrive;
 *   the sink returning false (client gone / too slow) stops the loop. Model
 *   failover mid-loop switches subsequent rounds to the serving model; the
 *   gateway itself never fails over after visible output began.
 *
 * The chat route (`chat/routes.ts`) is the first consumer; future consumers
 * (a repo-index tool family, write-capable tools behind approval) reuse the
 * same loop, budgets, audit, and narration.
 */
import { Errors, AppError } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  gatewayStream,
  applyContextWindow,
  type GatewayTelemetry,
  type ChatMessage,
  type ProviderToolDefinition,
} from '../ai/gateway/gateway.js';
import { getTool, runToolCall } from '../tools/gateway.js';
import { runToolCallWithRecovery, type ToolCallRunner } from './toolRecovery.js';
import { wrapToolResult } from './systemPrompt.js';
import type { DlpStreamGuard } from '../dlp/streamGuard.js';
import type { DlpKind } from '../dlp/detectors.js';
import type { AuthContext, Classification } from '../authz/permissions.js';

/** Injectable gateway stream; defaults to the real gateway at the call site. */
export type GatewayStreamFn = typeof gatewayStream;

export interface LoopToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface AgenticLoopSink {
  /** Streamed text delta (already DLP-processed). Return false to stop. */
  text(delta: string): Promise<boolean>;
  /** One-line plan narration before a tool round. Return false to stop. */
  plan(plan: string, toolNames: string[]): Promise<boolean>;
  /** Tool-call announcement for a round. Return false to stop. */
  toolCalls(calls: Array<{ name: string }>): Promise<boolean>;
  /** Model failover notice. Return false to stop. */
  failover(modelName: string, modelId: string): Promise<boolean>;
  /** Terminal payload for the run. Return true when it was delivered. */
  done(payload: AgenticLoopDonePayload): Promise<boolean>;
  /** Stream-level error. */
  error(code: string, message: string): Promise<void>;
}

export interface AgenticLoopDonePayload {
  finishReason: string;
  usage?: GatewayTelemetry['usage'];
  timeToFirstTokenMs?: number;
  fallback?: { id?: string; name?: string };
  toolIterations: number;
  /** Capability whose model served the turn (for telemetry, not user-facing). */
  capabilityResolved?: string;
  capabilityFallbackUsed?: boolean;
}

export interface AgenticLoopResult {
  /** Accumulated (DLP-processed) assistant text. */
  content: string;
  finishReason: string;
  toolIterations: number;
  truncatedByCap: boolean;
  /** The model that actually served the turn (post-failover). */
  servingModel: { id: string; name: string };
  /** Error after partial output was produced. */
  interrupted: boolean;
  /** The run's try block threw (even with no partial output). */
  failed: boolean;
  /** Caller signal aborted mid-run. */
  aborted: boolean;
  /** The terminal done payload reached the sink. */
  completed: boolean;
  /** DLP detections tallied during the run (kinds only — never matched text). */
  dlpDetections: DlpKind[];
}

export interface AgenticLoopOptions {
  tenantId: string;
  userId: string;
  roleId: string;
  requestId?: string;
  classification: Classification;
  auth: AuthContext;
  /** Model resolved for round 1 (already authorized by the caller). */
  initialModel: { id: string; name: string; contextWindow: number; version?: string };
  /**
   * Build the round's system prompt naming the serving model. Called once
   * for the initial model and again after a mid-loop failover so the prompt
   * stays honest about which model is serving.
   */
  buildSystemPrompt(modelName: string, modelVersion?: string): string;
  /** Tool definitions offered to the model this run (already authorized). */
  providerTools: ProviderToolDefinition[];
  /** History including the latest user turn; the loop strips system messages. */
  messages: ChatMessage[];
  signal: AbortSignal;
  /** Filled in place by the gateway, as in gatewayStream. */
  telemetry: GatewayTelemetry;
  maxIterations: number;
  maxResponseChars: number;
  dlpGuard?: DlpStreamGuard | null;
  /**
   * Approval contract per tool name. Return 'requires-approval' for tools
   * that must not auto-execute. The default (used by the chat route) routes
   * every destructive tool in the registry through approval.
   */
  approvalFor?: (toolName: string) => 'auto' | 'requires-approval';
  /**
   * Call IDs a human-in-the-loop approval flow already approved. A future
   * approval UI mints these; the loop executes a destructive call only when
   * its ID is present. Empty today — destructive tools stay out of
   * auto-execution.
   */
  approvedCallIds?: Set<string>;
  capabilityResolved?: string;
  capabilityFallbackUsed?: boolean;
  /** Event sink: the loop streams text/plans/notices through it. */
  sink: AgenticLoopSink;
  /** Injectable seams for tests. */
  streamGateway?: GatewayStreamFn;
  toolRunner?: ToolCallRunner;
}

function defaultApprovalFor(toolName: string): 'auto' | 'requires-approval' {
  try {
    return getTool(toolName).destructive ? 'requires-approval' : 'auto';
  } catch {
    // Unknown tool: runToolCall will deny it with TOOL_NOT_FOUND and the
    // denial is fed back to the model. The approval gate only constrains
    // tools that exist.
    return 'auto';
  }
}

// Salient identifier keys, in preference order, for plan narration.
const PLAN_ID_KEYS = ['orderNumber', 'workOrderNumber', 'customerNumber', 'item', 'site', 'documentId', 'path'];

/** Human phrases per known tool; unknown tools fall back to `run <name>`. */
const PLAN_PHRASES: Record<string, (id: string | undefined) => string> = {
  'syteline.getSalesOrder': (id) => `look up sales order ${id ?? 'details'}`,
  'syteline.getItem': (id) => `look up item ${id ?? 'details'}`,
  'syteline.getItemAvailability': (id) => `check availability for ${id ?? 'the item'}`,
  'syteline.getOpenPurchaseOrders': (id) => `check open purchase orders for ${id ?? 'the item'}`,
  'syteline.getWorkOrders': (id) => `check work orders${id ? ` for ${id}` : ''}`,
  'syteline.getBom': (id) => `explode the BOM for ${id ?? 'the item'}`,
  'syteline.getCustomer': (id) => `look up customer ${id ?? 'details'}`,
};

/**
 * Build the one-line plan narrated before a tool round. Derived
 * deterministically from the tool calls the model actually requested —
 * never invented, never a second model call. At most three calls are named;
 * the rest fold into "+N more".
 */
export function buildPlanNarrative(calls: LoopToolCall[]): string {
  const phrases = calls.slice(0, 3).map((call) => {
    let identifier: string | undefined;
    try {
      const args = JSON.parse(call.arguments) as Record<string, unknown>;
      for (const key of PLAN_ID_KEYS) {
        const value = args[key];
        if (typeof value === 'string' && value.length > 0 && value.length <= 80) {
          identifier = value;
          break;
        }
      }
    } catch {
      // Malformed args: narrate the tool without an identifier rather than
      // failing the narration.
    }
    const phrase = PLAN_PHRASES[call.name] ?? ((id: string | undefined) => `run ${call.name}${id ? ` (${id})` : ''}`);
    return phrase(identifier);
  });
  const remainder = calls.length - phrases.length;
  const list = remainder > 0 ? `${phrases.join(', ')}, and ${remainder} more` : phrases.join(', ');
  return `I'll ${list}.`;
}

/**
 * Run the agentic loop: stream model rounds, execute requested tools with
 * recovery, feed delimited results back, until the model stops calling
 * tools, the budget is spent, or the sink stops the run.
 */
export async function runAgenticLoop(options: AgenticLoopOptions): Promise<AgenticLoopResult> {
  const {
    tenantId,
    userId,
    roleId,
    requestId,
    classification,
    auth,
    providerTools,
    signal,
    telemetry,
    maxIterations,
    maxResponseChars,
    dlpGuard,
    sink,
  } = options;
  const streamGateway = options.streamGateway ?? gatewayStream;
  const toolRunner = options.toolRunner ?? runToolCall;
  const approvalFor = options.approvalFor ?? defaultApprovalFor;
  const approvedCallIds = options.approvedCallIds ?? new Set<string>();

  let content = '';
  let finishReason = 'stop';
  let interrupted = false;
  let failed = false;
  let completed = false;
  let truncatedByCap = false;
  let toolIterations = 0;
  const dlpDetections: DlpKind[] = [];
  let roundModelId = options.initialModel.id;
  let roundModelName = options.initialModel.name;
  let roundModelVersion = options.initialModel.version;
  let roundContextWindow = options.initialModel.contextWindow;
  let roundSystemPrompt = options.buildSystemPrompt(roundModelName, roundModelVersion);
  let turnMessages: ChatMessage[] = applyContextWindow(
    options.messages.filter((m) => m.role !== 'system'),
    roundContextWindow,
    undefined,
    roundSystemPrompt
  ).messages;

  try {
    for (;;) {
      const round = applyContextWindow(
        turnMessages.filter((m) => m.role !== 'system'),
        roundContextWindow,
        undefined,
        roundSystemPrompt
      );
      turnMessages = round.messages;
      const result = await streamGateway({
        tenantId,
        userId,
        roleId,
        requestId,
        modelId: roundModelId,
        classification,
        messages: turnMessages,
        tools: providerTools.length ? providerTools : undefined,
        signal,
        telemetry,
        systemPrompt: roundSystemPrompt,
      });
      const toolCalls: LoopToolCall[] = [];
      let roundTruncated = false;
      let sinkStopped = false;
      for await (const event of result.events) {
        if (signal.aborted) break;
        if (event.type === 'text') {
          let chunk = event.content;
          if (content.length + chunk.length > maxResponseChars) {
            chunk = chunk.slice(0, maxResponseChars - content.length);
            roundTruncated = true;
          }
          // DLP: redact before the sink or the transcript ever sees it.
          let emit = chunk;
          if (dlpGuard) {
            const dlp = await dlpGuard.process(chunk);
            emit = dlp.emit;
            dlpDetections.push(...dlp.detections);
          }
          content += emit;
          if (emit && !(await sink.text(emit))) {
            sinkStopped = true;
            break;
          }
          if (roundTruncated) {
            finishReason = 'length';
            truncatedByCap = true;
            break;
          }
        } else if (event.type === 'tool_call') {
          toolCalls.push(event);
        } else if (event.type === 'failover') {
          roundModelId = event.modelId;
          roundModelName = event.modelName;
          roundModelVersion = undefined;
          roundContextWindow = event.contextWindow;
          // Keep the pinned prompt honest about which model is serving: the
          // fallback's registry version is unknown here, so name only.
          roundSystemPrompt = options.buildSystemPrompt(event.modelName);
          if (!(await sink.failover(event.modelName, event.modelId))) {
            sinkStopped = true;
            break;
          }
        }
        // 'usage' events are folded into telemetry by the gateway.
      }
      if (sinkStopped || signal.aborted) break;
      if (toolCalls.length === 0 || toolIterations >= maxIterations || roundTruncated) {
        if (toolCalls.length > 0 && toolIterations >= maxIterations) {
          await recordAudit({
            tenantId,
            userId,
            requestId,
            action: 'AGENTIC_LOOP_BUDGET',
            resource: 'chat',
            classification,
            success: true,
            metadata: { maxIterations, pendingToolCalls: toolCalls.map((c) => c.name) },
          });
          // Say so in the transcript: the user deserves to know the turn was
          // cut off by the budget, not finished by the model. This is
          // server narration, clearly bracketed — never model output.
          const pending = toolCalls.map((c) => c.name).join(', ');
          const notice =
            `\n\n[I stopped after ${maxIterations} tool round${maxIterations === 1 ? '' : 's'} ` +
            `to keep the turn bounded — ${pending} didn't run. Ask me to continue and I'll pick up where I left off.]`;
          content += notice;
          await sink.text(notice);
          finishReason = 'tool_budget';
          truncatedByCap = true;
        }
        break;
      }
      toolIterations += 1;

      // Brief plan narration: one line derived from the requested calls,
      // before anything executes.
      if (!(await sink.plan(buildPlanNarrative(toolCalls), toolCalls.map((c) => c.name)))) break;
      if (!(await sink.toolCalls(toolCalls.map((c) => ({ name: c.name }))))) break;

      // Record the assistant's tool-call turn so the transcript is faithful.
      turnMessages.push({
        role: 'assistant',
        content: null,
        tool_calls: toolCalls.map((call) => ({
          id: call.id,
          type: 'function' as const,
          function: { name: call.name, arguments: call.arguments },
        })),
      });

      // Approval gate: destructive tools never auto-execute. Unapproved ones
      // are reported back to the model as TOOL_REQUIRES_APPROVAL so it can
      // explain what the tool would do and ask — the turn stays useful
      // instead of dying, and nothing destructive runs without a human.
      const executions = await Promise.all(
        toolCalls.map(async (call) => {
          if (approvalFor(call.name) === 'requires-approval' && !approvedCallIds.has(call.id)) {
            await recordAudit({
              tenantId,
              userId,
              requestId,
              action: 'TOOL_EXECUTION',
              resource: 'tool',
              tool: call.name,
              classification,
              success: false,
              reason: 'Destructive tool requires human approval; not executed',
            });
            return {
              call,
              skipped: true as const,
              outcome: null,
            };
          }
          // Agentic error recovery (charter §2.5): transient-looking
          // failures get exactly one retry; every outcome — success or
          // sanitized error — is fed back to the model as a zone-4 tool
          // result.
          const outcome = await runToolCallWithRecovery(toolRunner, {
            auth,
            name: call.name,
            rawArguments: call.arguments,
            classification,
            confirmed: approvedCallIds.has(call.id),
            requestId,
            signal,
          });
          return { call, skipped: false as const, outcome };
        })
      );

      for (const { call, skipped, outcome } of executions) {
        let rendered: string;
        if (skipped) {
          rendered =
            'error (TOOL_REQUIRES_APPROVAL): this tool can change data and needs human approval before it runs. ' +
            'It was NOT executed. Explain what it would do and ask the user to approve it.';
        } else {
          const execution = outcome!.result;
          rendered = execution.ok
            ? (execution.output ?? 'null')
            : `error (${execution.errorCode}): ${execution.message ?? 'tool call failed'}`;
        }
        turnMessages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: call.name,
          content: wrapToolResult(call.name, rendered),
        });
      }

      // Per-step audit: what the loop did this round. Argument keys only —
      // values can carry PII and never belong in the audit trail.
      await recordAudit({
        tenantId,
        userId,
        requestId,
        action: 'AGENTIC_LOOP_STEP',
        resource: 'chat',
        classification,
        success: true,
        metadata: {
          step: toolIterations,
          modelId: roundModelId,
          tools: toolCalls.map((c) => c.name),
          argKeys: toolCalls.map((c) => {
            try {
              return Object.keys(JSON.parse(c.arguments) as Record<string, unknown>).sort();
            } catch {
              return ['<unparseable>'];
            }
          }),
          outcomes: executions.map(({ skipped, outcome }) =>
            skipped ? 'approval-required' : outcome!.result.ok ? 'ok' : outcome!.result.errorCode
          ),
          retried: executions.some(({ outcome }) => outcome?.retried === true),
        },
      });
    }

    // DLP: flush the guard's held-back tail so the complete redacted answer
    // is what the sink received (text before done) and what the caller
    // persists.
    if (dlpGuard) {
      const flushed = await dlpGuard.flush();
      dlpDetections.push(...flushed.detections);
      if (flushed.emit) {
        content += flushed.emit;
        await sink.text(flushed.emit);
      }
    }
    if (!signal.aborted || truncatedByCap) {
      completed = await sink.done({
        finishReason,
        usage: telemetry.usage,
        ...(telemetry.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: telemetry.timeToFirstTokenMs } : {}),
        ...(telemetry.fallbackUsed ? { fallback: { id: telemetry.fallbackModelId, name: telemetry.fallbackModelName } } : {}),
        toolIterations,
        capabilityResolved: options.capabilityResolved,
        capabilityFallbackUsed: options.capabilityFallbackUsed,
      });
    }
  } catch (error) {
    failed = true;
    if (content) interrupted = true;
    const code = error instanceof AppError ? error.code : 'STREAM_ERROR';
    await sink.error(code, error instanceof AppError ? error.message : 'Model request failed');
  }

  return {
    content,
    finishReason,
    toolIterations,
    truncatedByCap,
    servingModel: {
      id: telemetry.fallbackUsed && telemetry.fallbackModelId ? telemetry.fallbackModelId : roundModelId,
      name: telemetry.fallbackUsed && telemetry.fallbackModelName ? telemetry.fallbackModelName : roundModelName,
    },
    interrupted,
    failed,
    aborted: signal.aborted,
    completed,
    dlpDetections,
  };
}


