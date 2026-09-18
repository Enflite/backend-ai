import type { AuthUser, Citation, DataClassification, DocumentRecord, RagResult } from './types';

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

async function refresh(): Promise<AuthUser | null> {
  const response = await fetch(`${API_BASE}/auth/refresh`, { method: 'POST', credentials: 'include' });
  if (!response.ok) {
    accessToken = null;
    return null;
  }
  const body = await response.json() as { accessToken: string; user: AuthUser };
  accessToken = body.accessToken;
  return body.user;
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

export interface StreamEvent {
  event: 'meta' | 'delta' | 'done' | 'error';
  data: any;
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
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const frames = buffer.split('\n\n');
    buffer = frames.pop() ?? '';
    for (const frame of frames) {
      let event = '';
      const dataLines: string[] = [];
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      }
      if (event && dataLines.length) onEvent({ event: event as StreamEvent['event'], data: JSON.parse(dataLines.join('\n')) });
    }
    if (done) break;
  }
}

export function mapCitation(value: any, index: number): Citation {
  return {
    id: index + 1,
    title: value.documentName,
    section: value.section,
    page: value.page,
    documentId: value.documentId,
    chunkId: value.chunkId,
  };
}
