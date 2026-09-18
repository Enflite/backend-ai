import { Errors, AppError } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import { getApprovedModelForUser, ApprovedModel } from './modelRegistry.js';
import { streamChat, ProviderEvent, ProviderToolDefinition, TokenUsage, ChatMessage } from './vllmProvider.js';
export type { ProviderToolDefinition, ChatMessage, TokenUsage };
import { Classification } from '../../authz/permissions.js';
import { canModelProcess } from '../../policy/engine.js';
import { config } from '../../config.js';
import { buildSystemPrompt } from '../../chat/systemPrompt.js';

/**
 * The default system prompt, pinned at index 0 of every provider call.
 * Built by `buildSystemPrompt` (src/chat/systemPrompt.ts), which encodes the
 * assistant-quality charter (docs/assistant-quality.md §2–§3). Callers that
 * need request-scoped metadata (model name/version) pass their own prompt
 * via `GatewayStreamInput.systemPrompt` / `applyContextWindow`; this default
 * keeps every other caller on the charter-encoded prompt.
 */
export const SYSTEM_PROMPT = buildSystemPrompt({});

export interface GatewayStreamInput {
  tenantId: string;
  userId: string;
  roleId: string;
  requestId?: string;
  modelId: string;
  classification: Classification;
  messages: ChatMessage[];
  /** OpenAI-compatible tool definitions the model may call this turn. */
  tools?: ProviderToolDefinition[];
  signal?: AbortSignal;
  /**
   * Trusted system prompt for this turn (built by application code via
   * `buildSystemPrompt`). Defaults to SYSTEM_PROMPT. The gateway always
   * strips caller-supplied `system` messages and injects exactly one prompt
   * at index 0 — stored history can never smuggle instructions past it.
   */
  systemPrompt?: string;
  /** Filled in as the stream progresses: time-to-first-token and usage. */
  telemetry?: GatewayTelemetry;
}

export interface GatewayTelemetry {
  timeToFirstTokenMs?: number;
  usage?: TokenUsage;
  fallbackUsed?: boolean;
  fallbackModelId?: string;
  fallbackModelName?: string;
}

/** Gateway-level events (provider events plus failover notices). */
export type GatewayEvent = ProviderEvent | { type: 'failover'; modelId: string; modelName: string; contextWindow: number };

export interface GatewayStreamResult {
  events: AsyncGenerator<GatewayEvent, void, unknown>;
  /** The primary model (authorization already verified). */
  model: ApprovedModel;
  telemetry: GatewayTelemetry;
}

/**
 * Persisted `messages.metadata` stream status for assistant turns.
 *
 * The interrupted marker used to travel in the message body itself; it now
 * lives in metadata so history readers see the clean model text plus an
 * explicit machine-readable status. Migration 015
 * (`015_message_metadata.sql`) adds the column and backfills rows that still
 * carry the legacy in-content marker.
 */
export type StreamStatus = 'completed' | 'interrupted';

export interface StreamMetadata {
  stream_status: StreamStatus;
  /** Present and true only when the stream did not run to completion. */
  stream_interrupted?: boolean;
}

/**
 * Builds the `messages.metadata` value for a finished assistant turn.
 * `interrupted` covers provider errors, client disconnects, and stalled
 * consumers; `completed` means the terminal `done` frame was delivered.
 */
export function streamMetadata(status: StreamStatus): StreamMetadata {
  return status === 'interrupted'
    ? { stream_status: status, stream_interrupted: true }
    : { stream_status: status };
}

function resolveEndpoint(model: ApprovedModel): void {
  const allowedOrigins = new Set(config.AI_PROVIDER_ALLOWED_ORIGINS.split(',').map((value) => value.trim()));
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(model.endpoint).origin;
  } catch {
    throw Errors.forbidden('MODEL_ENDPOINT_INVALID', 'Approved model endpoint is invalid');
  }
  if (!allowedOrigins.has(endpointOrigin)) {
    throw Errors.forbidden('MODEL_ENDPOINT_DENIED', 'Approved model endpoint is outside the server allowlist');
  }
}

function checkClassification(classification: Classification, model: ApprovedModel): void {
  const decision = canModelProcess(classification, model.allowed_classifications);
  if (!decision.allowed) throw Errors.forbidden('MODEL_CLASSIFICATION_DENIED', 'Model is not approved for this data classification');
}

function checkProviderSupport(model: ApprovedModel): void {
  if (model.provider !== 'vllm' && model.provider !== 'openai-compatible') {
    throw Errors.forbidden('MODEL_PROVIDER_UNSUPPORTED', 'Approved model provider is not supported by this gateway');
  }
}

/**
 * Heuristic token estimate (chars / 4). Documented as an approximation for
 * context-window budgeting only — never for billing.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function estimateMessagesTokens(messages: ChatMessage[]): number {
  return messages.reduce((total, message) => {
    const content = typeof message.content === 'string' ? message.content : '';
    return total + estimateTokens(content) + 8; // per-message framing overhead
  }, 0);
}

/**
 * Sliding-window truncation for the model's context window.
 *
 * Strategy (documented, never silent):
 * - The system prompt is ALWAYS retained (index 0 of the result). Callers
 *   may supply their own trusted prompt (e.g. with model metadata); it
 *   defaults to the gateway's SYSTEM_PROMPT and is budgeted the same way.
 * - The most recent messages are retained; oldest non-system messages are
 *   dropped first until the budget fits.
 * - `reserveTokens` keeps headroom for the response (defaults to 25% of the
 *   window or 4096, whichever is smaller).
 * - Tool-result messages are dropped before user/assistant history when
 *   forced to choose, since they are reproducible untrusted data.
 *
 * Returns the truncated list and how many messages were dropped so callers
 * can surface it (e.g. in audit metadata or UI hints).
 */
export function applyContextWindow(
  messages: ChatMessage[],
  contextWindow: number,
  reserveTokens?: number,
  systemPrompt: string = SYSTEM_PROMPT
): { messages: ChatMessage[]; dropped: number } {
  const systemMessage: ChatMessage = { role: 'system', content: systemPrompt };
  const history = messages.filter((message) => message.role !== 'system');
  const reserve = reserveTokens ?? Math.min(4096, Math.floor(contextWindow * 0.25));
  const budget = Math.max(512, contextWindow - reserve - estimateTokens(systemPrompt) - 8);

  let selected = history;
  let dropped = 0;
  while (selected.length > 1 && estimateMessagesTokens(selected) > budget) {
    // Prefer dropping tool results first (reproducible), then oldest first.
    const toolIndex = selected.findIndex((message) => message.role === 'tool');
    const dropIndex = toolIndex >= 0 ? toolIndex : 0;
    selected = [...selected.slice(0, dropIndex), ...selected.slice(dropIndex + 1)];
    dropped += 1;
  }
  // If even one message exceeds the budget, hard-truncate its content tail.
  if (selected.length === 1 && estimateMessagesTokens(selected) > budget) {
    const only = selected[0]!;
    const content = typeof only.content === 'string' ? only.content : '';
    const allowedChars = Math.max(0, budget * 4 - 64);
    selected = [{ ...only, content: `${content.slice(0, allowedChars)}\n\n[truncated: message exceeded context budget]` }];
    dropped += 1;
  }
  return { messages: [systemMessage, ...selected], dropped };
}

async function* streamWithTelemetry(
  model: ApprovedModel,
  messages: ChatMessage[],
  input: GatewayStreamInput,
  telemetry: GatewayTelemetry
): AsyncGenerator<ProviderEvent, void, unknown> {
  const startedAt = Date.now();
  const stream = streamChat({
    endpoint: model.endpoint,
    model: model.model_identifier,
    messages,
    tools: input.tools,
    timeoutMs: model.request_timeout_ms ?? config.AI_REQUEST_TIMEOUT_MS,
    maxTokens: model.max_tokens,
    temperature: model.temperature,
    signal: input.signal,
  });
  for await (const event of stream) {
    if (event.type === 'text' && telemetry.timeToFirstTokenMs === undefined) {
      telemetry.timeToFirstTokenMs = Date.now() - startedAt;
    }
    if (event.type === 'usage') {
      telemetry.usage = event.usage;
    }
    yield event;
  }
}

async function auditModelUse(
  input: GatewayStreamInput,
  model: ApprovedModel,
  telemetry: GatewayTelemetry,
  success: boolean,
  reason?: string
): Promise<void> {
  await recordAudit({
    tenantId: input.tenantId,
    userId: input.userId,
    requestId: input.requestId,
    action: 'MODEL_USED',
    resource: 'model',
    resourceId: model.id,
    model: model.name,
    success,
    reason,
    metadata: {
      ...(telemetry.timeToFirstTokenMs !== undefined ? { timeToFirstTokenMs: telemetry.timeToFirstTokenMs } : {}),
      ...(telemetry.usage ? { usage: telemetry.usage } : {}),
      ...(telemetry.fallbackUsed ? { fallbackUsed: true, fallbackModelId: telemetry.fallbackModelId } : {}),
    },
  });
}

/**
 * Streams a chat completion through the authorized model, failing over once to
 * the model's configured fallback (which must itself be approved for this
 * user, tenant, and classification) when the primary provider fails.
 *
 * Failover triggers only on provider failures (network errors, timeouts, 5xx,
 * malformed streams) — never on authorization/policy rejections, which are
 * deterministic and must surface immediately. A `failover` event is emitted
 * before fallback output so transcripts stay honest about which model spoke.
 */
export async function gatewayStream(input: GatewayStreamInput): Promise<GatewayStreamResult> {
  const telemetry: GatewayTelemetry = input.telemetry ?? {};
  const primary = await getApprovedModelForUser(input.modelId, input.tenantId, input.userId, input.roleId);

  // Authorize the primary up front: endpoint allowlist, provider support, and
  // classification policy. Strip any caller-supplied `system` messages and
  // prepend the trusted system prompt (per-turn prompt when the caller built
  // one, else the gateway default): stored history must never smuggle
  // instructions past it, and the provider must never see a prompt without
  // the security policy (applyContextWindow's prompt is re-added here
  // because callers cannot be trusted to have included it).
  checkProviderSupport(primary);
  resolveEndpoint(primary);
  checkClassification(input.classification, primary);
  const systemPrompt = input.systemPrompt ?? SYSTEM_PROMPT;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    ...input.messages.filter((message) => message.role !== 'system'),
  ];

  async function* events(): AsyncGenerator<GatewayEvent, void, unknown> {
    let primaryProducedOutput = false;
    try {
      for await (const event of streamWithTelemetry(primary, messages, input, telemetry)) {
        if (event.type === 'text' || event.type === 'tool_call') primaryProducedOutput = true;
        yield event;
      }
      await auditModelUse(input, primary, telemetry, true);
      return;
    } catch (err) {
      // Never fail over on policy/auth rejections: retrying those is pointless
      // and could mask a real authorization bug. Never fail over after the
      // primary already produced visible output either: that would stitch two
      // models' answers into a single turn with no honest attribution. And
      // never fail over on caller cancellation: retrying an aborted signal
      // would only produce a misleading MODEL_FAILOVER audit record and a
      // second immediate failure on the same dead signal.
      const cancelled = input.signal?.aborted === true;
      const failoverEligible =
        !cancelled && !primaryProducedOutput && !(err instanceof AppError) && !!primary.fallback_model_id;
      if (!failoverEligible) {
        await auditModelUse(input, primary, telemetry, false, err instanceof Error ? err.message : 'Model provider error');
        throw err instanceof AppError ? err : Errors.internal('Model provider unavailable');
      }
      let fallback: ApprovedModel;
      try {
        fallback = await getApprovedModelForUser(primary.fallback_model_id!, input.tenantId, input.userId, input.roleId);
        checkProviderSupport(fallback);
        resolveEndpoint(fallback);
        checkClassification(input.classification, fallback);
      } catch (policyError) {
        // Deliberately generic: the specific fallback policy failure is in the
        // audit trail, but the client must not learn which fallbacks exist or
        // why they were denied.
        await auditModelUse(input, primary, telemetry, false, 'Primary provider failed and fallback model failed authorization or policy checks');
        throw Errors.internal('Model provider unavailable');
      }
      telemetry.fallbackUsed = true;
      telemetry.fallbackModelId = fallback.id;
      telemetry.fallbackModelName = fallback.name;
      await recordAudit({
        tenantId: input.tenantId,
        userId: input.userId,
        requestId: input.requestId,
        action: 'MODEL_FAILOVER',
        resource: 'model',
        resourceId: fallback.id,
        model: fallback.name,
        success: true,
        reason: err instanceof Error ? err.message : 'Primary model provider failed',
        metadata: { primaryModelId: primary.id, primaryModel: primary.name },
      });
      yield { type: 'failover', modelId: fallback.id, modelName: fallback.name, contextWindow: fallback.context_window };
      try {
        yield* streamWithTelemetry(fallback, messages, input, telemetry);
        await auditModelUse(input, fallback, telemetry, true);
      } catch (fallbackError) {
        // No chains: a failing fallback surfaces instead of cascading.
        await auditModelUse(input, fallback, telemetry, false, fallbackError instanceof Error ? fallbackError.message : 'Fallback provider error');
        throw fallbackError instanceof AppError ? fallbackError : Errors.internal('Model provider unavailable');
      }
    }
  }

  return { events: events(), model: primary, telemetry };
}
