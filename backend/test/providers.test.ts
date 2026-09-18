import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Provider tests run against mock HTTP only: no network, no Ollama, no
// vLLM. Real-provider behavior is marked REQUIRES REAL GPU/PRODUCTION
// INFRASTRUCTURE and is exercised in CI only through these doubles.

import { OpenAICompatibleProvider } from '../src/ai/providers/openaiCompatible.js';
import { OpenAICompatibleEmbeddingProvider } from '../src/ai/providers/openaiEmbeddings.js';
import { OllamaProvider } from '../src/ai/providers/ollama.js';
import {
  isKnownChatProvider,
  resolveChatProvider,
  resolveEmbeddingProvider,
} from '../src/ai/providers/factory.js';
import {
  assertAllowedModelSource,
  listLocalModels,
  pullLocalModel,
} from '../src/ai/artifacts.js';
import { config } from '../src/config.js';
import type { StreamChatOptions } from '../src/ai/providers/types.js';

const originalFetch = globalThis.fetch;

function sseResponse(chunks: string[], status = 200) {
  const body = chunks.map((c) => `data: ${c}\n\n`).join('') + 'data: [DONE]\n\n';
  return new Response(body, { status, headers: { 'Content-Type': 'text/event-stream' } });
}

function chatOptions(overrides: Partial<StreamChatOptions> = {}): StreamChatOptions {
  return {
    endpoint: 'http://vllm.test/v1',
    model: 'test-model',
    messages: [{ role: 'user', content: 'hello' }],
    ...overrides,
  };
}

function modelRef(provider: string) {
  return {
    provider,
    endpoint: 'http://vllm.test/v1',
    model_identifier: 'test-model',
    request_timeout_ms: null,
    max_tokens: null,
    temperature: null,
  };
}

/** Assert a synchronous function throws an AppError with the expected code. */
function expectThrowCode(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }
  throw new Error(`expected throw with code ${code}, but nothing threw`);
}

beforeEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('OpenAICompatibleProvider (private vLLM path)', () => {
  function makeProvider() {
    return new OpenAICompatibleProvider({
      endpoint: 'http://vllm.test/v1',
      apiKey: 'key',
      defaultTimeoutMs: 5000,
    });
  }

  it('streams content chunks and emits usage at the end', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { content: 'Hello' }, index: 0 }] }),
        JSON.stringify({
          choices: [{ delta: { content: ' world' }, finish_reason: 'stop', index: 0 }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      ])
    ) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) events.push(event);
    const text = events.filter((e) => e.type === 'text').map((e) => e.content).join('');
    expect(text).toBe('Hello world');
    expect(events).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    });
    const request = (globalThis.fetch as any).mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ model: 'test-model', stream: true });
    expect(request.headers['Authorization']).toBe('Bearer key');
  });

  it('assembles parallel tool calls from streaming fragments', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{"q":' } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"hi"}' } }] }, index: 0 }] }),
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'lookup', arguments: '{}' } }] }, finish_reason: 'tool_calls', index: 0 }],
        }),
      ])
    ) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) events.push(event);
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({ id: 'call_1', name: 'search', arguments: '{"q":"hi"}' });
    expect(toolCalls[1]).toMatchObject({ id: 'call_2', name: 'lookup', arguments: '{}' });
  });

  it('passes malformed tool-call arguments through as a raw string for the gateway to reject', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: '{oops' } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }),
      ])
    ) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) events.push(event);
    // The provider never fabricates or repairs: the raw string flows to the
    // gateway, which JSON-parses and records a tool execution failure.
    expect(events).toContainEqual({ type: 'tool_call', id: 'call_1', name: 'search', arguments: '{oops' });
  });

  it('truncates a runaway tool-call argument buffer instead of growing forever', async () => {
    const big = 'x'.repeat(70_000);
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'f', arguments: big } }] }, index: 0 }] }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }),
      ])
    ) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) events.push(event);
    const call = events.find((e) => e.type === 'tool_call');
    expect(call.arguments).toHaveLength(65536);
  });

  it('bounds the number of tool-call indices a malicious provider can open', async () => {
    const fragments = Array.from({ length: 40 }, (_, i) =>
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: i, id: `c${i}`, function: { name: 'f', arguments: '{}' } }] }, index: 0 }] })
    );
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(fragments)) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) events.push(event);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(32);
  });

  it('surfaces non-OK responses as upstream errors without retrying the stream', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', { status: 503 }));
    globalThis.fetch = fetchMock as never;
    await expect(async () => {
      for await (const _ of makeProvider().streamChat(chatOptions())) { /* drain */ }
    }).rejects.toThrow('Model provider upstream error (503)');
    // Streaming inference is non-idempotent: exactly one attempt, the
    // gateway fails over to another model instead of retrying.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('ignores SSE comments and non-data lines', async () => {
    const body = ': keep-alive\n\nevent: ping\ndata: ' +
      JSON.stringify({ choices: [{ delta: { content: 'ok' }, index: 0 }] }) +
      '\n\n' +
      'data: [DONE]\n\n';
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 })) as never;
    const texts: string[] = [];
    for await (const event of makeProvider().streamChat(chatOptions())) {
      if (event.type === 'text') texts.push(event.content);
    }
    expect(texts.join('')).toBe('ok');
  });
});

describe('OpenAICompatibleEmbeddingProvider retries', () => {
  const embedOk = (status: number) =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status });
  const makeProvider = () =>
    new OpenAICompatibleEmbeddingProvider({
      endpoint: 'http://embeddings.test',
      model: 'test-embed',
      version: '1',
      dimensions: 2,
      defaultTimeoutMs: 5000,
    });

  it('retries 429/5xx, never 4xx, and aborts surface immediately', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(embedOk(429))
      .mockResolvedValueOnce(embedOk(503))
      .mockResolvedValueOnce(embedOk(200));
    globalThis.fetch = fetchMock as never;
    await expect(makeProvider().embed(['a'])).resolves.toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const fetch4xx = vi.fn().mockResolvedValue(embedOk(400));
    globalThis.fetch = fetch4xx as never;
    await expect(makeProvider().embed(['a'])).rejects.toMatchObject({ code: 'EMBEDDING_PROVIDER_ERROR' });
    expect(fetch4xx).toHaveBeenCalledTimes(1);
  });
});

describe('OllamaProvider (local dev only)', () => {
  function makeProvider() {
    return new OllamaProvider({
      endpoint: 'http://localhost:11434',
      defaultTimeoutMs: 5000,
      embeddingModel: 'nomic-embed-text',
      embeddingDimensions: 2,
    });
  }

  it('parses NDJSON chat responses and translates Ollama tool calls', async () => {
    const ndjson = [
      JSON.stringify({ message: { role: 'assistant', content: 'Hi' }, done: false }),
      JSON.stringify({
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'search', arguments: { q: 'x' } } }],
        },
        done: true,
        prompt_eval_count: 5,
        eval_count: 7,
      }),
    ].join('\n');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 })) as never;
    const events: any[] = [];
    for await (const event of makeProvider().streamChat(chatOptions({ endpoint: 'http://localhost:11434', model: 'llama3.1:8b' }))) {
      events.push(event);
    }
    expect(events.filter((e) => e.type === 'text').map((e) => e.content).join('')).toBe('Hi');
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ name: 'search', arguments: JSON.stringify({ q: 'x' }) });
    expect(typeof toolCall.id).toBe('string');
    expect(events).toContainEqual({ type: 'usage', usage: { promptTokens: 5, completionTokens: 7, totalTokens: 12 } });
    const request = (globalThis.fetch as any).mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ model: 'llama3.1:8b', stream: true });
  });

  it('embeds via asEmbeddingProvider and validates dimensions', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1, 0.2]] }), { status: 200 })
    ) as never;
    const provider = makeProvider().asEmbeddingProvider();
    expect(provider.kind).toBe('ollama');
    expect(provider.model).toBe('nomic-embed-text');
    await expect(provider.embed(['a'])).resolves.toEqual([[0.1, 0.2]]);
  });

  it('rejects dimension mismatches like the OpenAI-compatible path', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ embeddings: [[0.1]] }), { status: 200 })
    ) as never;
    await expect(makeProvider().asEmbeddingProvider().embed(['a'])).rejects.toMatchObject({
      code: 'OLLAMA_INVALID_RESPONSE',
    });
  });
});

describe('provider factory gates', () => {
  const originalAllowDev = config.ALLOW_DEV_PROVIDERS;
  const originalEmbeddingProvider = config.EMBEDDING_PROVIDER;
  const originalBaseUrl = config.EMBEDDING_BASE_URL;
  const originalEmbeddingModel = config.EMBEDDING_MODEL;

  beforeEach(() => {
    config.ALLOW_DEV_PROVIDERS = false;
    config.EMBEDDING_PROVIDER = 'openai-compatible';
  });

  afterEach(() => {
    config.ALLOW_DEV_PROVIDERS = originalAllowDev;
    config.EMBEDDING_PROVIDER = originalEmbeddingProvider;
    config.EMBEDDING_BASE_URL = originalBaseUrl;
    config.EMBEDDING_MODEL = originalEmbeddingModel;
  });

  it('resolves the default vllm provider in production', () => {
    expect(resolveChatProvider(modelRef('vllm')).kind).toBe('openai-compatible');
    expect(resolveChatProvider(modelRef('openai-compatible')).kind).toBe('openai-compatible');
  });

  it('refuses ollama in production even when the model record says ollama', () => {
    expectThrowCode(() => resolveChatProvider(modelRef('ollama')), 'MODEL_PROVIDER_DEV_ONLY');
  });

  it('rejects unknown providers', () => {
    expectThrowCode(() => resolveChatProvider(modelRef('mystery')), 'MODEL_PROVIDER_UNSUPPORTED');
  });

  it('knows exactly which provider names are valid', () => {
    expect(isKnownChatProvider('vllm')).toBe(true);
    expect(isKnownChatProvider('openai-compatible')).toBe(true);
    expect(isKnownChatProvider('ollama')).toBe(true);
    expect(isKnownChatProvider('mystery')).toBe(false);
  });

  it('resolves the configured embedding provider from server config', () => {
    config.EMBEDDING_BASE_URL = 'http://embeddings.test';
    config.EMBEDDING_MODEL = 'test-embed';
    expect(resolveEmbeddingProvider().kind).toBe('openai-compatible');
  });

  it('fails closed when the embedding provider is not configured', () => {
    config.EMBEDDING_BASE_URL = '';
    config.EMBEDDING_MODEL = undefined;
    expectThrowCode(() => resolveEmbeddingProvider(), 'EMBEDDING_NOT_CONFIGURED');
  });

  it('fails closed when the embedding provider kind is unknown', () => {
    config.EMBEDDING_PROVIDER = 'nope' as never;
    expectThrowCode(() => resolveEmbeddingProvider(), 'EMBEDDING_PROVIDER_UNKNOWN');
  });

  it('creates the ollama embedding provider only with the dev flag', () => {
    expectThrowCode(() => resolveEmbeddingProvider('ollama'), 'EMBEDDING_PROVIDER_DEV_ONLY');
    config.ALLOW_DEV_PROVIDERS = true;
    expect(resolveEmbeddingProvider('ollama').kind).toBe('ollama');
  });

  it('constructs the ollama chat provider only with the dev flag', () => {
    config.ALLOW_DEV_PROVIDERS = true;
    expect(resolveChatProvider(modelRef('ollama')).kind).toBe('ollama');
  });
});

describe('model artifact controls', () => {
  const originalAllowDev = config.ALLOW_DEV_PROVIDERS;
  const originalNames = config.OLLAMA_ALLOWED_MODELS;
  const originalSources = config.MODEL_SOURCE_ALLOWLIST;

  beforeEach(() => {
    config.ALLOW_DEV_PROVIDERS = true;
    config.OLLAMA_ALLOWED_MODELS = 'llama3.1:8b,nomic-embed-text';
    config.MODEL_SOURCE_ALLOWLIST = 'https://huggingface.co';
  });

  afterEach(() => {
    config.ALLOW_DEV_PROVIDERS = originalAllowDev;
    config.OLLAMA_ALLOWED_MODELS = originalNames;
    config.MODEL_SOURCE_ALLOWLIST = originalSources;
  });

  it('blocks artifact helpers entirely when the dev flag is off', async () => {
    config.ALLOW_DEV_PROVIDERS = false;
    await expect(listLocalModels()).rejects.toMatchObject({ code: 'MODEL_ARTIFACT_DEV_ONLY' });
    await expect(async () => {
      for await (const _ of pullLocalModel('llama3.1:8b')) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MODEL_ARTIFACT_DEV_ONLY' });
  });

  it('refuses to pull a model outside the allowlist', async () => {
    await expect(async () => {
      for await (const _ of pullLocalModel('evil-model:1b')) { /* drain */ }
    }).rejects.toMatchObject({ code: 'MODEL_SOURCE_DENIED' });
  });

  it('lists local Ollama models from /api/tags', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ models: [{ name: 'llama3.1:8b', size: 4700000000 }] }), { status: 200 })
    ) as never;
    await expect(listLocalModels()).resolves.toEqual([
      { name: 'llama3.1:8b', present: true, sizeBytes: 4700000000, details: null },
    ]);
  });

  it('streams pull progress from /api/pull', async () => {
    const ndjson = [
      JSON.stringify({ status: 'pulling manifest' }),
      JSON.stringify({ status: 'success' }),
    ].join('\n');
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(ndjson, { status: 200 })) as never;
    const seen: string[] = [];
    for await (const progress of pullLocalModel('llama3.1:8b')) seen.push(progress.status);
    expect(seen).toEqual(['pulling manifest', 'success']);
    const request = (globalThis.fetch as any).mock.calls[0][1];
    expect(JSON.parse(request.body)).toMatchObject({ name: 'llama3.1:8b', stream: true });
  });

  it('accepts allowlisted model sources and rejects everything else', () => {
    expect(() => assertAllowedModelSource('https://huggingface.co/meta-llama/x')).not.toThrow();
    expect(() => assertAllowedModelSource(null)).not.toThrow();
    expectThrowCode(() => assertAllowedModelSource('https://evil.example/x'), 'MODEL_SOURCE_DENIED');
    expectThrowCode(() => assertAllowedModelSource('not-a-url'), 'MODEL_SOURCE_INVALID');
  });
});
