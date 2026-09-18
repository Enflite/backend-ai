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
import { query } from '../db/pool.js';
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

async function findOrProvisionUser(claims: OidcClaims, roleName: string) {
  const email = claims.email!.toLowerCase();
  const existing = (
    await query<{ id: string; is_active: boolean }>('SELECT id, is_active FROM users WHERE lower(email) = $1', [email])
  ).rows[0];
  if (existing) {
    if (!existing.is_active) throw Errors.forbidden('ACCOUNT_DISABLED', 'Account is disabled');
    return existing.id;
  }
  // First login: auto-provision. The password hash is a deliberately unusable
  // marker — password login can never succeed for it (verifyPassword only
  // accepts $argon2… hashes) — and the clearance is least-privilege.
  const id = (
    await query<{ id: string }>(
      `INSERT INTO users (email, password_hash, display_name, clearance, is_active)
       VALUES ($1, $2, $3, $4, true) RETURNING id`,
      [email, `oidc-managed-${randomBytes(16).toString('hex')}`, claims.name ?? email, config.OIDC_DEFAULT_CLEARANCE]
    )
  ).rows[0]!.id;
  const roleId = (
    await query<{ id: string }>('SELECT id FROM roles WHERE name = $1', [roleName])
  ).rows[0]?.id;
  if (roleId) {
    await query('INSERT INTO memberships (user_id, tenant_id, role_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
      id,
      config.OIDC_DEFAULT_TENANT_ID,
      roleId,
    ]);
  }
  return id;
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
    const verifier = await consumeOidcState(state);
    if (!verifier) return fail('invalid_state');

    try {
      const tokens = await exchangeCode(code, verifier);
      const idClaims = await verifyIdToken(tokens.idToken);
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
      // back to 'User'. Only new users get the mapped role: an existing
      // membership keeps its admin-managed role.
      const mappedRole = await resolveInternalRole(groups);
      const userId = await findOrProvisionUser(claims, mappedRole ?? 'User');
      const membership = (
        await query<MembershipRow>(
          `SELECT m.tenant_id, t.name AS tenant_name, r.id AS role_id, r.name AS role_name
           FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
           WHERE m.user_id = $1 AND m.tenant_id = $2`,
          [userId, config.OIDC_DEFAULT_TENANT_ID]
        )
      ).rows[0];
      if (!membership) throw Errors.forbidden('NO_TENANT_MEMBERSHIP', 'No tenant membership');

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
      if (error instanceof AppError) throw error;
      return fail('login_failed');
    }
  });
}
