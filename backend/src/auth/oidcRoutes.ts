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

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config, parseExpiresInToMs } from '../config.js';
import { query, withTx } from '../db/pool.js';
import { Errors, AppError } from '../errors.js';
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

function frontendRedirect(reply: FastifyReply, fragment: string): void {
  const url = `${config.OIDC_FRONTEND_CALLBACK}#${fragment}`;
  reply.redirect(url, 302);
}

function failedLoginRedirect(reply: FastifyReply, code: string): void {
  frontendRedirect(reply, `error=${encodeURIComponent(code)}`);
}

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === '23505';
}

async function findUserById(id: string): Promise<{ id: string; is_active: boolean } | undefined> {
  return (await query<{ id: string; is_active: boolean }>('SELECT id, is_active FROM users WHERE id = $1', [id])).rows[0];
}

function requireActive(user: { id: string; is_active: boolean } | undefined): string {
  if (!user) throw Errors.internal('OIDC identity points at a missing user', undefined, 'OIDC_ORPHAN_IDENTITY');
  if (!user.is_active) throw Errors.forbidden('ACCOUNT_DISABLED', 'Account is disabled');
  return user.id;
}

/**
 * Resolves the verified (issuer, subject) pair to a user id, provisioning
 * on first login. Identity is the IdP's stable subject — email is
 * provisioning data only (it changes and gets reassigned, so it must never
 * merge or split identities).
 */
async function findOrProvisionUserId(issuer: string, claims: OidcClaims): Promise<string> {
  const existing = (
    await query<{ user_id: string }>('SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2', [
      issuer,
      claims.sub,
    ])
  ).rows[0];
  if (existing) {
    const user = await findUserById(existing.user_id);
    if (user) return requireActive(user);
    // Stale mapping (the user row is gone): drop it and provision fresh.
    await query('DELETE FROM oidc_identities WHERE issuer = $1 AND subject = $2', [issuer, claims.sub]);
  }
  // First login: auto-provision the user and the identity mapping in one
  // transaction. The password hash is a deliberately unusable marker —
  // password login can never succeed for it (verifyPassword only accepts
  // $argon2… hashes) — and the clearance is least-privilege.
  const email = claims.email!.toLowerCase();
  try {
    return await withTx(async (client) => {
      // Serialize concurrent first-logins for the same IdP identity: the
      // loser waits here, then sees the winner's committed row below —
      // no duplicate users, no failed logins.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', [issuer, claims.sub]);
      const raced = (
        await client.query<{ user_id: string }>(
          'SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2',
          [issuer, claims.sub]
        )
      ).rows[0];
      if (raced) return requireActive(await findUserById(raced.user_id));
      const userId = (
        await client.query<{ id: string }>(
          `INSERT INTO users (email, password_hash, display_name, clearance, is_active)
           VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [email, `oidc-managed-${randomBytes(16).toString('hex')}`, claims.name ?? email, config.OIDC_DEFAULT_CLEARANCE]
        )
      ).rows[0]!.id;
      await client.query('INSERT INTO oidc_identities (issuer, subject, user_id) VALUES ($1, $2, $3)', [
        issuer,
        claims.sub,
        userId,
      ]);
      return userId;
    });
  } catch (error) {
    // Backstop: if the advisory lock didn't cover the race (e.g. two
    // app instances against databases without lock visibility — not the
    // case for a single Postgres, but cheap to handle), the unique
    // constraint on (issuer, subject) still prevents a duplicate
    // identity: roll back and re-read the winner.
    if (isUniqueViolation(error)) {
      const winner = (
        await query<{ user_id: string }>('SELECT user_id FROM oidc_identities WHERE issuer = $1 AND subject = $2', [
          issuer,
          claims.sub,
        ])
      ).rows[0];
      if (winner) return requireActive(await findUserById(winner.user_id));
    }
    throw error;
  }
}

const MEMBERSHIP_SQL = `SELECT m.tenant_id, t.name AS tenant_name, r.id AS role_id, r.name AS role_name
   FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
   WHERE m.user_id = $1 AND m.tenant_id = $2`;

/**
 * Ensures the user is a member of the default SSO tenant. New SSO users get
 * the mapped role; existing members keep their admin-managed role (role
 * changes are never silently rewritten by a login).
 */
async function ensureDefaultTenantMembership(userId: string, roleName: string): Promise<MembershipRow> {
  const existing = (await query<MembershipRow>(MEMBERSHIP_SQL, [userId, config.OIDC_DEFAULT_TENANT_ID])).rows[0];
  if (existing) return existing;
  const roleId = (await query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [roleName])).rows[0]?.id;
  if (roleId) {
    await query('INSERT INTO memberships (user_id, tenant_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      userId,
      config.OIDC_DEFAULT_TENANT_ID,
      roleId,
    ]);
  }
  const membership = (await query<MembershipRow>(MEMBERSHIP_SQL, [userId, config.OIDC_DEFAULT_TENANT_ID])).rows[0];
  if (!membership) throw Errors.internal('OIDC membership provisioning failed', undefined, 'OIDC_MEMBERSHIP_FAILED');
  return membership;
}

export async function oidcRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/auth/oidc/status', async () => ({ enabled: config.OIDC_ENABLED }));

  fastify.get('/auth/oidc/login', { config: { rateLimit: OIDC_RATE_LIMIT } }, async (request: FastifyRequest, reply: FastifyReply) => {
    if (!config.OIDC_ENABLED) throw Errors.notFound('OIDC_DISABLED', 'Enterprise SSO is not enabled');
    try {
      const { url } = await buildAuthorizeUrl();
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
      const membership = await ensureDefaultTenantMembership(userId, mappedRole ?? 'User');

      const user = (
        await query('SELECT id, email, display_name, is_active, clearance FROM users WHERE id = $1', [userId])
      ).rows[0]!;
      const auth = await buildAuth(user, membership);
      const session = await createSession(auth);
      setRefreshCookie(reply, session.refreshToken);
      await recordAudit({
        action: 'LOGIN',
        classification: 'INTERNAL',
        userId,
        tenantId: membership.tenant_id,
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
      // never reach the URL fragment.
      if (error instanceof AppError) {
        return fail(error.code === 'ACCOUNT_DISABLED' ? 'account_disabled' : 'login_failed');
      }
      return fail('login_failed');
    }
  });
}
