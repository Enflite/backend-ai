/**
 * configOidc.test.ts — OIDC config validation unit tests.
 *
 * Covers: HTTPS transport enforcement for OIDC URLs (loopback allowed in
 * dev only, rejected in production) and array rejection for
 * OIDC_ROLE_MAPPING. The helper matrix is tested directly; the boot-time
 * wiring (process.exit) is tested by re-importing the config module with
 * stubbed env, since validation runs at module load.
 *
 * VALIDATED IN CI with mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isAllowedOidcUrl } from '../src/config.js';

describe('isAllowedOidcUrl', () => {
  it('requires HTTPS for non-loopback hosts in every environment', () => {
    for (const nodeEnv of ['development', 'test', 'production']) {
      expect(isAllowedOidcUrl('https://idp.example.com', nodeEnv)).toBe(true);
      expect(isAllowedOidcUrl('http://idp.example.com', nodeEnv)).toBe(false);
    }
  });

  it('allows plain HTTP for loopback hosts outside production only', () => {
    for (const host of ['localhost', '127.0.0.1', '[::1]']) {
      for (const nodeEnv of ['development', 'test']) {
        expect(isAllowedOidcUrl(`http://${host}:8080/realms/x`, nodeEnv)).toBe(true);
      }
      expect(isAllowedOidcUrl(`http://${host}:8080/realms/x`, 'production')).toBe(false);
    }
  });

  it('rejects non-HTTP(S) schemes and garbage', () => {
    expect(isAllowedOidcUrl('ftp://idp.example.com', 'development')).toBe(false);
    expect(isAllowedOidcUrl('not-a-url', 'development')).toBe(false);
  });
});

describe('OIDC boot validation', () => {
  const VALID_OIDC_ENV = {
    OIDC_ENABLED: 'true',
    OIDC_ISSUER: 'https://idp.example.com',
    OIDC_CLIENT_ID: 'enflite-client',
    OIDC_CLIENT_SECRET: 'test-secret',
    OIDC_REDIRECT_URI: 'https://app.example.com/api/v1/auth/oidc/callback',
    OIDC_DEFAULT_TENANT_ID: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    OIDC_FRONTEND_CALLBACK: 'https://app.example.com/sso/callback',
  };

  let exitSpy: { mock: { calls: unknown[][] } };
  let consoleErrorSpy: { mock: { calls: unknown[][] } };

  beforeEach(() => {
    vi.resetModules();
    for (const [key, value] of Object.entries(VALID_OIDC_ENV)) vi.stubEnv(key, value);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('boots with HTTPS OIDC URLs', async () => {
    await expect(import('../src/config.js')).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('refuses to boot with a non-loopback HTTP issuer', async () => {
    vi.stubEnv('OIDC_ISSUER', 'http://idp.example.com');
    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('OIDC_ISSUER must use HTTPS'));
  });

  it('refuses to boot with an HTTP frontend callback', async () => {
    vi.stubEnv('OIDC_FRONTEND_CALLBACK', 'http://app.example.com/sso/callback');
    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('OIDC_FRONTEND_CALLBACK must use HTTPS'));
  });

  it('allows a loopback HTTP issuer in non-production', async () => {
    vi.stubEnv('OIDC_ISSUER', 'http://localhost:8080/realms/enflite');
    await expect(import('../src/config.js')).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('rejects even loopback HTTP OIDC URLs in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('JWT_SECRET', 'x'.repeat(64)); // setup.ts pins a dev placeholder, rejected in production
    vi.stubEnv('COOKIE_SECURE', 'true'); // required in production, defaults to false
    vi.stubEnv('OIDC_ISSUER', 'http://localhost:8080/realms/enflite');
    vi.stubEnv('MALWARE_SCAN_MODE', 'http');
    vi.stubEnv('MALWARE_SCANNER_ENDPOINT', 'http://scanner:8080/scan');
    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('OIDC_ISSUER must use HTTPS'));
  });

  it('rejects an array OIDC_ROLE_MAPPING', async () => {
    vi.stubEnv('OIDC_ROLE_MAPPING', '["sso-admins"]');
    await expect(import('../src/config.js')).rejects.toThrow('process.exit called');
    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('OIDC_ROLE_MAPPING must be a JSON object')
    );
  });
});
