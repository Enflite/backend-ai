/**
 * oidcRoutes.ts — enterprise OIDC login endpoints.
 *
 *   GET /auth/oidc/status     → { enabled } (public; drives the SSO button)
 *   GET /auth/oidc/login      → 302 redirect to the IdP authorization endpoint
 *   GET /auth/oidc/callback   → validates the response, provisions the user,
 *                                issues a session, redirects to the frontend
 *
 * Session semantics are identical to password login (createSession +
 * refresh cookie + LOGIN audit). Access tokens are returned in the URL
 * fragment, never the query string.
 */

import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, parseExpiresInToMs } from '../config.js';
import { getDb, withTx } from '../db/mongo.js';
import { Errors, AppError } from '../errors.js';
import { Classification } from '../authz/permissions.js';
import { recordAudit } from '../audit/audit.js';
import { createSession, setRefreshCookie } from './sessions.js';
import { buildAuth, MembershipRow } from './routes.js';
import {
  buildAuthorizeUrl,
  consumeOidcState,
  exchangeCode,
  fetchUserinfo,
  resolveInternalRole,
  verifyIdToken,
  type OidcClaims,
} from './oidc.js';

const OIDC_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

// MongoDB document shapes (camelCase, UUID-string _id — ADR-014).
interface UserDoc {
  _id: string;
  email: string;
  passwordHash?: string;
  displayName: string;
  isActive: boolean;
  clearance: Classification;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
  createdAt?: Date;
}

interface OidcIdentityDoc {
  _id: string;
  issuer: string;
  subject: string;
  userId: string;
  createdAt?: Date;
}

interface MembershipDoc {
  _id: string;
  userId: string;
  tenantId: string;
  roleId: string;
}

/**
 * Short-lived browser-binding cookie for the OIDC login flow. The login
 * endpoint sets it to the state it just generated; the callback requires
 * the state's query parameter to match it (CSRF protection: the flow is
 * bound to the browser that initiated it, not just to whoever presents a
 * state value). Single-use: cleared on callback arrival.
 */
export const OIDC_STATE_COOKIE = 'oidc_state';
const OIDC_STATE_COOKIE_PATH = '/api/v1/auth/oidc/callback';
const OIDC_STATE_COOKIE_MAX_AGE_SECONDS = 10 * 60;

function frontendRedirect(reply: FastifyReply, fragment: string): void {
  const url = `${config.OIDC_FRONTEND_CALLBACK}#${fragment}`;
  reply.redirect(url, 302);
}

function failedLoginRedirect(reply: FastifyReply, code: string): void {
  frontendRedirect(reply, `error=${encodeURIComponent(code)}`);
}

function isUniqueViolation(error: unknown): boolean {
  // MongoDB duplicate-key error (unique index on (issuer, subject) or on
  // users.email), replacing PostgreSQL's 23505.
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
}

function isEmailConflict(error: unknown): boolean {  // A users.email unique conflict means a *different* IdP identity is trying
  // to provision with an email another account already owns. Identity is the
  // (issuer, subject) pair — email is provisioning data and must never merge
  // identities — so this fails closed rather than attaching to the existing
  // account.
  if (!error || typeof error !== 'object') return false;
  const keyPattern = (error as { keyPattern?: Record<string, unknown> }).keyPattern;
  const keyValue = (error as { keyValue?: Record<string, unknown> }).keyValue;
  return !!(keyPattern && 'email' in keyPattern) || !!(keyValue && 'email' in keyValue);
}

async function findUserById(id: string): Promise<{ id: string; isActive: boolean } | undefined> {
  const db = await getDb();
  const doc = await db.collection<UserDoc>('users').findOne({ _id: id }, { projection: { isActive: 1 } });
  return doc ? { id: doc._id, isActive: doc.isActive } : undefined;
}

function requireActive(user: { id: string; isActive: boolean } | undefined): string {
  if (!user) throw Errors.internal('OIDC identity points at a missing user', undefined, 'OIDC_ORPHAN_IDENTITY');
  if (!user.isActive) throw Errors.forbidden('ACCOUNT_DISABLED', 'Account is disabled');
  return user.id;
}

/**
 * Resolves the verified (issuer, subject) pair to a user id, provisioning
 * on first login. Identity is the IdP's stable subject — email is
 * provisioning data only (it changes and gets reassigned, so it must never
 * merge or split identities).
 */
async function findOrProvisionUserId(issuer: string, claims: OidcClaims): Promise<string> {
  // oidc_identities is a pre-auth table (no tenant yet): no tenantId filter.
  const db = await getDb();
  const existing = await db.collection<OidcIdentityDoc>('oidc_identities').findOne(
    { issuer, subject: claims.sub },
    { projection: { userId: 1 } }
  );
  if (existing) {
    const user = await findUserById(existing.userId);
    if (user) return requireActive(user);
    // Stale mapping (the user document is gone): drop it and provision fresh.
    await db.collection<OidcIdentityDoc>('oidc_identities').deleteOne({ issuer, subject: claims.sub });
  }
  // First login: auto-provision the user and the identity mapping in one
  // transaction. The password hash is a deliberately unusable marker —
  // password login can never succeed for it (verifyPassword only accepts
  // $argon2… hashes) — and the clearance is least-privilege.
  const email = claims.email!.toLowerCase();
  try {
    return await withTx(async (session, txDb) => {
      // Re-read inside the transaction: a concurrent first-login for the
      // same IdP identity either commits first (we see the winner's row
      // here) or hits the unique index on (issuer, subject) below, which
      // the catch block turns into a re-read of the winner — no duplicate
      // users, no failed logins. (PostgreSQL's advisory lock has no
      // MongoDB equivalent; the unique index is the serialization point.)
      const raced = await txDb.collection<OidcIdentityDoc>('oidc_identities').findOne(
        { issuer, subject: claims.sub },
        { projection: { userId: 1 }, session }
      );
      if (raced) return requireActive(await findUserById(raced.userId));
      const userId = randomUUID();
      await txDb.collection<UserDoc>('users').insertOne(
        {
          _id: userId,
          email,
          passwordHash: `oidc-managed-${randomBytes(16).toString('hex')}`,
          displayName: claims.name ?? email,
          clearance: config.OIDC_DEFAULT_CLEARANCE,
          isActive: true,
          failedLoginAttempts: 0,
          lockedUntil: null,
          createdAt: new Date(),
        },
        { session }
      );
      await txDb.collection<OidcIdentityDoc>('oidc_identities').insertOne(
        {
          _id: randomUUID(),
          issuer,
          subject: claims.sub,
          userId,
          createdAt: new Date(),
        },
        { session }
      );
      return userId;
    });
  } catch (error) {
    // Backstop: the unique index on (issuer, subject) prevents a duplicate
    // identity even if two app instances race: roll back and re-read the
    // winner.
    if (isUniqueViolation(error)) {
      if (isEmailConflict(error)) {
        throw Errors.conflict('OIDC_EMAIL_CONFLICT', 'Email is already associated with a different account');
      }
      const winner = await db.collection<OidcIdentityDoc>('oidc_identities').findOne(
        { issuer, subject: claims.sub },
        { projection: { userId: 1 } }
      );
      if (winner) return requireActive(await findUserById(winner.userId));
    }
    throw error;
  }
}

/**
 * Resolves a user's membership in a tenant to the MembershipRow shape
 * (membership + tenant name + role), replacing the memberships/tenants/
 * roles join.
 */
async function membershipRowFor(userId: string, tenantId: string): Promise<MembershipRow | null> {
  const db = await getDb();
  const membership = await db.collection<MembershipDoc>('memberships').findOne({ userId, tenantId });
  if (!membership) return null;
  const [tenant, role] = await Promise.all([
    db.collection<{ _id: string; name: string }>('tenants').findOne({ _id: tenantId }, { projection: { name: 1 } }),
    db.collection<{ _id: string; name: string }>('roles').findOne({ _id: membership.roleId }, { projection: { name: 1 } }),
  ]);
  if (!tenant || !role) return null;
  return {
    tenantId: membership.tenantId,
    tenantName: tenant.name,
    roleId: membership.roleId,
    roleName: role.name,
  };
}

/**
 * Ensures the user is a member of the default SSO tenant. New SSO users get
 * the mapped role; existing members keep their admin-managed role (role
 * changes are never silently rewritten by a login).
 */
async function ensureDefaultTenantMembership(userId: string, roleName: string): Promise<MembershipRow> {
  const db = await getDb();
  // Required at boot when OIDC is enabled (config.ts), so the non-null
  // assertion is safe here.
  const tenantId = config.OIDC_DEFAULT_TENANT_ID!;
  const existing = await membershipRowFor(userId, tenantId);
  if (existing) return existing;
  const role = await db.collection<{ _id: string; name: string }>('roles').findOne({ name: roleName }, { projection: { _id: 1 } });
  if (role) {
    // INSERT ... ON CONFLICT DO NOTHING → upsert with $setOnInsert, so a
    // concurrent provisioner winning the race does not error.
    await db.collection<MembershipDoc>('memberships').updateOne(
      { userId, tenantId },
      { $setOnInsert: { _id: randomUUID(), userId, tenantId, roleId: role._id, createdAt: new Date() } },
      { upsert: true }
    );
  }
  const membership = await membershipRowFor(userId, tenantId);
  if (!membership) throw Errors.internal('OIDC membership provisioning failed', undefined, 'OIDC_MEMBERSHIP_FAILED');
  return membership;
}

export async function oidcRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/auth/oidc/status', async () => ({ enabled: config.OIDC_ENABLED }));

  fastify.get('/auth/oidc/login', { config: { rateLimit: OIDC_RATE_LIMIT } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.OIDC_ENABLED) throw Errors.notFound('OIDC_DISABLED', 'Enterprise SSO is not enabled');
    try {
      const { url, state } = await buildAuthorizeUrl();
      // Bind the flow to this browser: the callback must present the same
      // state in its query string as this HttpOnly cookie carries.
      reply.setCookie(OIDC_STATE_COOKIE, state, {
        httpOnly: true,
        secure: config.COOKIE_SECURE,
        sameSite: 'lax',
        path: OIDC_STATE_COOKIE_PATH,
        maxAge: OIDC_STATE_COOKIE_MAX_AGE_SECONDS,
      });
      await recordAudit({
        action: 'OIDC_LOGIN_START',
        classification: 'INTERNAL',
        success: true,
        requestId: request.requestId,
        ip: request.ip,
      });
      return reply.redirect(url, 302);
    } catch (error) {
      await recordAudit({
        action: 'OIDC_LOGIN_FAILURE',
        classification: 'INTERNAL',
        success: false,
        requestId: request.requestId,
        ip: request.ip,
        metadata: { stage: 'start' },
      });
      throw error;
    }
  });

  fastify.get('/auth/oidc/callback', { config: { rateLimit: OIDC_RATE_LIMIT } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.OIDC_ENABLED) throw Errors.notFound('OIDC_DISABLED', 'Enterprise SSO is not enabled');
    const { code, state, error } = request.query as { code?: string; state?: string; error?: string };

    const fail = async (code: string, metadata: Record<string, unknown> = {}) => {
      await recordAudit({
        action: 'OIDC_LOGIN_FAILURE',
        classification: 'INTERNAL',
        success: false,
        requestId: request.requestId,
        ip: request.ip,
        metadata: { failure: code, ...metadata },
      });
      failedLoginRedirect(reply, code);
    };

    if (error) return fail('idp_denied');
    if (typeof code !== 'string' || typeof state !== 'string' || !code || !state) {
      return fail('invalid_callback');
    }
    // The callback must come from the browser that started the flow: the
    // state query parameter has to match the HttpOnly cookie set at login
    // time (CSRF protection). The cookie is single-use and cleared here —
    // a replayed callback no longer has a matching cookie.
    const cookieState = request.cookies?.[OIDC_STATE_COOKIE];
    reply.clearCookie(OIDC_STATE_COOKIE, { path: OIDC_STATE_COOKIE_PATH });
    if (cookieState !== state) return fail('invalid_state');
    // Single-use, expiry-checked state lookup. A replayed or forged state
    // simply finds no row.
    const consumed = await consumeOidcState(state);
    if (!consumed) return fail('invalid_state');

    try {
      const tokens = await exchangeCode(code, consumed.verifier);
      const idClaims = await verifyIdToken(tokens.idToken, consumed.nonce);
      let email = idClaims.email;
      let groups = idClaims.groups;
      if (!email || groups.length === 0) {
        const extra = await fetchUserinfo(tokens.accessToken);
        email = email ?? extra.email;
        if (groups.length === 0 && extra.groups) groups = extra.groups;
      }
      if (!email) return fail('email_missing');
      const claims: OidcClaims = { ...idClaims, email };

      // Group→role mapping; unknown groups / nonexistent mapped roles fall
      // back to 'User'. The mapped role applies to newly provisioned
      // memberships only: existing memberships keep their admin-managed role.
      const mappedRole = await resolveInternalRole(groups);
      const userId = await findOrProvisionUserId(idClaims.issuer, claims);
      const db = await getDb();
      const membership = await ensureDefaultTenantMembership(userId, mappedRole ?? 'User');

      const user = await db.collection<UserDoc>('users').findOne(
        { _id: userId },
        { projection: { email: 1, displayName: 1, isActive: 1, clearance: 1 } }
      );
      if (!user) throw Errors.internal('OIDC identity points at a missing user', undefined, 'OIDC_ORPHAN_IDENTITY');
      const auth = await buildAuth(
        {
          id: user._id,
          email: user.email,
          passwordHash: '',
          displayName: user.displayName,
          isActive: user.isActive,
          clearance: user.clearance,
        },
        membership
      );
      const session = await createSession(auth);
      setRefreshCookie(reply, session.refreshToken);
      await recordAudit({
        action: 'LOGIN',
        classification: 'INTERNAL',
        userId,
        tenantId: membership.tenantId,
        success: true,
        requestId: request.requestId,
        ip: request.ip,
        metadata: { provider: 'oidc' },
      });
      frontendRedirect(
        reply,
        `access_token=${encodeURIComponent(session.accessToken)}&token_type=Bearer&expires_in=${Math.floor(parseExpiresInToMs(config.JWT_EXPIRES_IN) / 1000)}`
      );
    } catch (error) {
      // Browser-facing failures always redirect to the frontend with a
      // generic, audited error code: the callback is a navigation endpoint,
      // so a JSON error page would strand the user. Internal error codes
      // never reach the URL fragment — they are recorded in the audit
      // metadata for operators only.
      if (error instanceof AppError) {
        return fail(error.code === 'ACCOUNT_DISABLED' ? 'account_disabled' : 'login_failed', {
          internalCode: error.code,
        });
      }
      return fail('login_failed');
    }
  });
}
