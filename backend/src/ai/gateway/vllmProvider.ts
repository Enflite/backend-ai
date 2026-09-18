import { config } from '../../config.js';
import { randomUUID } from 'node:crypto';

// Bounds on provider-driven tool-call assembly: the provider is untrusted for
// resource consumption even though it is allowlisted for connectivity.
const MAX_TOOL_CALLS_PER_TURN = 32;
const MAX_TOOL_ARGUMENT_CHARS = 65536;

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** OpenAI-compatible function tool definition sent to the provider. */
export interface ProviderToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Events produced while streaming a chat completion. */
export type ProviderEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: TokenUsage };

export interface StreamChatOptions {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  tools?: ProviderToolDefinition[];
  /** Override the server default inference timeout for this call. */
  timeoutMs?: number;
  maxTokens?: number | null;
  temperature?: number | null;
  signal?: AbortSignal;
}

interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : 0;
}

/**
 * Streams an OpenAI-compatible chat completion as discrete events.
 *
 * This is a genuine provider integration: requests go to the model registry's
 * endpoint, responses are parsed frame-by-frame, and malformed frames are
 * skipped rather than fabricated. There is exactly one attempt per call —
 * streaming inference is non-idempotent (and often billed), so the gateway
 * performs failover to another model instead of retrying the same request.
 */
export async function* streamChat({
  endpoint,
  model,
  messages,
  tools,
  timeoutMs,
  maxTokens,
  temperature,
  signal,
}: StreamChatOptions): AsyncGenerator<ProviderEvent, void, unknown> {
  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.VLLM_API_KEY && config.VLLM_API_KEY.trim().length > 0) {
    headers['Authorization'] = `Bearer ${config.VLLM_API_KEY}`;
  }

  const body: Record<string, unknown> = { model, messages, stream: true, stream_options: { include_usage: true } };
  if (tools?.length) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }
  if (typeof maxTokens === 'number') body.max_tokens = maxTokens;
  if (typeof temperature === 'number') body.temperature = temperature;

  const timeout = timeoutMs ?? config.AI_REQUEST_TIMEOUT_MS;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout),
  });

  if (!response.ok) {
    // Drain the body to free the connection, but never surface its content:
    // upstream bodies can carry sensitive or attacker-controlled data that
    // must not flow into audit reasons or client errors.
    await response.text().catch(() => '');
    throw new Error(`Model provider upstream error (${response.status})`);
  }

  if (!response.body) {
    throw new Error('Model provider upstream returned empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const toolCalls = new Map<number, AccumulatedToolCall>();

  const handleData = function* (data: string): Generator<ProviderEvent, void, unknown> {
    if (data === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return; // Skip malformed frames; never fabricate content.
    }
    const delta = parsed.choices?.[0]?.delta;
    if (typeof delta?.content === 'string' && delta.content.length > 0) {
      yield { type: 'text', content: delta.content };
    }
    const streamedCalls = delta?.tool_calls;
    if (Array.isArray(streamedCalls)) {
      for (const call of streamedCalls) {
        const index = typeof call.index === 'number' ? call.index : 0;
        // Bound the assembly map: a malicious provider must not be able to
        // force unbounded memory via thousands of tool-call indices.
        if (!toolCalls.has(index) && toolCalls.size >= MAX_TOOL_CALLS_PER_TURN) continue;
        const existing = toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof call.id === 'string' && call.id) existing.id = call.id.slice(0, 128);
        if (typeof call.function?.name === 'string' && call.function.name) existing.name = call.function.name.slice(0, 128);
        if (typeof call.function?.arguments === 'string' && existing.arguments.length < MAX_TOOL_ARGUMENT_CHARS) {
          existing.arguments += call.function.arguments.slice(0, MAX_TOOL_ARGUMENT_CHARS - existing.arguments.length);
        }
        toolCalls.set(index, existing);
      }
    }
    const usage = parsed.usage;
    if (usage && typeof usage === 'object') {
      yield {
        type: 'usage',
        usage: {
          promptTokens: toNonNegativeInt(usage.prompt_tokens),
          completionTokens: toNonNegativeInt(usage.completion_tokens),
          totalTokens: toNonNegativeInt(usage.total_tokens),
        },
      };
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
        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            buffer = '';
            break;
          }
          yield* handleData(data);
        }
      }
    }

    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      yield* handleData(tail.slice(5).trim());
    }
  } finally {
    reader.releaseLock();
  }

  for (const call of [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call)) {
    if (call.name) {
      yield { type: 'tool_call', id: call.id || randomUUID(), name: call.name, arguments: call.arguments };
    }
  }
}
