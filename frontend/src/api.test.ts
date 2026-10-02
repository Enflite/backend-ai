import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './api';

describe('api.request content-type header', () => {
  const seen: { url: string; init: RequestInit }[] = [];
  const realFetch = globalThis.fetch;

  function stubFetch(): void {
    seen.length = 0;
    globalThis.fetch = (async (url: string, init: RequestInit = {}) => {
      seen.push({ url, init });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
  }

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('omits content-type on a bodiless DELETE (CORS-simple, no preflight)', async () => {
    stubFetch();
    await api.request('/conversations/abc', { method: 'DELETE' });
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('content-type')).toBeNull();
  });

  it('sends application/json when a body is present', async () => {
    stubFetch();
    await api.request('/conversations', { method: 'POST', body: JSON.stringify({ title: 'x' }) });
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('content-type')).toBe('application/json');
  });

  it('omits content-type for FormData bodies (browser sets the boundary)', async () => {
    stubFetch();
    const form = new FormData();
    form.append('file', new Blob(['x']), 'x.txt');
    await api.request('/documents', { method: 'POST', body: form });
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('content-type')).toBeNull();
  });
});
