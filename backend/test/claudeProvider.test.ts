/**
 * claudeProvider.test.ts — Anthropic Messages API provider.
 *
 * Mock HTTP only: no network, no Anthropic. Covers the request payload
 * mapping (system hoisting, tool_result blocks, image blocks, max_tokens
 * default), the SSE event mapping (text deltas, tool_use assembly, usage),
 * and the key-redaction rule (the API key never appears in errors).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../src/ai/providers/claude.js';

const SECRET = 'sk-ant-test-key-DO-NOT-LOG';

function sseResponse(chunks: string[]): Response {
  const body = chunks.join('');
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

async function collect(provider: ClaudeProvider, options: any): Promise<any[]> {
  const events: any[] = [];
  for await (const event of provider.streamChat(options)) {
    events.push(event);
  }
  return events;
}

function baseOptions(overrides: any = {}): any {
  return {
    endpoint: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-20250514',
    messages: [{ role: 'user', content: 'Hello' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ClaudeProvider request payload', () => {
  it('posts to /v1/messages with the Anthropic headers and model', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions());

    const [url, init] = (globalThis.fetch as any).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers['x-api-key']).toBe(SECRET);
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-sonnet-4-20250514');
    expect(body.stream).toBe(true);
  });

  it('defaults max_tokens to 4096 when the caller does not set one', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions());
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.max_tokens).toBe(4096);
  });

  it('hoists system messages to the top-level system parameter', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions({
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi' },
      ],
    }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.system).toBe('You are helpful.');
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true);
  });

  it('maps tool messages to tool_result blocks and images to image blocks', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions({
      messages: [
        { role: 'user', content: 'What is this?', images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }] },
        { role: 'assistant', content: '', tool_calls: [{ id: 't1', function: { name: 'lookup', arguments: '{"q":1}' } }] },
        { role: 'tool', tool_call_id: 't1', content: 'result!' },
      ],
    }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    const userBlocks = body.messages[0].content;
    expect(userBlocks).toContainEqual({ type: 'text', text: 'What is this?' });
    // Anthropic image block: base64 source with media type (ADR-018).
    expect(userBlocks).toContainEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
    });
    const assistantBlocks = body.messages[1].content;
    expect(assistantBlocks).toContainEqual({
      type: 'tool_use', id: 't1', name: 'lookup', input: { q: 1 },
    });
    const toolResult = body.messages[2];
    expect(toolResult.role).toBe('user');
    expect(toolResult.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 't1', content: 'result!' });
  });

  it('sends tools with tool_choice auto when provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions({
      tools: [{ function: { name: 'lookup', description: 'Look up', parameters: { type: 'object' } } }],
    }));
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tools[0]).toMatchObject({ name: 'lookup', input_schema: { type: 'object' } });
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });
});

describe('ClaudeProvider SSE mapping', () => {
  it('yields text events from content_block_delta frames', async () => {
    const chunks = [
      sseEvent('message_start', { message: { usage: { input_tokens: 12 } } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }),
      sseEvent('message_delta', { usage: { output_tokens: 5 } }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks)) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const events = await collect(provider, baseOptions());

    expect(events.filter((e) => e.type === 'text').map((e) => e.content).join('')).toBe('Hello');
    const usage = events.find((e) => e.type === 'usage');
    expect(usage.usage).toMatchObject({ promptTokens: 12, completionTokens: 5, totalTokens: 17 });
  });

  it('assembles tool calls from tool_use blocks and input_json deltas', async () => {
    const chunks = [
      sseEvent('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'lookup' } }),
      sseEvent('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }),
      sseEvent('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '42}' } }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks)) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const events = await collect(provider, baseOptions());
    const toolCall = events.find((e) => e.type === 'tool_call');
    expect(toolCall).toMatchObject({ id: 'tu_1', name: 'lookup', arguments: '{"q":42}' });
  });

  it('skips malformed frames without fabricating content', async () => {
    const chunks = [
      'event: content_block_delta\ndata: not-json\n\n',
      sseEvent('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'ok' } }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks)) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const events = await collect(provider, baseOptions());
    expect(events.filter((e) => e.type === 'text').map((e) => e.content).join('')).toBe('ok');
  });
});

describe('ClaudeProvider key redaction', () => {
  it('drains the upstream body but never surfaces it or the key in errors', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(`{"error":{"message":"bad key ${SECRET}"}}`, { status: 401 }),
    ) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const error = (await collect(provider, baseOptions()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain(SECRET);
    expect(error.message).toContain('401');
  });
});
