/**
 * ollamaUnreachable.test.ts — when Ollama isn't reachable, the failure must
 * be a distinct, actionable error — never a bare "fetch failed" (which
 * surfaces in the UI as the cryptic "Failed to fetch").
 *
 * Deterministic: the network boundary (global fetch) is stubbed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/errors.js';
import { OllamaProvider } from '../src/ai/providers/ollama.js';

const ENDPOINT = 'http://ollama:11434';

function provider() {
  return new OllamaProvider({
    endpoint: ENDPOINT,
    defaultTimeoutMs: 1000,
    embeddingModel: 'nomic-embed-text',
    embeddingDimensions: 768,
  });
}

async function drainStreamChat(p: OllamaProvider, options?: { signal?: AbortSignal }) {
  const stream = p.streamChat({
    endpoint: ENDPOINT,
    model: 'llama3.1:8b',
    messages: [{ role: 'user', content: 'Hello' }],
    ...options,
  });
  for await (const _event of stream) {
    // consume
  }
}

function networkFailure(): TypeError {
  // What undici throws for connection refused / DNS failure / no listener.
  return new TypeError('fetch failed');
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Ollama unreachable', () => {
  it('chat maps a network failure to OLLAMA_UNREACHABLE naming the endpoint', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw networkFailure(); }));
    const error = await drainStreamChat(provider()).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'OLLAMA_UNREACHABLE' });
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain(ENDPOINT);
    expect(error.message).toContain('Ollama');
    expect(error.details).toMatchObject({ endpoint: ENDPOINT });
  });

  it('embeddings map a network failure to OLLAMA_UNREACHABLE too', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw networkFailure(); }));
    const error = await provider().asEmbeddingProvider().embed(['hello']).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'OLLAMA_UNREACHABLE' });
    expect(error.statusCode).toBe(502);
    expect(error.message).toContain(ENDPOINT);
  });

  it('does not convert deliberate aborts into unreachable errors', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw networkFailure(); }));
    const error = await drainStreamChat(provider(), { signal: controller.signal }).catch((e) => e);
    // The original error propagates untouched: cancellation keeps its own
    // semantics and must not look like a downed server.
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(AppError);
  });

  it('keeps HTTP upstream errors on their existing code (not unreachable)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('boom', { status: 500 }))
    );
    const error = await drainStreamChat(provider()).catch((e) => e);
    expect(error).toBeInstanceOf(AppError);
    expect(error).toMatchObject({ code: 'OLLAMA_UPSTREAM_ERROR' });
  });

  it('the unreachable error is an AppError, so the chat pipeline forwards its message to the client', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw networkFailure(); }));
    const error = await drainStreamChat(provider()).catch((e) => e);
    // agenticLoop forwards AppError messages verbatim through the SSE
    // 'error' event; non-AppErrors become the generic 'Model request failed'.
    expect(error).toBeInstanceOf(AppError);
    expect(error.message).not.toBe('Model request failed');
  });
});
