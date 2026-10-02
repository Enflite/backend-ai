/**
 * studio/api.test.ts — studio REST client: envelope unwrapping and shape
 * validation. fetch is stubbed; no DOM needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import { isStudioUnavailable, listStudioActions, listStudioConnections } from './api';

const realFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const CONNECTION = {
  id: 'c1',
  name: 'Enflite TRN',
  environment: 'TRN',
  baseUrl: 'https://syteline.example/TRN',
  capabilities: { idoProbe: true },
  updatedAt: '2026-10-02T16:00:00Z',
};

const ACTION = {
  id: 'items.read',
  title: 'Read items',
  description: 'Fetch item records.',
  substrate: 'syteline',
  destructive: false,
  supported: true,
};

describe('listStudioConnections', () => {
  it('unwraps the connections envelope', async () => {
    mockFetchOnce(200, { connections: [CONNECTION] });
    await expect(listStudioConnections()).resolves.toEqual([CONNECTION]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/connections'),
      expect.objectContaining({}),
    );
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { items: [CONNECTION] });
    await expect(listStudioConnections()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });

  it('propagates ApiError from the backend', async () => {
    mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'nope' } });
    const err = await listStudioConnections().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe('listStudioActions', () => {
  it('unwraps the actions envelope', async () => {
    mockFetchOnce(200, { actions: [ACTION] });
    await expect(listStudioActions()).resolves.toEqual([ACTION]);
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { actions: 'nope' });
    await expect(listStudioActions()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('isStudioUnavailable', () => {
  it('detects the 404 the catalog returns before the backend slice lands', () => {
    expect(isStudioUnavailable(new ApiError(404, 'NOT_FOUND', 'nope'))).toBe(true);
    expect(isStudioUnavailable(new ApiError(500, 'BOOM', 'nope'))).toBe(false);
    expect(isStudioUnavailable(new Error('nope'))).toBe(false);
  });
});
