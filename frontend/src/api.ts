import type { AuthUser, Citation, DataClassification, DocumentRecord, RagResult, TokenUsage } from './types';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '/api/v1').replace(/\/+$/, '');
let accessToken: string | null = null;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function parseError(response: Response): Promise<ApiError> {
  const body = await response.json().catch(() => ({})) as { error?: { code?: string; message?: string } };
  return new ApiError(response.status, body.error?.code ?? 'REQUEST_FAILED', body.error?.message ?? 'Request failed');
}

async function doRefresh(): Promise<AuthUser | null> {
  const response = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!response.ok) {
    accessToken = null;
    return null;
  }
  const body = await response.json() as { accessToken: string; user: AuthUser };
  accessToken = body.accessToken;
  return body.user;
}

/**
 * Shared in-flight refresh: concurrent 401s (or overlapping refresh calls)
 * trigger a single /auth/refresh request instead of one per caller.
 */
let refreshPromise: Promise<AuthUser | null> | null = null;
function refresh(): Promise<AuthUser | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => { refreshPromise = null; });
  }
  return refreshPromise;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  const response = await fetch(`${API_BASE}${path}`, { ...init, headers, credentials: 'include' });
  if (response.status === 401 && retry && await refresh()) return request<T>(path, init, false);
  if (!response.ok) throw await parseError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export const api = {
  refresh,
  async login(email: string, password: string): Promise<AuthUser> {
    const body = await request<{ accessToken: string; user: AuthUser }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }, false);
    accessToken = body.accessToken;
    return body.user;
  },
  async logout(): Promise<void> {
    try { await request('/auth/logout', { method: 'POST' }, false); } finally { accessToken = null; }
  },
  request,
  async upload(file: File, classification?: DataClassification): Promise<DocumentRecord> {
    const form = new FormData();
    if (classification) form.append('classification', classification);
    form.append('file', file, file.name);
    const body = await request<{ document: any }>('/documents', { method: 'POST', body: form });
    return mapDocument(body.document);
  },
  async documents(): Promise<DocumentRecord[]> {
    const body = await request<{ documents: any[] }>('/documents');
    return body.documents.map(mapDocument);
  },
  async document(id: string, signal?: AbortSignal): Promise<DocumentRecord> {
    const body = await request<{ document: any }>(`/documents/${id}`, { signal });
    return mapDocument(body.document);
  },
  async retryDocument(id: string): Promise<void> {
    await request(`/documents/${id}/retry`, { method: 'POST' });
  },
  async deleteDocument(id: string): Promise<void> {
    await request(`/documents/${id}`, { method: 'DELETE' });
  },
  async classifyDocument(id: string, classification: DataClassification): Promise<void> {
    await request(`/documents/${id}/classification`, { method: 'PATCH', body: JSON.stringify({ classification }) });
  },
  async ragSearch(query: string, documentIds?: string[]): Promise<RagResult[]> {
    const body = await request<{ results: RagResult[] }>('/rag/search', {
      method: 'POST', body: JSON.stringify({ query, documentIds, topK: 8 }),
    });
    return body.results;
  },
};

export function mapDocument(value: any): DocumentRecord {
  return {
    id: value.id,
    filename: value.filename,
    mimeType: value.mime_type,
    sizeBytes: Number(value.size_bytes),
    classification: value.classification,
    status: value.status,
    errorCode: value.error_code ?? undefined,
    createdAt: new Date(value.created_at),
    updatedAt: new Date(value.updated_at),
  };
}

/* ------------------------------------------------------------------ */
/* Typed SSE payloads with runtime guards                              */
/* ------------------------------------------------------------------ */

export interface StreamMetaData {
  conversationId?: string;
  model?: { id: string; name: string };
  contextDropped?: boolean;
}

export interface StreamDeltaData {
  content: string;
}

export interface StreamNoticeData {
  code?: string;
  message: string;
}

export interface StreamDoneData {
  finishReason?: string;
  citations?: Citation[];
  usage?: TokenUsage;
  fallback?: { id: string; name: string };
}

export interface StreamErrorData {
  code: string;
  message: string;
  requestId?: string;
}

/** Payload for bare `data:` frames, which per the SSE spec default to the
 *  "message" event type. */
export interface StreamMessageData {
  content: string;
}

export type StreamEvent =
  | { event: 'meta'; data: StreamMetaData }
  | { event: 'delta'; data: StreamDeltaData }
  | { event: 'notice'; data: StreamNoticeData }
  | { event: 'done'; data: StreamDoneData }
  | { event: 'error'; data: StreamErrorData }
  | { event: 'message'; data: StreamMessageData };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asTokenUsage(value: unknown): TokenUsage | undefined {
  const record = asRecord(value);
  const promptTokens = asNumber(record.promptTokens);
  const completionTokens = asNumber(record.completionTokens);
  const totalTokens = asNumber(record.totalTokens);
  if (promptTokens === undefined || completionTokens === undefined || totalTokens === undefined) return undefined;
  return { promptTokens, completionTokens, totalTokens };
}

/** Validate one parsed SSE frame into a typed StreamEvent.
 *  Returns null for unrecognized event names (dropped, not fatal). */
function parseStreamEvent(eventName: string, raw: unknown): StreamEvent | null {
  const record = asRecord(raw);
  switch (eventName) {
    case 'meta': {
      const model = asRecord(record.model);
      return {
        event: 'meta',
        data: {
          conversationId: asOptionalString(record.conversationId),
          model: typeof model.id === 'string' && typeof model.name === 'string'
            ? { id: model.id, name: model.name }
            : undefined,
          contextDropped: typeof record.contextDropped === 'boolean' ? record.contextDropped : undefined,
        },
      };
    }
    case 'delta':
      return { event: 'delta', data: { content: asString(record.content) } };
    case 'notice':
      return {
        event: 'notice',
        data: { code: asOptionalString(record.code), message: asString(record.message, 'Notice') },
      };
    case 'done': {
      const fallback = asRecord(record.fallback);
      return {
        event: 'done',
        data: {
          finishReason: asOptionalString(record.finishReason),
          citations: Array.isArray(record.citations)
            ? record.citations.map((citation, index) => mapCitation(citation, index))
            : undefined,
          usage: asTokenUsage(record.usage),
          fallback: typeof fallback.id === 'string' && typeof fallback.name === 'string'
            ? { id: fallback.id, name: fallback.name }
            : undefined,
        },
      };
    }
    case 'error':
      return {
        event: 'error',
        data: {
          code: asString(record.code, 'STREAM_ERROR'),
          message: asString(record.message, 'Model request failed'),
          requestId: asOptionalString(record.requestId),
        },
      };
    case 'message':
    case '':
      // Bare `data:` frame with no `event:` line: the SSE spec defaults the
      // event type to "message".
      return {
        event: 'message',
        data: { content: typeof raw === 'string' ? raw : asString(record.content) },
      };
    default:
      return null;
  }
}

function parseSseFrame(frame: string): StreamEvent | null {
  let eventName = '';
  const dataLines: string[] = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith(':')) continue; // SSE comment / heartbeat
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return null; // drop malformed frames; keep the stream alive
  }
  return parseStreamEvent(eventName, parsed);
}

export async function streamChat(
  body: { conversationId: string; content: string; modelId: string; classification: DataClassification; documentIds?: string[] },
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  const headers = new Headers({ 'content-type': 'application/json', accept: 'text/event-stream' });
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  let response = await fetch(`${API_BASE}/chat`, { method: 'POST', headers, body: JSON.stringify(body), signal, credentials: 'include' });
  if (response.status === 401 && await refresh()) {
    if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
    response = await fetch(`${API_BASE}/chat`, { method: 'POST', headers, body: JSON.stringify(body), signal, credentials: 'include' });
  }
  if (!response.ok) throw await parseError(response);
  if (!response.body) throw new ApiError(502, 'EMPTY_STREAM', 'The model returned no response stream');
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let buffer = '';
    let done = false;
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      buffer += decoder.decode(chunk.value ?? new Uint8Array(), { stream: !done });
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? '';
      for (const frame of frames) {
        const streamEvent = parseSseFrame(frame);
        if (streamEvent) onEvent(streamEvent);
      }
    }
    // Flush any trailing frame that arrived without a terminator.
    if (buffer.trim()) {
      const streamEvent = parseSseFrame(buffer);
      if (streamEvent) onEvent(streamEvent);
    }
  } finally {
    // Always release the reader, even when parsing or the consumer throws.
    reader.releaseLock();
  }
}

export function mapCitation(value: unknown, index: number): Citation {
  const record = asRecord(value);
  return {
    id: index + 1,
    title: asString(record.documentName ?? record.title, 'Source'),
    section: asOptionalString(record.section),
    page: asNumber(record.page),
    documentId: asOptionalString(record.documentId),
    chunkId: asOptionalString(record.chunkId),
  };
}
