import { FastifyInstance, FastifyReply } from 'fastify';
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
  hashRefreshToken,
  refreshTokenTenant,
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
    const user = await identityProvider.authenticate(parsed.data);
    if (!user) {
      await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'INVALID_CREDENTIALS', ip: req.ip, requestId: req.requestId });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const membership = chooseMembership(await membershipsFor(user.id), parsed.data.tenantId);
    const response = await issueLogin(user, membership, reply);
    await recordAudit({ tenantId: membership.tenant_id, userId: user.id, action: 'LOGIN', requestId: req.requestId, ip: req.ip });
    return reply.send(response);
  });

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
      clearRefreshCookie(reply);
      throw Errors.unauthorized('INVALID_REFRESH_TOKEN', 'Refresh session is invalid or expired');
    }
    const rotated = await rotateRefreshToken(refreshToken, await buildAuth(row, row), row.session_id);
    setRefreshCookie(reply, rotated.refreshToken);
    return reply.send({ accessToken: rotated.accessToken, expiresIn: config.JWT_EXPIRES_IN, user: rotated.auth });
  });

  fastify.post('/auth/logout', { preHandler: [requireAuth] }, async (req, reply) => {
    await revokeSession(req.auth!.tenantId, req.auth!.sessionId);
    clearRefreshCookie(reply);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'LOGOUT', requestId: req.requestId, ip: req.ip });
    return reply.status(204).send();
  });

  if (config.DEV_AUTH_ENABLED) {
    fastify.post('/auth/dev-login', async (req, reply) => {
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
