/**
 * oidcRoutes.test.ts — OIDC HTTP route tests (Phase 5b).
 *
 * Mocks: the oidc core module (IdP interactions), the MongoDB collections
 * (in-memory mocks), sessions, buildAuth, and the audit writer. Env is
 * stubbed before the route module is dynamically imported, since config is
 * read at module load.
 *
 * VALIDATED IN CI with mocks; a live IdP round-trip
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import { AppError } from '../src/errors.js';

const { getDbMock, withTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const withTxMock = vi.fn(async (callback: (session: any, db: any) => Promise<any>) =>
    callback({}, await getDbMock())
  );
  return { getDbMock, withTxMock };
});
vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock())),
  withTenantTx: vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock())),
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
let OIDC_STATE_COOKIE: RoutesModule['OIDC_STATE_COOKIE'];

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      findOneAndDelete: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetDbMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset().mockResolvedValue(null);
    coll.findOneAndDelete.mockReset().mockResolvedValue(null);
    coll.findOneAndUpdate.mockReset().mockResolvedValue(null);
    coll.updateOne.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.insertOne.mockReset().mockResolvedValue({ acknowledged: true });
    coll.deleteOne.mockReset().mockResolvedValue({ deletedCount: 1 });
    coll.deleteMany.mockReset().mockResolvedValue({ deletedCount: 0 });
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  withTxMock.mockReset();
  withTxMock.mockImplementation(async (callback: (session: any, db: any) => Promise<any>) =>
    callback({}, await getDbMock())
  );
}

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
  ({ oidcRoutes, OIDC_STATE_COOKIE } = await import('../src/auth/oidcRoutes.js'));
});

const MEMBERSHIP_DOC = {
  _id: 'membership-1',
  userId: 'user-1',
  tenantId: TENANT_ID,
  roleId: 'role-1',
  createdAt: new Date(),
};

async function buildApp() {
  const app = Fastify();
  await app.register(cookie); // the state cookie needs setCookie/clearCookie + request.cookies
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  await app.register(oidcRoutes);
  return app;
}

/** DB mocks for a full successful callback for a NEW user. */
function mockNewUserFlow() {
  const oidcIdentities = getMockCollection('oidc_identities');
  const users = getMockCollection('users');
  const memberships = getMockCollection('memberships');
  const tenants = getMockCollection('tenants');
  const roles = getMockCollection('roles');

  // No identity yet → provisioning path.
  oidcIdentities.findOne.mockResolvedValue(null);

  // withTx executes the provisioning callback: the tx re-read finds nothing,
  // inserts succeed, and the callback returns the new user id.
  withTxMock.mockImplementation(async (callback: (session: any, db: any) => Promise<any>) => {
    const txDb = await getDbMock();
    // Inside the tx, the identity re-read still finds nothing (no race).
    return callback({}, txDb);
  });

  // Final user lookup after provisioning.
  users.findOne.mockImplementation(async (filter: any) => {
    if (filter._id) {
      return {
        _id: 'user-1',
        email: 'jake@example.com',
        displayName: 'Jake',
        isActive: true,
        clearance: 'PUBLIC',
      };
    }
    return null;
  });

  // Membership provisioning: first membershipRowFor finds nothing, then the
  // role lookup + upsert, then the re-read returns the membership.
  let membershipUpserted = false;
  memberships.findOne.mockImplementation(async (filter: any) => {
    if (filter.userId && filter.tenantId) {
      return membershipUpserted ? MEMBERSHIP_DOC : null;
    }
    return null;
  });
  roles.findOne.mockImplementation(async (filter: any) => {
    if (filter.name === 'User') return { _id: 'role-1', name: 'User' };
    if (filter._id === 'role-1') return { _id: 'role-1', name: 'User' };
    return null;
  });
  memberships.updateOne.mockImplementation(async () => {
    membershipUpserted = true;
    return { acknowledged: true, modifiedCount: 1, upsertedId: 'membership-1' };
  });
  tenants.findOne.mockResolvedValue({ _id: TENANT_ID, name: 'Default' });

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
  resetDbMocks();
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
    // Browser binding: the state is also set as a short-lived HttpOnly
    // SameSite=Lax cookie that the callback must see again.
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toContain(`${OIDC_STATE_COOKIE}=s`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: 'OIDC_LOGIN_START', success: true }));
    await app.close();
  });

  it('callback rejects a state that does not match the browser cookie', async () => {
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 'different-browser' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=invalid_state`);
    expect(oidcCore.consumeOidcState).not.toHaveBeenCalled();
    expect(oidcCore.exchangeCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('callback rejects a missing state cookie', async () => {
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/auth/oidc/callback?code=c&state=s' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=invalid_state`);
    expect(oidcCore.exchangeCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('callback clears the state cookie on arrival', async () => {
    mockNewUserFlow();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(302);
    const setCookie = res.headers['set-cookie'];
    const cleared = (Array.isArray(setCookie) ? setCookie : [String(setCookie)]).find((entry) =>
      String(entry).startsWith(`${OIDC_STATE_COOKIE}=`)
    );
    // Cleared = expired immediately, so a replayed callback has no cookie.
    expect(String(cleared)).toContain('Expires=Thu, 01 Jan 1970');
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
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=replayed',
      cookies: { [OIDC_STATE_COOKIE]: 'replayed' },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=invalid_state`);
    expect(oidcCore.exchangeCode).not.toHaveBeenCalled();
    await app.close();
  });

  it('callback provisions a new user, creates the membership, and issues a session', async () => {
    mockNewUserFlow();
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith(`${FRONTEND_CALLBACK}#`)).toBe(true);
    // Access token travels in the fragment, never the query string.
    expect(location).toContain('#access_token=access-123');
    expect(location.split('#')[0]).not.toContain('access_token');
    // Identity was keyed by the verified issuer+subject, not by email.
    const oidcIdentities = getMockCollection('oidc_identities');
    const identityLookup = oidcIdentities.findOne.mock.calls.find(([filter]) =>
      filter.issuer && filter.subject
    );
    expect(identityLookup?.[0]).toEqual(
      { issuer: 'https://idp.example.com', subject: 'idp-sub-1' },
      expect.anything()
    );
    // Nonce from the authorization request was verified against the ID token.
    expect(oidcCore.verifyIdToken).toHaveBeenCalledWith('id-token', 'nonce-1');
    // The user and identity were provisioned in the transaction.
    const users = getMockCollection('users');
    expect(users.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'jake@example.com' }),
      expect.objectContaining({ session: expect.anything() })
    );
    expect(oidcIdentities.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({ issuer: 'https://idp.example.com', subject: 'idp-sub-1' }),
      expect.objectContaining({ session: expect.anything() })
    );
    // Refresh cookie + session reuse the standard session machinery.
    expect(setRefreshCookieMock).toHaveBeenCalled();
    expect(createSessionMock).toHaveBeenCalled();
    // The provisioned user id is generated by the source (randomUUID); capture
    // it from the insert rather than asserting a fixed value.
    const provisionedUserId = users.insertOne.mock.calls[0][0]._id;
    expect(provisionedUserId).toBeTruthy();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN', success: true, userId: provisionedUserId, tenantId: TENANT_ID })
    );
    await app.close();
  });

  it('callback signs in an existing identity without provisioning', async () => {
    const oidcIdentities = getMockCollection('oidc_identities');
    const users = getMockCollection('users');
    const memberships = getMockCollection('memberships');
    const tenants = getMockCollection('tenants');
    const roles = getMockCollection('roles');

    // Existing identity → existing user → existing membership. No provisioning.
    oidcIdentities.findOne.mockResolvedValue({ _id: 'ident-1', userId: 'user-9' });
    users.findOne.mockImplementation(async (filter: any) => {
      if (filter._id === 'user-9') return { _id: 'user-9', isActive: true, email: 'old@example.com', displayName: 'Old', clearance: 'PUBLIC' };
      return null;
    });
    memberships.findOne.mockResolvedValue(MEMBERSHIP_DOC);
    tenants.findOne.mockResolvedValue({ _id: TENANT_ID, name: 'Default' });
    roles.findOne.mockResolvedValue({ _id: 'role-1', name: 'User' });

    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'known-sub', email: 'old@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    oidcCore.resolveInternalRole.mockResolvedValue(null);
    buildAuthMock.mockResolvedValue({ userId: 'user-9', tenantId: TENANT_ID });
    createSessionMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(302);
    // Same email, different subject would NOT resolve here: identity is the
    // (issuer, subject) pair.
    expect(withTxMock).not.toHaveBeenCalled();
    expect(String(res.headers.location)).toContain('#access_token=a');
    await app.close();
  });

  it('callback refuses a disabled user', async () => {
    const oidcIdentities = getMockCollection('oidc_identities');
    const users = getMockCollection('users');
    oidcIdentities.findOne.mockResolvedValue({ _id: 'ident-1', userId: 'user-9' });
    users.findOne.mockResolvedValue({ _id: 'user-9', isActive: false });
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'sub-x', email: 'x@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
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
    const oidcIdentities = getMockCollection('oidc_identities');
    const users = getMockCollection('users');
    const memberships = getMockCollection('memberships');
    const tenants = getMockCollection('tenants');
    const roles = getMockCollection('roles');

    // First the identity lookup finds nothing…
    oidcIdentities.findOne.mockResolvedValueOnce(null);
    // …then withTx loses the race with a MongoDB duplicate-key error on
    // (issuer, subject)…
    withTxMock.mockRejectedValueOnce({ code: 11000, keyPattern: { issuer: 1, subject: 1 } });
    // …and the re-read finds the winner's committed row.
    oidcIdentities.findOne.mockImplementation(async (filter: any) => {
      if (filter.issuer && filter.subject) return { _id: 'ident-winner', userId: 'user-winner' };
      return null;
    });
    users.findOne.mockImplementation(async (filter: any) => {
      if (filter._id === 'user-winner') {
        return { _id: 'user-winner', email: 'jake@example.com', displayName: 'Jake', isActive: true, clearance: 'PUBLIC' };
      }
      return null;
    });
    memberships.findOne.mockResolvedValue({ ...MEMBERSHIP_DOC, userId: 'user-winner' });
    tenants.findOne.mockResolvedValue({ _id: TENANT_ID, name: 'Default' });
    roles.findOne.mockResolvedValue({ _id: 'role-1', name: 'User' });

    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'race-sub', email: 'jake@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    oidcCore.resolveInternalRole.mockResolvedValue(null);
    buildAuthMock.mockResolvedValue({ userId: 'user-winner', tenantId: TENANT_ID });
    createSessionMock.mockResolvedValue({ accessToken: 'a', refreshToken: 'r' });
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toContain('#access_token=a');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'LOGIN', success: true, userId: 'user-winner' })
    );
    await app.close();
  });

  it('callback fails closed when the email is already taken by a different identity', async () => {
    const oidcIdentities = getMockCollection('oidc_identities');
    // A different IdP identity provisioning with an email another account
    // owns: the users.email unique index fires inside withTx.
    oidcIdentities.findOne.mockResolvedValue(null);
    withTxMock.mockRejectedValueOnce({ code: 11000, keyPattern: { email: 1 } });
    oidcCore.consumeOidcState.mockResolvedValue({ verifier: 'v', nonce: 'n' });
    oidcCore.exchangeCode.mockResolvedValue({ idToken: 'id', accessToken: 'at' });
    oidcCore.verifyIdToken.mockResolvedValue({ issuer: 'https://idp.example.com', sub: 'other-sub', email: 'taken@example.com', groups: [] });
    oidcCore.fetchUserinfo.mockResolvedValue({});
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/oidc/callback?code=c&state=s',
      cookies: { [OIDC_STATE_COOKIE]: 's' },
    });
    expect(res.statusCode).toBe(302);
    // The browser sees only the generic failure code; the internal code is
    // recorded in the audit metadata for operators.
    expect(res.headers.location).toBe(`${FRONTEND_CALLBACK}#error=login_failed`);
    expect(createSessionMock).not.toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: 'OIDC_LOGIN_FAILURE',
      success: false,
      metadata: expect.objectContaining({ failure: 'login_failed', internalCode: 'OIDC_EMAIL_CONFLICT' }),
    }));
    await app.close();
  });
});
