/**
 * providers/openaiEmbeddings.ts — OpenAI-compatible HTTP embedding provider.
 *
 * This is the PRODUCTION embedding path: vLLM's `/v1/embeddings` endpoint
 * (or any approved OpenAI-compatible embedding endpoint) is reached through
 * this provider. It is the single place embedding HTTP happens; document
 * ingestion and RAG retrieval both resolve their provider through the
 * factory, never ad-hoc fetch calls.
 *
 * Embeddings are idempotent (same input -> same output, no side effects),
 * so a small bounded retry with jitter is safe here — unlike streaming
 * inference, which the gateway never retries and instead fails over.
 */
import type { EmbeddingProvider, EmbedArg, EmbedOptions } from './types.js';
import { normalizeEmbedArg } from './types.js';
import { Errors } from '../../errors.js';

export interface OpenAIEmbeddingProviderConfig {
  endpoint: string;
  apiKey?: string;
  model: string;
  version: string;
  dimensions: number;
  defaultTimeoutMs: number;
}

async function fetchWithRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Never retry after cancellation: an aborted job must stop immediately.
    if (init.signal?.aborted) throw new Error('Embedding request aborted');
    try {
      const response = await fetch(input, init);
      // Retry transient 5xx/429; 4xx is deterministic (bad request) and surfaces.
      if ((response.status >= 500 || response.status === 429) && attempt < attempts) {
        await response.arrayBuffer().catch(() => undefined);
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
      // AbortError (cancellation/timeout) is not transient: rethrow at once.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (attempt === attempts) throw error;
    }
    const backoffMs = Math.min(2000, 150 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
    // Abort-aware sleep: a cancelled job must not linger in backoff.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Embedding request aborted'));
      };
      const timer = setTimeout(() => {
        init.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, backoffMs);
      init.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw lastError instanceof Error ? lastError : new Error('Embedding provider request failed');
}

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly kind = 'openai-compatible';
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;

  constructor(private readonly config: OpenAIEmbeddingProviderConfig) {
    this.model = config.model;
    this.version = config.version;
    this.dimensions = config.dimensions;
  }

  async embed(texts: string[], arg?: EmbedArg): Promise<number[][]> {
    if (texts.length === 0) return [];
    const options: EmbedOptions = normalizeEmbedArg(arg);
    const timeout = options.timeoutMs ?? this.config.defaultTimeoutMs;
    const response = await fetchWithRetry(`${this.config.endpoint.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.apiKey ? { authorization: `Bearer ${this.config.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
      signal: options.signal
        ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout)])
        : AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      await response.text().catch(() => '');
      throw Errors.internal('Embedding provider request failed', { status: response.status }, 'EMBEDDING_PROVIDER_ERROR');
    }
    const payload = (await response.json()) as { data?: Array<{ embedding?: number[]; index?: number }> };
    const ordered = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (
      ordered.length !== texts.length ||
      ordered.some(
        (item) =>
          !Array.isArray(item.embedding) ||
          item.embedding.length !== this.config.dimensions ||
          !item.embedding.every(Number.isFinite)
      )
    ) {
      throw Errors.internal('Embedding provider returned invalid dimensions', undefined, 'INVALID_EMBEDDING_RESPONSE');
    }
    return ordered.map((item) => item.embedding!);
  }
}
