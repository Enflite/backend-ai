/**
 * dlpHook.test.ts — external DLP endpoint URL policy (Phase 5c review fix).
 *
 * The hook ships outbound text to the sidecar, so a plaintext remote URL
 * must never be called: HTTPS is required everywhere, with HTTP allowed
 * only for explicit loopback hosts (local sidecar development). Refusal is
 * fail-open to the built-in detectors, consistent with the hook's
 * best-effort contract. VALIDATED IN CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isDlpEndpointAllowed,
  resetDlpEndpointWarning,
  scanExternalDlp,
} from '../src/dlp/hook.js';
import { config } from '../src/config.js';

describe('isDlpEndpointAllowed', () => {
  it('allows HTTPS endpoints on any host', () => {
    expect(isDlpEndpointAllowed('https://dlp.example/scan')).toBe(true);
    expect(isDlpEndpointAllowed('https://10.0.0.5:8443/scan')).toBe(true);
  });

  it('allows HTTP only for explicit loopback hosts', () => {
    expect(isDlpEndpointAllowed('http://localhost:8080/scan')).toBe(true);
    expect(isDlpEndpointAllowed('http://127.0.0.1:8080/scan')).toBe(true);
    expect(isDlpEndpointAllowed('http://[::1]:8080/scan')).toBe(true);
  });

  it('refuses plaintext HTTP to non-loopback hosts', () => {
    expect(isDlpEndpointAllowed('http://dlp.example/scan')).toBe(false);
    expect(isDlpEndpointAllowed('http://10.0.0.5:8080/scan')).toBe(false);
  });

  it('refuses non-HTTP(S) schemes and unparseable URLs', () => {
    expect(isDlpEndpointAllowed('ftp://dlp.example/scan')).toBe(false);
    expect(isDlpEndpointAllowed('file:///etc/scan')).toBe(false);
    expect(isDlpEndpointAllowed('not a url')).toBe(false);
    expect(isDlpEndpointAllowed('')).toBe(false);
  });
});

describe('scanExternalDlp endpoint policy', () => {
  const originalEndpoint = config.DLP_EXTERNAL_ENDPOINT;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    resetDlpEndpointWarning();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = originalEndpoint;
  });

  it('never calls a plaintext non-loopback endpoint', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = 'http://dlp.example/scan';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await scanExternalDlp('some outbound text');
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      // The one-shot warning is not repeated per call.
      await scanExternalDlp('more text');
      expect(consoleSpy).toHaveBeenCalledTimes(1);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('calls HTTPS endpoints and HTTP loopback endpoints', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ text: 'hooked' }) });
    for (const endpoint of ['https://dlp.example/scan', 'http://localhost:8080/scan']) {
      (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = endpoint;
      const result = await scanExternalDlp('text');
      expect(result).toBe('hooked');
      expect(fetchMock).toHaveBeenCalledWith(endpoint, expect.objectContaining({ method: 'POST' }));
      fetchMock.mockClear();
    }
  });

  it('refuses malformed endpoint URLs without calling fetch', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = '::not-a-url::';
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(await scanExternalDlp('text')).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
