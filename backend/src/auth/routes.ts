import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query, tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { requireAuth } from './middleware.js';
import { recordAudit } from '../audit/audit.js';
import { AuthContext, Classification, Permission } from '../authz/permissions.js';
import {
  REFRESH_COOKIE,
  clearRefreshCookie,
  createSession,
  findRefreshReuse,
  hashRefreshToken,
  InvalidRefreshSessionError,
  listUserSessions,
  refreshTokenTenant,
  revokeAllUserSessions,
  revokeSession,
  rotateRefreshToken,
  setRefreshCookie,
} from './sessions.js';
import { identityProvider, IdentityRecord } from './identityProvider.js';

const loginSchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase()),
  password: z.string().min(1).max(1024),
  tenantId: z.string().uuid().optional(),
});
const devLoginSchema = loginSchema.pick({ email: true, tenantId: true });

interface UserRow extends IdentityRecord {}
interface MembershipRow {
  tenant_id: string;
  tenant_name: string;
  role_id: string;
  role_name: string;
}

async function membershipsFor(userId: string): Promise<MembershipRow[]> {
  return (
    await query<MembershipRow>(
      `SELECT m.tenant_id, t.name AS tenant_name, r.id AS role_id, r.name AS role_name
       FROM memberships m JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
       WHERE m.user_id = $1 ORDER BY t.name`,
      [userId]
    )
  ).rows;
}

function chooseMembership(memberships: MembershipRow[], tenantId?: string): MembershipRow {
  const selected = tenantId ? memberships.find((item) => item.tenant_id === tenantId) : memberships[0];
  if (!selected) {
    throw Errors.forbidden(
      tenantId ? 'INVALID_TENANT' : 'NO_TENANT_MEMBERSHIP',
      tenantId ? 'User is not a member of the requested tenant' : 'User has no tenant memberships'
    );
  }
  return selected;
}

async function buildAuth(user: UserRow, membership: MembershipRow): Promise<Omit<AuthContext, 'sessionId'>> {
  const permissions = (
    await query<{ name: Permission }>(
      `SELECT p.name FROM permissions p JOIN role_permissions rp ON rp.permission_id = p.id
       WHERE rp.role_id = $1`,
      [membership.role_id]
    )
  ).rows.map((row) => row.name);
  return {
    userId: user.id,
    email: user.email,
    displayName: user.display_name,
    clearance: user.clearance,
    tenantId: membership.tenant_id,
    roleId: membership.role_id,
    roleName: membership.role_name,
    permissions,
  };
}

async function issueLogin(user: UserRow, membership: MembershipRow, reply: FastifyReply) {
  const session = await createSession(await buildAuth(user, membership));
  setRefreshCookie(reply, session.refreshToken);
  return {
    accessToken: session.accessToken,
    expiresIn: config.JWT_EXPIRES_IN,
    user: session.auth,
    tenant: { id: membership.tenant_id, name: membership.tenant_name },
  };
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid login request');
    // Per-account lockout with escalating backoff blunts distributed password
    // spraying that the per-IP route limit cannot stop. The lockout state is
    // checked before authentication; failures increment it, success resets it.
    const lockState = (
      await query<{ id: string; failed_login_attempts: number; locked_until: string | null }>(
        'SELECT id, failed_login_attempts, locked_until FROM users WHERE lower(email) = $1',
        [parsed.data.email]
      )
    ).rows[0];
    if (lockState?.locked_until && new Date(lockState.locked_until) > new Date()) {
      // Enumeration-safe: a locked account returns the same generic 401 as
      // bad credentials. The lock is recorded server-side in the audit trail;
      // the client learns nothing about whether the email exists.
      await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'ACCOUNT_LOCKED', ip: req.ip, requestId: req.requestId, userId: lockState.id });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const user = await identityProvider.authenticate(parsed.data);
    if (!user) {
      if (lockState) {
        // Atomic read-modify-write in a single statement: concurrent failures
        // cannot lose increments, and the escalating lockout is computed from
        // the authoritative new attempt count (5 min, doubling to a 60-min
        // cap from the 5th failure).
        const updated = (
          await query<{ failed_login_attempts: number; locked_until: string | null }>(
            `UPDATE users
             SET failed_login_attempts = failed_login_attempts + 1,
                 locked_until = CASE
                   WHEN failed_login_attempts + 1 >= 5
                   THEN NOW() + (LEAST(POWER(2, failed_login_attempts + 1 - 5) * 5, 60) || ' minutes')::interval
                   ELSE locked_until
                 END
             WHERE id = $1
             RETURNING failed_login_attempts, locked_until`,
            [lockState.id]
          )
        ).rows[0]!;
        const lockMinutes = updated.failed_login_attempts >= 5
          ? Math.min(5 * 2 ** (updated.failed_login_attempts - 5), 60)
          : 0;
        if (lockMinutes > 0) {
          await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'ACCOUNT_LOCKED', ip: req.ip, requestId: req.requestId, userId: lockState.id, metadata: { failedAttempts: updated.failed_login_attempts } });
        }
      }
      await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'INVALID_CREDENTIALS', ip: req.ip, requestId: req.requestId });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
    const membership = chooseMembership(await membershipsFor(user.id), parsed.data.tenantId);
    const response = await issueLogin(user, membership, reply);
    await recordAudit({ tenantId: membership.tenant_id, userId: user.id, action: 'LOGIN', requestId: req.requestId, ip: req.ip });
    return reply.send(response);
  });

  /**
   * Shared invalid/reused refresh-token handling. A superseded token presented
   * after rotation signals token theft: legitimate clients only ever hold the
   * newest token. Revoke everything and raise a security audit event so the
   * victim is not silently impersonated.
   */
  async function handleInvalidRefresh(
    tenantId: string,
    refreshToken: string,
    req: FastifyRequest,
    reply: FastifyReply
  ): Promise<never> {
    const reuse = await findRefreshReuse(tenantId, refreshToken);
    clearRefreshCookie(reply);
    if (reuse) {
      await revokeAllUserSessions(tenantId, reuse.userId);
      await recordAudit({ tenantId, userId: reuse.userId, requestId: req.requestId, ip: req.ip,
        action: 'SECURITY_REFRESH_TOKEN_REUSED', resource: 'session', resourceId: reuse.sessionId,
        metadata: { revokedAllSessions: true } });
      throw Errors.unauthorized('REFRESH_TOKEN_REUSED', 'Refresh token was already rotated; all sessions revoked');
    }
    throw Errors.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh session is invalid or expired');
  }

  fastify.post('/auth/refresh', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const refreshToken = req.cookies[REFRESH_COOKIE];
    const tenantId = refreshToken ? refreshTokenTenant(refreshToken) : null;
    if (!refreshToken || !tenantId) throw Errors.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh token required');
    const row = (
      await tenantQuery<UserRow & MembershipRow & { session_id: string }>(
        tenantId,
        `SELECT u.id, u.email, u.password_hash, u.display_name, u.is_active, u.clearance,
                s.id AS session_id, m.tenant_id, t.name AS tenant_name, r.id AS role_id, r.name AS role_name
         FROM sessions s JOIN users u ON u.id = s.user_id
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = s.tenant_id
         JOIN tenants t ON t.id = m.tenant_id JOIN roles r ON r.id = m.role_id
         WHERE s.refresh_token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW() AND u.is_active`,
        [hashRefreshToken(refreshToken)]
      )
    ).rows[0];
    if (!row) {
      return handleInvalidRefresh(tenantId, refreshToken, req, reply);
    }
    // The rotation UPDATE is conditional on the presented hash, so two
    // concurrent refreshes with the same token cannot both succeed: the loser
    // throws InvalidRefreshSessionError and is routed through reuse detection
    // (its token is now superseded) rather than surfacing a 500. Only that
    // typed error is caught here: signing failures, DB errors, and caller
    // cancellation (AbortError) propagate so a broken signer is never
    // misreported as token theft.
    const completeAuth = await buildAuth(row, row);
    try {
      const rotated = await rotateRefreshToken(refreshToken, completeAuth, row.session_id);
      setRefreshCookie(reply, rotated.refreshToken);
      return reply.send({ accessToken: rotated.accessToken, expiresIn: config.JWT_EXPIRES_IN, user: rotated.auth });
    } catch (error) {
      if (error instanceof InvalidRefreshSessionError) {
        return handleInvalidRefresh(tenantId, refreshToken, req, reply);
      }
      throw error;
    }
  });

  fastify.post('/auth/logout', { preHandler: [requireAuth] }, async (req, reply) => {
    await revokeSession(req.auth!.tenantId, req.auth!.sessionId);
    clearRefreshCookie(reply);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'LOGOUT', requestId: req.requestId, ip: req.ip });
    return reply.status(204).send();
  });

  // Log out everywhere: revokes all of the user's sessions, so a stolen
  // refresh token does not survive the victim logging out.
  fastify.post('/auth/logout/all', { preHandler: [requireAuth] }, async (req, reply) => {
    const revoked = await revokeAllUserSessions(req.auth!.tenantId, req.auth!.userId);
    clearRefreshCookie(reply);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'LOGOUT_ALL', requestId: req.requestId, ip: req.ip, metadata: { revokedSessions: revoked } });
    return reply.send({ revokedSessions: revoked });
  });

  // Session inventory: list and revoke the caller's own sessions.
  fastify.get('/auth/sessions', { preHandler: [requireAuth] }, async (req, reply) => {
    const sessions = await listUserSessions(req.auth!.tenantId, req.auth!.userId);
    const currentId = req.auth!.sessionId;
    return reply.send({ sessions: sessions.map((session) => ({ ...session, current: session.id === currentId })) });
  });

  fastify.delete('/auth/sessions/:id', { preHandler: [requireAuth] }, async (req, reply) => {
    const parsed = z.object({ id: z.string().uuid() }).safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid session ID');
    const owned = await tenantQuery(
      req.auth!.tenantId,
      'SELECT 1 FROM sessions WHERE id = $1 AND tenant_id = $2 AND user_id = $3 AND revoked_at IS NULL',
      [parsed.data.id, req.auth!.tenantId, req.auth!.userId]
    );
    if (owned.rowCount !== 1) throw Errors.notFound('SESSION_NOT_FOUND', 'Session not found');
    await revokeSession(req.auth!.tenantId, parsed.data.id);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'SESSION_REVOKE', requestId: req.requestId, ip: req.ip, resource: 'session', resourceId: parsed.data.id });
    return reply.status(204).send();
  });

  if (config.DEV_AUTH_ENABLED) {
    fastify.post('/auth/dev-login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const parsed = devLoginSchema.safeParse(req.body);
      if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid development login request');
      const user = (
        await query<UserRow>('SELECT id, email, password_hash, display_name, is_active, clearance FROM users WHERE lower(email) = $1', [parsed.data.email])
      ).rows[0];
      if (!user?.is_active) throw Errors.unauthorized('USER_NOT_FOUND', 'Development user not found or inactive');
      const membership = chooseMembership(await membershipsFor(user.id), parsed.data.tenantId);
      const response = await issueLogin(user, membership, reply);
      await recordAudit({ tenantId: membership.tenant_id, userId: user.id, action: 'DEV_LOGIN', requestId: req.requestId, ip: req.ip });
      return reply.send(response);
    });
  }

  fastify.get('/me', { preHandler: [requireAuth] }, async (req, reply) => reply.send(req.auth));
}
