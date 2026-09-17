import { config } from '../../config.js';

export interface ChatMessage {
  role: string;
  content: string;
}

export interface StreamChatOptions {
  endpoint: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
}

export async function* streamChat({
  endpoint,
  model,
  messages,
  signal,
}: StreamChatOptions): AsyncGenerator<string, void, unknown> {
  const url = `${endpoint.replace(/\/+$/, '')}/chat/completions`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (config.VLLM_API_KEY && config.VLLM_API_KEY.trim().length > 0) {
    headers['Authorization'] = `Bearer ${config.VLLM_API_KEY}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => '');
    throw new Error(`vLLM upstream error (${response.status}): ${errorText}`);
  }

  if (!response.body) {
    throw new Error('vLLM upstream returned empty response body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

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

        if (trimmed.startsWith('data: ')) {
          const data = trimmed.slice(6).trim();
          if (data === '[DONE]') {
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          } catch {
            // Ignore parse errors on individual SSE frames
          }
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6).trim();
        if (data !== '[DONE]') {
          try {
            const parsed = JSON.parse(data);
            const delta = parsed.choices?.[0]?.delta?.content;
            if (typeof delta === 'string' && delta.length > 0) {
              yield delta;
            }
          } catch {
            // Ignore
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
