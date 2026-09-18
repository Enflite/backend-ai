/**
 * oidc.test.ts — OIDC enterprise login unit tests (Phase 5b).
 *
 * Mocks: IdP HTTP endpoints (stubbed global fetch), the DB pool (in-memory
 * rows), and JWKS (a real RSA key pair signed through jose, served by the
 * stubbed fetch). Env is stubbed before the modules under test are
 * dynamically imported, since config is read at module load.
 *
 * VALIDATED IN CI with mocks; a live IdP round-trip
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { createHash } from 'node:crypto';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

const queryMock = vi.fn();
vi.mock('../src/db/pool.js', () => ({ query: queryMock, tenantQuery: queryMock }));

type OidcModule = typeof import('../src/auth/oidc.js');
let oidc: OidcModule;

beforeAll(async () => {
  vi.stubEnv('OIDC_ENABLED', 'true');
  vi.stubEnv('OIDC_ISSUER', 'https://idp.example.com');
  vi.stubEnv('OIDC_CLIENT_ID', 'enflite-client');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('OIDC_REDIRECT_URI', 'https://app.example.com/api/v1/auth/oidc/callback');
  vi.stubEnv('OIDC_ROLE_MAPPING', '{"sso-admins":"Admin","sso-ghosts":"Ghost Role"}');
  vi.stubEnv('OIDC_DEFAULT_TENANT_ID', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  vi.stubEnv('OIDC_FRONTEND_CALLBACK', 'https://app.example.com/sso/callback');
  oidc = await import('../src/auth/oidc.js');
});

const DISCOVERY = {
  issuer: 'https://idp.example.com',
  authorization_endpoint: 'https://idp.example.com/authorize',
  token_endpoint: 'https://idp.example.com/token',
  userinfo_endpoint: 'https://idp.example.com/userinfo',
  jwks_uri: 'https://idp.example.com/.well-known/jwks.json',
};

let fetchMock: ReturnType<typeof vi.fn>;
let jwksJson: { keys: unknown[] };

beforeEach(() => {
  queryMock.mockReset();
  oidc.clearOidcDiscoveryCache();
  fetchMock = vi.fn(async (url: unknown) => {
    const target = String(url);
    if (target.includes('/.well-known/openid-configuration')) {
      return { ok: true, status: 200, json: async () => DISCOVERY };
    }
    if (target.includes('/.well-known/jwks.json')) {
      return { ok: true, status: 200, json: async () => jwksJson };
    }
    throw new Error(`unexpected fetch: ${target}`);
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('oidc PKCE + state', () => {
  it('creates a valid S256 PKCE pair', () => {
    const { verifier, challenge } = oidc.createPkcePair();
    expect(verifier).toHaveLength(43); // 32 random bytes, base64url
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
  });

  it('creates unique states', () => {
    expect(oidc.createOidcState()).not.toBe(oidc.createOidcState());
  });
});

describe('oidc discovery', () => {
  it('fetches and caches the discovery document', async () => {
    const doc = await oidc.discoverIssuer();
    expect(doc.authorization_endpoint).toBe(DISCOVERY.authorization_endpoint);
    await oidc.discoverIssuer();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('rejects a discovery document whose issuer does not match config', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ ...DISCOVERY, issuer: 'https://evil.example.com' }),
    });
    await expect(oidc.discoverIssuer()).rejects.toMatchObject({ code: 'OIDC_ISSUER_MISMATCH' });
  });
});

describe('oidc authorize URL', () => {
  it('stores the verifier and builds a PKCE authorization URL', async () => {
    queryMock.mockResolvedValue({ rows: [] });
    const { url, state } = await oidc.buildAuthorizeUrl();
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe(DISCOVERY.authorization_endpoint);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('client_id')).toBe('enflite-client');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    expect(parsed.searchParams.get('state')).toBe(state);
    expect(parsed.searchParams.get('code_challenge')).toHaveLength(43);
    // Verifier persisted keyed by state (INSERT), plus the expiry cleanup (DELETE).
    expect(queryMock).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO oidc_auth_requests'), expect.any(Array));
    const insertArgs = queryMock.mock.calls.find((call) => String(call[0]).includes('INSERT'))![1] as string[];
    expect(insertArgs[0]).toBe(state);
    expect(insertArgs[1]).toHaveLength(43);
  });
});

describe('oidc state consumption', () => {
  it('is single-use: a consumed state is deleted', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ code_verifier: 'v' }] });
    expect(await oidc.consumeOidcState('state-1')).toBe('v');
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await oidc.consumeOidcState('state-1')).toBeNull();
  });
});

describe('oidc code exchange', () => {
  it('exchanges the code with client_secret_basic and returns the token set', async () => {
    fetchMock.mockImplementation(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      const target = String(url);
      if (target.includes('/.well-known/openid-configuration')) {
        return { ok: true, status: 200, json: async () => DISCOVERY };
      }
      if (target === DISCOVERY.token_endpoint) {
        expect(init?.headers?.authorization).toMatch(/^Basic /);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id_token: 'id-token', access_token: 'access-token', expires_in: 3600 }),
        };
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const tokens = await oidc.exchangeCode('auth-code', 'verifier');
    expect(tokens).toEqual({ idToken: 'id-token', accessToken: 'access-token', expiresIn: 3600 });
  });

  it('fails closed when the token endpoint errors', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/.well-known/openid-configuration')) {
        return { ok: true, status: 200, json: async () => DISCOVERY };
      }
      return { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) };
    });
    await expect(oidc.exchangeCode('bad-code', 'verifier')).rejects.toMatchObject({ code: 'OIDC_TOKEN_EXCHANGE_FAILED' });
  });
});

describe('oidc ID token verification', () => {
  let sign: (claims: Record<string, unknown>) => Promise<string>;

  beforeEach(async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    const jwk = await exportJWK(publicKey);
    jwksJson = { keys: [{ ...jwk, kid: 'test-key', alg: 'RS256', use: 'sig' }] };
    sign = (claims) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
        .setIssuer('https://idp.example.com')
        .setAudience('enflite-client')
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
  });

  it('accepts a valid token and extracts email + groups', async () => {
    const idToken = await sign({ sub: 'user-123', email: 'jake@example.com', groups: ['sso-admins'] });
    const claims = await oidc.verifyIdToken(idToken);
    expect(claims.sub).toBe('user-123');
    expect(claims.email).toBe('jake@example.com');
    expect(claims.groups).toEqual(['sso-admins']);
  });

  it('rejects a token with the wrong audience', async () => {
    const { publicKey, privateKey } = await generateKeyPair('RS256');
    jwksJson = { keys: [{ ...(await exportJWK(publicKey)), kid: 'k', alg: 'RS256', use: 'sig' }] };
    const idToken = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k' })
      .setIssuer('https://idp.example.com')
      .setAudience('other-client')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(oidc.verifyIdToken(idToken)).rejects.toMatchObject({ code: 'OIDC_INVALID_ID_TOKEN' });
  });

  it('rejects a token signed by an unknown key', async () => {
    const { privateKey } = await generateKeyPair('RS256');
    const idToken = await new SignJWT({ sub: 'x' })
      .setProtectedHeader({ alg: 'RS256', kid: 'unknown' })
      .setIssuer('https://idp.example.com')
      .setAudience('enflite-client')
      .setExpirationTime('5m')
      .sign(privateKey);
    await expect(oidc.verifyIdToken(idToken)).rejects.toMatchObject({ code: 'OIDC_INVALID_ID_TOKEN' });
  });
});

describe('oidc userinfo fallback', () => {
  it('fills missing email/groups from userinfo', async () => {
    fetchMock.mockImplementation(async (url: unknown) => {
      const target = String(url);
      if (target.includes('/.well-known/openid-configuration')) {
        return { ok: true, status: 200, json: async () => DISCOVERY };
      }
      if (target === DISCOVERY.userinfo_endpoint) {
        return { ok: true, status: 200, json: async () => ({ email: 'jake@example.com', groups: ['sso-admins'] }) };
      }
      throw new Error(`unexpected fetch: ${target}`);
    });
    const info = await oidc.fetchUserinfo('access-token');
    expect(info.email).toBe('jake@example.com');
    expect(info.groups).toEqual(['sso-admins']);
  });
});

describe('oidc role mapping', () => {
  it('parses the group→role mapping from config', () => {
    expect(oidc.parseRoleMapping()).toEqual({ 'sso-admins': 'Admin', 'sso-ghosts': 'Ghost Role' });
  });

  it('resolves a mapped group to a real internal role', async () => {
    queryMock.mockResolvedValueOnce({ rows: [{ name: 'Admin' }] });
    expect(await oidc.resolveInternalRole(['sso-admins'])).toBe('Admin');
  });

  it('fails closed when the mapped role does not exist', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    expect(await oidc.resolveInternalRole(['sso-ghosts'])).toBeNull();
  });

  it('fails closed for unmapped groups', async () => {
    expect(await oidc.resolveInternalRole(['some-other-group'])).toBeNull();
    expect(queryMock).not.toHaveBeenCalled();
  });
});
