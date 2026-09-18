import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat } from '../src/ai/gateway/vllmProvider.js';

function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function chatChunk(delta: unknown, usage?: unknown): string {
  return `data: ${JSON.stringify({ choices: [{ delta }], ...(usage ? { usage } : {}) })}\n\n`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('streamChat SSE parsing', () => {
  it('yields text deltas and stops at [DONE]', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([chatChunk({ content: 'Hello' }), chatChunk({ content: ' world' }), 'data: [DONE]\n\n'])
    ));
    const events: unknown[] = [];
    for await (const event of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'text', content: 'Hello' },
      { type: 'text', content: ' world' },
    ]);
  });

  it('accumulates tool_calls across frames and emits them after the stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        chatChunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'syteline.getItem', arguments: '{"item":' } }] }),
        chatChunk({ tool_calls: [{ index: 0, function: { arguments: '"ABC","site":"MAIN"}' } }] }),
        chatChunk({ tool_calls: [{ index: 1, id: 'call_2', type: 'function', function: { name: 'syteline.getItem', arguments: '{"item":"XYZ"}' } }] }),
        'data: [DONE]\n\n',
      ])
    ));
    const events: unknown[] = [];
    for await (const event of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: 'tool_call', id: 'call_1', name: 'syteline.getItem', arguments: '{"item":"ABC","site":"MAIN"}' },
      { type: 'tool_call', id: 'call_2', name: 'syteline.getItem', arguments: '{"item":"XYZ"}' },
    ]);
  });

  it('emits token usage when the provider includes it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        chatChunk({ content: 'hi' }),
        chatChunk({}, { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 }),
        'data: [DONE]\n\n',
      ])
    ));
    const events: unknown[] = [];
    for await (const event of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) {
      events.push(event);
    }
    expect(events).toContainEqual({
      type: 'usage',
      usage: { promptTokens: 12, completionTokens: 3, totalTokens: 15 },
    });
  });

  it('skips malformed frames and SSE comments instead of failing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseResponse([
        ': comment line\n\n',
        'data: {not valid json}\n\n',
        'data: {"choices": "nope"}\n\n',
        chatChunk({ content: 'ok' }),
        'data: [DONE]\n\n',
      ])
    ));
    const events: unknown[] = [];
    for await (const event of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'text', content: 'ok' }]);
  });

  it('throws a descriptive error on upstream HTTP failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 503 })));
    await expect(
      (async () => {
        for await (const _ of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) { /* drain */ }
      })()
    ).rejects.toThrow('Model provider upstream error (503)');
  });

  it('sends tools, max_tokens, and temperature when configured', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    const tools = [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: {} } }];
    for await (const _ of streamChat({
      endpoint: 'http://localhost:8000/v1/', model: 'm', messages: [], tools, maxTokens: 100, temperature: 0.5,
    })) { /* drain */ }
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/v1/chat/completions');
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({ tools, tool_choice: 'auto', max_tokens: 100, temperature: 0.5, stream: true });
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('omits the Authorization header when no API key is configured', async () => {
    const fetchMock = vi.fn(async () => sseResponse(['data: [DONE]\n\n']));
    vi.stubGlobal('fetch', fetchMock);
    for await (const _ of streamChat({ endpoint: 'http://localhost:8000/v1', model: 'm', messages: [] })) { /* drain */ }
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['Authorization']).toBeUndefined();
  });
});
