/**
 * claudeWebSearch.test.ts — Claude's native server-side web_search tool.
 *
 * Mock HTTP only: no network, no Anthropic. Covers:
 * - enableNativeWebSearch appends the web_search server tool to the
 *   request (alongside client tools, or alone with tool_choice auto).
 * - The tool is absent when the flag is not set (local/privacy default).
 * - server_tool_use blocks surface as `server_tool` events — never as
 *   client tool_call events the agentic loop would try to execute.
 * - web_search_tool_result blocks don't break the stream; the synthesized
 *   text answer still streams.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeProvider } from '../src/ai/providers/claude.js';

const SECRET = '<redacted>';

function sseResponse(chunks: string[]): Response {
  return new Response(chunks.join(''), {
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
    messages: [{ role: 'user', content: 'What happened in tech today?' }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native web_search tool', () => {
  it('appends the web_search server tool when enableNativeWebSearch is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions({ enableNativeWebSearch: true }));

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tools).toHaveLength(1);
    expect(body.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
    expect(body.tools[0].max_uses).toBeGreaterThan(0);
    expect(body.tool_choice).toEqual({ type: 'auto' });
  });

  it('combines the server tool with client tools', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const clientTool = {
      type: 'function',
      function: { name: 'repo.readFile', description: 'read', parameters: { type: 'object' } },
    };
    await collect(provider, baseOptions({ tools: [clientTool], enableNativeWebSearch: true }));

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tools).toHaveLength(2);
    expect(body.tools[0]).toMatchObject({ name: 'repo.readFile' });
    expect(body.tools[1]).toMatchObject({ type: 'web_search_20250305', name: 'web_search' });
  });

  it('does not send the web_search tool when the flag is unset (local/privacy default)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse([])) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    await collect(provider, baseOptions());

    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
  });

  it('surfaces server_tool_use as a server_tool event, never as a client tool_call', async () => {
    const chunks = [
      sseEvent('message_start', { message: { usage: { input_tokens: 10 } } }),
      sseEvent('content_block_start', { index: 0, content_block: { type: 'server_tool_use', id: 'srv_1', name: 'web_search' } }),
      sseEvent('content_block_start', {
        index: 1,
        content_block: { type: 'web_search_tool_result', tool_use_id: 'srv_1', content: [{ type: 'web_search_result', title: 'News' }] },
      }),
      sseEvent('content_block_delta', { index: 2, delta: { type: 'text_delta', text: 'Here is what happened.' } }),
      sseEvent('message_delta', { usage: { output_tokens: 5 } }),
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(sseResponse(chunks)) as never;
    const provider = new ClaudeProvider({ endpoint: 'https://api.anthropic.com', apiKey: SECRET, defaultTimeoutMs: 10000 });
    const events = await collect(provider, baseOptions({ enableNativeWebSearch: true }));

    const serverTools = events.filter((e) => e.type === 'server_tool');
    const toolCalls = events.filter((e) => e.type === 'tool_call');
    expect(serverTools).toEqual([{ type: 'server_tool', name: 'web_search' }]);
    // The agentic loop must never try to execute a provider-side search.
    expect(toolCalls).toEqual([]);
    // The synthesized answer still streams as text.
    expect(events.filter((e) => e.type === 'text').map((e) => e.content).join('')).toBe('Here is what happened.');
  });
});
