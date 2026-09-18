/**
 * providers/ollama.ts — Ollama provider for LOCAL DEVELOPMENT.
 *
 * DEV-ONLY. Ollama is a convenience for running models on a developer
 * workstation. It is NOT a security boundary and must never serve
 * production traffic: the factory refuses to construct this provider
 * unless ALLOW_DEV_PROVIDERS is explicitly enabled, and the gateway
 * additionally rejects `ollama`-backed models outside development.
 *
 * Like every provider, this class is constructed with explicit connection
 * parameters and never reads process env.
 */
import { randomUUID } from 'node:crypto';
import type {
  ChatMessage,
  EmbeddingProvider,
  EmbedArg,
  ModelProvider,
  ProviderEvent,
  ProviderToolDefinition,
  StreamChatOptions,
  TokenUsage,
} from './types.js';
import { normalizeEmbedArg } from './types.js';
import { Errors } from '../../errors.js';

export interface OllamaProviderConfig {
  endpoint: string;
  defaultTimeoutMs: number;
  /** Embedding model name for asEmbeddingProvider(). */
  embeddingModel: string;
  embeddingDimensions: number;
}

/** Ollama /api/chat message shape (subset we use). */
interface OllamaChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
}

function toOpenAIMessages(messages: ChatMessage[]): OllamaChatMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : '',
    ...(m.tool_calls?.length
      ? {
          tool_calls: m.tool_calls.map((tc) => {
            let args: Record<string, unknown> = {};
            try {
              args = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
            } catch {
              args = {};
            }
            return { function: { name: tc.function.name, arguments: args } };
          }),
        }
      : {}),
  }));
}

function toOllamaTools(tools: ProviderToolDefinition[] | undefined) {
  if (!tools?.length) return undefined;
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

export class OllamaProvider implements ModelProvider {
  readonly kind = 'ollama';
  private readonly embedding: EmbeddingProvider;

  constructor(private readonly config: OllamaProviderConfig) {
    const endpoint = config.endpoint;
    const embeddingModel = config.embeddingModel;
    const embeddingDimensions = config.embeddingDimensions;
    const defaultTimeoutMs = config.defaultTimeoutMs;
    this.embedding = {
      kind: 'ollama',
      model: embeddingModel,
      version: 'ollama',
      dimensions: embeddingDimensions,
      async embed(texts: string[], arg?: EmbedArg): Promise<number[][]> {
        if (texts.length === 0) return [];
        const options = normalizeEmbedArg(arg);
        const timeout = options.timeoutMs ?? defaultTimeoutMs;
        const response = await fetch(`${endpoint.replace(/\/+$/, '')}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: embeddingModel, input: texts }),
          signal: options.signal
            ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
            : AbortSignal.timeout(timeout),
        });
        if (!response.ok) {
          await response.text().catch(() => '');
          throw Errors.internal('Ollama embeddings upstream error', { status: response.status }, 'OLLAMA_UPSTREAM_ERROR');
        }
        const payload = (await response.json()) as { embeddings?: number[][] };
        const embeddings = payload.embeddings ?? [];
        if (
          embeddings.length !== texts.length ||
          embeddings.some((e) => !Array.isArray(e) || e.length !== embeddingDimensions || !e.every(Number.isFinite))
        ) {
          throw Errors.internal('Ollama embeddings returned invalid dimensions', undefined, 'OLLAMA_INVALID_RESPONSE');
        }
        return embeddings;
      },
    };
  }

  asEmbeddingProvider(): EmbeddingProvider {
    return this.embedding;
  }

  /**
   * Streams an Ollama chat completion as provider events. Ollama streams
   * newline-delimited JSON (`/api/chat` with `stream: true`); each line
   * carries `message.content` deltas and, at the end, `eval_count` /
   * `prompt_eval_count` token counts. Exactly one attempt per call — no
   * retries on streaming inference, same rule as every chat provider.
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
    const url = `${base}/api/chat`;
    const body: Record<string, unknown> = {
      model,
      messages: toOpenAIMessages(messages),
      stream: true,
    };
    const ollamaTools = toOllamaTools(tools);
    if (ollamaTools) body.tools = ollamaTools;
    const options: Record<string, unknown> = {};
    if (typeof maxTokens === 'number') options.num_predict = maxTokens;
    if (typeof temperature === 'number') options.temperature = temperature;
    if (Object.keys(options).length > 0) body.options = options;

    const timeout = timeoutMs ?? this.config.defaultTimeoutMs;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });

    if (!response.ok) {
      await response.text().catch(() => '');
      throw Errors.internal('Ollama chat upstream error', { status: response.status }, 'OLLAMA_UPSTREAM_ERROR');
    }
    if (!response.body) {
      throw new Error('Ollama upstream returned empty response body');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];

    // Handle one NDJSON line: content deltas stream as text, tool calls
    // accumulate for emission after the stream, and the done frame yields
    // usage. Malformed lines are skipped, never fabricated.
    const handleLine = function* (line: string): Generator<ProviderEvent, void, unknown> {
      const trimmed = line.trim();
      if (!trimmed) return;
      let parsed: {
        message?: { content?: unknown; tool_calls?: Array<{ function?: { name?: unknown; arguments?: unknown } }> };
        done?: unknown;
        prompt_eval_count?: unknown;
        eval_count?: unknown;
      };
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        return;
      }
      const message = parsed.message;
      if (message && typeof message.content === 'string' && message.content.length > 0) {
        yield { type: 'text', content: message.content };
      }
      if (Array.isArray(message?.tool_calls)) {
        for (const tc of message.tool_calls) {
          const name = tc?.function?.name;
          if (typeof name === 'string' && name) {
            toolCalls.push({
              id: randomUUID(),
              name: name.slice(0, 128),
              arguments: JSON.stringify(tc.function?.arguments ?? {}).slice(0, 65536),
            });
          }
        }
      }
      if (parsed.done === true) {
        const usage: TokenUsage = {
          promptTokens:
            typeof parsed.prompt_eval_count === 'number' && parsed.prompt_eval_count >= 0
              ? Math.floor(parsed.prompt_eval_count)
              : 0,
          completionTokens:
            typeof parsed.eval_count === 'number' && parsed.eval_count >= 0 ? Math.floor(parsed.eval_count) : 0,
          totalTokens: 0,
        };
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
        yield { type: 'usage', usage };
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
          yield* handleLine(line);
        }
      }
      // Flush a final line that was not newline-terminated: chunking must
      // not silently drop the done/usage frame or the last tool calls.
      if (buffer.trim()) {
        yield* handleLine(buffer);
      }
    } finally {
      reader.releaseLock();
    }

    for (const call of toolCalls) {
      yield { type: 'tool_call', ...call };
    }
  }
}
