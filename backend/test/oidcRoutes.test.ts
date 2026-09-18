/**
 * oidcRoutes.test.ts — OIDC HTTP route tests (Phase 5b).
 *
 * Mocks: the oidc core module (IdP interactions), the DB pool (in-memory
 * rows), sessions, buildAuth, and the audit writer. Env is stubbed before
 * the route module is dynamically imported, since config is read at module
 * load.
 *
 * VALIDATED IN CI with mocks; a live IdP round-trip
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { AppError } from '../src/errors.js';

const { queryMock, withTxMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTxMock: vi.fn(),
}));
vi.mock('../src/db/pool.js', () => ({
  query: queryMock,
  tenantQuery: queryMock,
  withTx: withTxMock,
}));

const oidcCore = vi.hoisted(() => ({
  buildAuthorizeUrl: vi.fn(),
  consumeOidcState: vi.fn(),
  exchangeCode: vi.fn(),
  fetchUserinfo: vi.fn(),
  resolveInternalRole: vi.fn(),
  verifyIdToken: vi.fn(),
}));
vi.mock('../src/auth/oidc.js', () => oidcCore);

const { createSessionMock, setRefreshCookieMock, buildAuthMock, recordAuditMock } = vi.hoisted(() => ({
  createSessionMock: vi.fn(),
  setRefreshCookieMock: vi.fn(),
  buildAuthMock: vi.fn(),
  recordAuditMock: vi.fn(),
}));
vi.mock('../src/auth/sessions.js', () => ({
  createSession: createSessionMock,
  setRefreshCookie: setRefreshCookieMock,
}));
vi.mock('../src/auth/routes.js', () => ({ buildAuth: buildAuthMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit: recordAuditMock }));

type RoutesModule = typeof import('../src/auth/oidcRoutes.js');
let oidcRoutes: RoutesModule['oidcRoutes'];

const FRONTEND_CALLBACK = 'https://app.example.com/sso/callback';
const TENANT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeAll(async () => {
  vi.stubEnv('OIDC_ENABLED', 'true');
  vi.stubEnv('OIDC_ISSUER', 'https://idp.example.com');
  vi.stubEnv('OIDC_CLIENT_ID', 'enflite-client');
  vi.stubEnv('OIDC_CLIENT_SECRET', 'test-secret');
  vi.stubEnv('OIDC_REDIRECT_URI', 'https://app.example.com/api/v1/auth/oidc/callback');
  vi.stubEnv('OIDC_DEFAULT_TENANT_ID', TENANT_ID);
  vi.stubEnv('OIDC_FRONTEND_CALLBACK', FRONTEND_CALLBACK);
  vi.stubEnv('JWT_EXPIRES_IN', '15m');
  ({ oidcRoutes } = await import('../src/auth/oidcRoutes.js'));
});

const MEMBERSHIP = {
  tenant_id: TENANT_ID,
  tenant_name: 'Default',
  role_id: 'role-1',
  role_name: 'User',
};

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  await app.register(oidcRoutes);
  return app;
}

/** DB rows for a full successful callback for a NEW user. */
function mockNewUserFlow() {
  queryMock.mockImplementation(async (sql: string, params?: unknown[]) => {
    const text = String(sql);
    if (text.includes('FROM oidc_identities')) return { rows: [] }; // no identity yet
    if (text.includes('FROM memberships')) {
      // First call: no membership; after INSERT, the re-read returns one.
      return queryMock.mock.calls.filter(([s]) => String(s).includes('INSERT INTO memberships')).length > 0
        ? { rows: [MEMBERSHIP] }
        : { rows: [] };
    }
    if (text.includes('FROM roles')) return { rows: [{ id: 'role-1' }] };
    if (text.includes('FROM users WHERE id')) return { rows: [{ id: 'user-1', email: 'jake@example.com', display_name: 'Jake', is_active: true, clearance: 'PUBLIC' }] };
    return { rows: [] };
  });
  // withTx executes the provisioning callback against a fake client.
  withTxMock.mockImplementation(async (callback: (client: { query: (...args: unknown[]) => Promise<unknown> }) => Promise<string>) => {
    const client = {
      query: async (sql: string) => {
        const text = String(sql);
        if (text.includes('pg_advisory_xact_lock')) return { rows: [] };
        if (text.includes('FROM oidc_identities')) return { rows: [] };
        if (text.includes('INSERT INTO users')) return { rows: [{ id: 'user-1' }] };
        if (text.includes('INSERT INTO oidc_identities')) return { rows: [] };
        return { rows: [] };
      },
    };
    return callback(client as never);
  });
  oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'verifier-1', nonce: 'nonce-1' });
  oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id-token', accessToken: 'access-token' });
  oidcCore.verifyIdToken.mockResolvedValue({
    issuer: 'https://idp.example.com',
    sub: 'idp-sub-1',
    email: 'jake@example.com',
    name: 'Jake',
    groups: [],
  });
  oidcCore.fetchUserinfo.mockResolvedValue({});
  oidcCore.resolveInternalRole.mockResolvedValue(null);
  buildAuthMock.mockResolvedValue({ userId: 'user-1', tenantId: TENANT_ID });
  createSessionMock.mockResolvedValue({ accessToken: 'access-123', refreshToken: 'refresh-123' });
}

beforeEach(() => {
  queryMock.mockReset();
  withTxMock.mockReset();
  recordAuditMock.mockReset();
  recordAuditMock.mockResolvedValue(undefined);
  for (const fn of Object.values(oidcCore)) fn.mockReset();
  createSessionMock.mockReset();
  setRefreshCookieMock.mockReset();
  buildAuthMock.mockReset();
});

describe('oidc routes', () => {
  it('GET /auth/oidc/status reports enabled', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true });
    await app.close();
  });

  it('GET /auth/oidc/login redirects to the IdP authorization URL', async () => {
    oidcCore.buildAuthorizeUrl.mockResolvedValue({ url: 'https://idp.example.com/authorize?x=1', state: 's' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/login' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('https://idp.example.com/authorize?x=1');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'OIDC_LOGIN_START', success: true }));
    await app.close();
  });

  it('callback redirects with an error fragment when the IdP denies', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?error=access_denied&state=s' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=idp_denied`);
    // No tokens in the query string or logs: the fragment never leaves the browser.
    expect(String(res.headers.location)).not.toContain('access_token');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'OIDC_LOGIN_FAILURE', success: false })
    );
    await app.close();
  });

  it('callback redirects with an error fragment when code/state are missing', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=only-code' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=invalid_callback`);
    expect(oidcCore.consumeOidcState).not.toHaveBeenCalled();
    await app.close();
  });

  it('callback rejects a replayed or forged state', async () => {
    oidcCore.consumeOidcState.mockResolvedValue(null);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=replayed' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=invalid_state`);
    expect(oidcCore.exchangeCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('callback provisions a new user, creates the membership, and issues a session', async () => {
    mockNewUserFlow();
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith(`${FRONTEND_CALLBACK}#`)).toBe(true);
    // Access token travels in the fragment, never the query string.
    expect(location).toContain('#access_token=access-123');
    expect(location.split('#')[0]).not.toContain('access_token');
    // Identity was keyed by the verified issuer+subject, not by email.
    const identityLookup = queryMock.mock.calls.find(([sql]) => String(sql).includes('FROM oidc_identities'));
    expect(identityLookup?.[1]).toEqual(['https://idp.example.com', 'idp-sub-1']);
    // Nonce from the authorization request was verified against the ID token.
    expect(oidcCore.verifyIdToken).toHaveBeenCalledWith('id-token', 'nonce-1');
    // Refresh cookie + session reuse the standard session machinery.
    expect(setRefreshCookieMock).toHaveBeenCalled();
    expect(createSessionMock).toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN', success: true, userId: 'user-1', tenantId: TENANT_ID })
    );
    await app.close();
  });

  it('callback signs in an existing identity without provisioning', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM oidc_identities')) return { rows: [{ user_id: 'user-9' }] };
      if (text.includes('FROM users WHERE id')) return { rows: [{ id: 'user-9', is_active: true }] };
      if (text.includes('FROM memberships')) return { rows: [MEMBERSHIP] };
      if (text.includes('FROM users WHERE lower')) return { rows: [] };
      return { rows: [] };
    });
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'known-sub', email: 'old@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    oidcCore.resolveInternalRole.mockResolvedValue(null);
    buildAuthMock.mockResolvedValue({ userId: 'user-9', tenantId: TENANT_ID });
    createSessionMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    // Same email, different subject would NOT resolve here: identity is the
    // (issuer, subject) pair.
    expect(withTxMock).not.toHaveBeenCalled();
    expect(String(res.headers.location)).toContain('#access_token=a');
    await app.close();
  });

  it('callback refuses a disabled user', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM oidc_identities')) return { rows: [{ user_id: 'user-9' }] };
      if (text.includes('FROM users WHERE id')) return { rows: [{ id: 'user-9', is_active: false }] };
      return { rows: [] };
    });
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'sub-x', email: 'x@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=s' });
    // Browser-facing failures redirect to the frontend with a generic code
    // (audited as OIDC_LOGIN_FAILURE), never a JSON error page.
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('#error=account_disabled');
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'OIDC_LOGIN_FAILURE',
      success: false,
      metadata: expect.objectContaining({ failure: 'account_disabled' }),
    }));
    await app.close();
  });

  it('callback survives a provisioning race by re-reading the winner', async () => {
    // First the identity lookup finds nothing…
    queryMock.mockImplementationOnce(async () => ({ rows: [] }));
    // …then withTx loses the race with a unique violation on (issuer, subject)…
    withTxMock.mockRejectedValueOnce({ code: '23505' });
    // …and the re-read finds the winner's committed row.
    queryMock.mockImplementation(async (sql: string) => {
      const text = String(sql);
      if (text.includes('FROM oidc_identities')) return { rows: [{ user_id: 'user-winner' }] };
      if (text.includes('FROM users WHERE id')) return { rows: [{ id: 'user-winner', is_active: true }] };
      if (text.includes('FROM memberships')) return { rows: [MEMBERSHIP] };
      if (text.includes('FROM users WHERE id = $1') && text.includes('email')) {
        return { rows: [{ id: 'user-winner', email: 'jake@example.com', display_name: 'Jake', is_active: true, clearance: 'PUBLIC' }] };
      }
      return { rows: [] };
    });
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'race-sub', email: 'jake@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    oidcCore.resolveInternalRole.mockResolvedValue(null);
    buildAuthMock.mockResolvedValue({ userId: 'user-winner', tenantId: TENANT_ID });
    createSessionMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('#access_token=a');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN', success: true, userId: 'user-winner' })
    );
    await app.close();
  });
});
