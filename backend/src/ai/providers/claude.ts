/**
 * providers/claude.ts — Anthropic Messages API chat provider.
 *
 * Speaks the Anthropic `/v1/messages` API (streaming SSE) so tenants can
 * route turns to Claude models. Like every provider, it is constructed with
 * explicit connection parameters and never reads process env; the AI
 * Gateway authorizes the model, endpoint, and classification BEFORE this
 * provider is constructed. The API key travels only in the `x-api-key`
 * header — it is never logged, never returned, and never interpolated
 * into error messages.
 *
 * Notes on the mapping:
 * - Anthropic requires `max_tokens`; when the caller does not set one we
 *   use a conservative 4096 default (documented, not silent-billing magic:
 *   it only caps the response length).
 * - `system` messages become the top-level `system` parameter; `tool`
 *   messages become `tool_result` blocks on a user turn.
 * - Image inputs map to Anthropic `image` content blocks (base64 source).
 *   Only vision-capable models are ever offered messages carrying images —
 *   the chat route resolves a vision model for image turns, so this
 *   provider never has to refuse them.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  ChatProvider,
  ProviderEvent,
  ProviderToolDefinition,
  StreamChatOptions,
} from './types.js';

// Bounds on provider-driven tool-call assembly: the provider is untrusted
// for resource consumption even though it is allowlisted for connectivity.
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_TOOL_ARGUMENT_CHARS = 65536;

/** Anthropic requires max_tokens; this is the default when unset. */
const DEFAULT_MAX_TOKENS = 4096;

const ANTHROPIC_VERSION = '2023-06-01';

export interface ClaudeProviderConfig {
  /** Base URL of the Anthropic API (default https://api.anthropic.com). */
  endpoint: string;
  /** Anthropic API key. Sent only as the x-api-key header; never logged. */
  apiKey: string;
  /** Default per-request timeout when the call does not override it. */
  defaultTimeoutMs: number;
}

type ContentBlock = Record<string, unknown>;

interface AccumulatedToolCall {
  id: string;
  name: string;
  json: string;
}

function safeJsonParseObject(text: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // fall through to empty object
  }
  return {};
}

/**
 * Maps platform chat messages to Anthropic messages plus an optional
 * top-level `system` string. Anthropic only accepts `user`/`assistant`
 * roles: `system` messages are hoisted, `tool` messages become
 * `tool_result` blocks on a user turn.
 */
function toApiMessages(messages: ChatMessage[]): { system?: string; messages: ContentBlock[] } {
  const systemParts: string[] = [];
  const apiMessages: ContentBlock[] = [];

  for (const message of messages) {
    if (message.role === 'system') {
      if (typeof message.content === 'string' && message.content !== '') {
        systemParts.push(message.content);
      }
      continue;
    }

    if (message.role === 'tool') {
      apiMessages.push({
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: message.tool_call_id ?? '',
            content: typeof message.content === 'string' ? message.content : '',
          },
        ],
      });
      continue;
    }

    const role = message.role === 'assistant' ? 'assistant' : 'user';
    const blocks: ContentBlock[] = [];
    if (typeof message.content === 'string' && message.content !== '') {
      blocks.push({ type: 'text', text: message.content });
    }
    for (const image of message.images ?? []) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: image.mimeType, data: image.data },
      });
    }
    for (const call of message.tool_calls ?? []) {
      blocks.push({
        type: 'tool_use',
        id: call.id,
        name: call.function.name,
        input: safeJsonParseObject(call.function.arguments),
      });
    }
    // Anthropic rejects empty content arrays; a text placeholder keeps the
    // turn well-formed without inventing user content.
    apiMessages.push({ role, content: blocks.length > 0 ? blocks : [{ type: 'text', text: '' }] });
  }

  const result: { system?: string; messages: ContentBlock[] } = { messages: apiMessages };
  if (systemParts.length > 0) result.system = systemParts.join('\n\n');
  return result;
}

function toApiTools(tools: ProviderToolDefinition[]): ContentBlock[] {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

export class ClaudeProvider implements ChatProvider {
  readonly kind = 'claude';

  constructor(private readonly config: ClaudeProviderConfig) {}

  /**
   * Streams an Anthropic Messages API completion as discrete provider
   * events. Exactly one attempt per call — streaming inference is
   * non-idempotent (and billed), so the gateway fails over to another
   * model instead of retrying.
   */
  async *streamChat({
    endpoint,
    model,
    messages,
    tools,
    timeoutMs,
    maxTokens,
    temperature,
    signal,
  }: StreamChatOptions): AsyncGenerator<ProviderEvent, void, unknown> {
    const base = (endpoint || this.config.endpoint).replace(/\/+$/, '');
    const url = `${base}/v1/messages`;
    const { system, messages: apiMessages } = toApiMessages(messages);

    const body: Record<string, unknown> = {
      model,
      max_tokens: typeof maxTokens === 'number' ? maxTokens : DEFAULT_MAX_TOKENS,
      messages: apiMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (tools?.length) {
      body.tools = toApiTools(tools);
      body.tool_choice = { type: 'auto' };
    }
    if (typeof temperature === 'number') body.temperature = temperature;

    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.config.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      // Drain the body to free the connection, but never surface its
      // content: upstream bodies can carry sensitive or attacker-controlled
      // data that must not flow into audit reasons or client errors. The
      // API key is never interpolated into the error.
      await response.text().catch(() => '');
      throw new Error(`Model provider upstream error (${response.status})`);
    }

    if (!response.body) {
      throw new Error('Model provider upstream returned empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let pendingEvent = '';
    const toolCalls = new Map<number, AccumulatedToolCall>();
    let inputTokens = 0;
    let outputTokens = 0;

    const handleEvent = function* (eventType: string, data: string): Generator<ProviderEvent, void, unknown> {
      if (!data) return;
      let parsed: any;
      try {
        parsed = JSON.parse(data);
      } catch {
        return; // Skip malformed frames; never fabricate content.
      }
      switch (eventType) {
        case 'message_start': {
          inputTokens = toNonNegativeInt(parsed.message?.usage?.input_tokens);
          break;
        }
        case 'content_block_start': {
          const block = parsed.content_block;
          const index = typeof parsed.index === 'number' ? parsed.index : 0;
          if (block?.type === 'tool_use') {
            if (!toolCalls.has(index) && toolCalls.size >= MAX_TOOL_CALLS_PER_TURN) break;
            toolCalls.set(index, {
              id: typeof block.id === 'string' ? block.id.slice(0, 128) : '',
              name: typeof block.name === 'string' ? block.name.slice(0, 128) : '',
              json: '',
            });
          }
          break;
        }
        case 'content_block_delta': {
          const delta = parsed.delta;
          const index = typeof parsed.index === 'number' ? parsed.index : 0;
          if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
            yield { type: 'text', content: delta.text };
          } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            const existing = toolCalls.get(index) ?? { id: '', name: '', json: '' };
            if (existing.json.length < MAX_TOOL_ARGUMENT_CHARS) {
              existing.json += delta.partial_json.slice(0, MAX_TOOL_ARGUMENT_CHARS - existing.json.length);
            }
            toolCalls.set(index, existing);
          }
          break;
        }
        case 'message_delta': {
          outputTokens = toNonNegativeInt(parsed.usage?.output_tokens);
          break;
        }
        default:
          break;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;
          if (trimmed.startsWith('event:')) {
            pendingEvent = trimmed.slice(6).trim();
          } else if (trimmed.startsWith('data:')) {
            yield* handleEvent(pendingEvent, trimmed.slice(5).trim());
          }
        }
      }

      const tail = buffer.trim();
      if (tail.startsWith('data:')) {
        yield* handleEvent(pendingEvent, tail.slice(5).trim());
      }
    } finally {
      reader.releaseLock();
    }

    if (inputTokens > 0 || outputTokens > 0) {
      yield {
        type: 'usage',
        usage: { promptTokens: inputTokens, completionTokens: outputTokens, totalTokens: inputTokens + outputTokens },
      };
    }

    for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
      if (call.name) {
        yield { type: 'tool_call', id: call.id || randomUUID(), name: call.name, arguments: call.json };
      }
    }
  }
}
