/**
 * openaiProvider.test.ts — first-class OpenAI cloud provider.
 *
 * The OpenAI provider subclasses the tested OpenAI-compatible wire
 * protocol; these tests pin what makes it first-class: its registry kind,
 * the Bearer <redacted> header, the OpenAI default endpoint, and vision
 * image parts (data: URLs) for image turns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenAIProvider } from '../src/ai/providers/openai.js';
import { resolveChatProvider } from '../src/ai/providers/factory.js';

const SECRET = 'sk-openai-test-key-DO-NOT-LOG';

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function modelRef(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    endpoint: 'https://api.openai.com/v1',
    modelIdentifier: 'gpt-4o',
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    ...overrides,
  };
}

describe('OpenAIProvider', () => {
  it('registers as the "openai" provider kind', () => {
    const provider = new OpenAIProvider({ endpoint: 'https://api.openai.com/v1', apiKey: SECRET, defaultTimeoutMs: 10000 });
    expect(provider.kind).toBe('openai');
  });

  it('sends the key as a Bearer <redacted> and maps images to data: URL parts', async () => {
    const chunk = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([chunk, 'data: [DONE]\n\n'])) as never;
    const provider = new OpenAIProvider({ endpoint: 'https://api.openai.com/v1', apiKey: SECRET, defaultTimeoutMs: 10000 });

    const events: any[] = [];
    for await (const event of provider.streamChat({
      endpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'See?', images: [{ mimeType: 'image/jpeg', data: 'aGVsbG8=' }] }],
    })) {
      events.push(event);
    }

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe(`Bearer ${SECRET}`);
    const body = JSON.parse(init.body);
    expect(body.model).toBe('gpt-4o');
    const parts = body.messages[0].content;
    expect(parts).toContainEqual({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,aGVsbG8=' },
    });
    expect(events.some((e) => e.type === 'text' && e.content === 'hi')).toBe(true);
  });
});

describe('factory: cloud providers', () => {
  it('resolves the claude kind to a ClaudeProvider', () => {
    const provider = resolveChatProvider(modelRef({ provider: 'claude', endpoint: 'https://api.anthropic.com' }));
    expect(provider.kind).toBe('claude');
  });

  it('resolves the openai kind to an OpenAIProvider (not the generic one)', () => {
    const provider = resolveChatProvider(modelRef());
    expect(provider.kind).toBe('openai');
  });

  it('still rejects unknown provider kinds', () => {
    try {
      resolveChatProvider(modelRef({ provider: 'mystery' }));
      expect.unreachable('should have thrown');
    } catch (error: any) {
      expect(error.code).toBe('MODEL_PROVIDER_UNSUPPORTED');
    }
  });
});
