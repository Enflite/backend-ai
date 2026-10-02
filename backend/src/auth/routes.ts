import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb, tenantOp } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { requireAuth } from './middleware.js';
import { recordAudit } from '../audit/audit.js';
import { AuthContext, Classification } from '../authz/permissions.js';
import { resolvePermissions } from '../authz/resolvePermissions.js';
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
export interface MembershipRow {
  tenantId: string;
  tenantName: string;
  roleId: string;
  roleName: string;
}

interface UserDoc {
  _id: string;
  email: string;
  passwordHash: string;
  displayName: string;
  isActive: boolean;
  clearance: Classification;
  failedLoginAttempts?: number;
  lockedUntil?: Date | null;
}

interface MembershipDoc {
  _id: string;
  userId: string;
  tenantId: string;
  roleId: string;
}

interface SessionDoc {
  _id: string;
  userId: string;
  tenantId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

function toUserRow(doc: UserDoc): UserRow {
  return {
    id: doc._id,
    email: doc.email,
    passwordHash: doc.passwordHash,
    displayName: doc.displayName,
    isActive: doc.isActive,
    clearance: doc.clearance,
  };
}

async function membershipsFor(userId: string): Promise<MembershipRow[]> {
  const db = await getDb();
  const memberships = await db.collection<MembershipDoc>('memberships').find({ userId }).toArray();
  const rows: MembershipRow[] = [];
  for (const m of memberships) {
    const [tenant, role] = await Promise.all([
      db.collection<{ _id: string; name: string }>('tenants').findOne(
        { _id: m.tenantId },
        { projection: { name: 1 } }
      ),
      db.collection<{ _id: string; name: string }>('roles').findOne(
        { _id: m.roleId },
        { projection: { name: 1 } }
      ),
    ]);
    if (!tenant || !role) continue;
    rows.push({
      tenantId: m.tenantId,
      tenantName: tenant.name,
      roleId: m.roleId,
      roleName: role.name,
    });
  }
  rows.sort((a, b) => a.tenantName.localeCompare(b.tenantName));
  return rows;
}

function chooseMembership(memberships: MembershipRow[], tenantId?: string): MembershipRow {
  const selected = tenantId ? memberships.find((item) => item.tenantId === tenantId) : memberships[0];
  if (!selected) {
    throw Errors.forbidden(
      tenantId ? 'INVALID_TENANT' : 'NO_TENANT_MEMBERSHIP',
      tenantId ? 'User is not a member of the requested tenant' : 'User has no tenant memberships'
    );
  }
  return selected;
}

/**
 * Builds the session auth context for a user+membership. Exported for the
 * OIDC routes so enterprise SSO issues sessions through the same
 * permission/clearance resolution as password login.
 */
export async function buildAuth(user: UserRow, membership: MembershipRow): Promise<Omit<AuthContext, 'sessionId'>> {
  const db = await getDb();
  const permissions = await resolvePermissions(db, membership.roleId);
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    clearance: user.clearance,
    tenantId: membership.tenantId,
    roleId: membership.roleId,
    roleName: membership.roleName,
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
    tenant: { id: membership.tenantId, name: membership.tenantName },
  };
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid login request');
    const db = await getDb();
    // Per-account lockout with escalating backoff blunts distributed password
    // spraying that the per-IP route limit cannot stop. The lockout state is
    // checked before authentication; failures increment it, success resets it.
    const lockState = await db.collection<UserDoc>('users').findOne(
      { email: parsed.data.email },
      { projection: { failedLoginAttempts: 1, lockedUntil: 1 } }
    );
    const lockedUntil = lockState?.lockedUntil ?? null;
    if (lockedUntil && lockedUntil > new Date()) {
      // Enumeration-safe: a locked account returns the same generic 401 as
      // bad credentials. The lock is recorded server-side in the audit trail;
      // the client learns nothing about whether the email exists.
      await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'ACCOUNT_LOCKED', ip: req.ip, requestId: req.requestId, userId: lockState!._id });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    const user = await identityProvider.authenticate(parsed.data);
    if (!user) {
      if (lockState) {
        // Atomic read-modify-write in a single pipeline update: concurrent
        // failures cannot lose increments, and the escalating lockout is
        // computed from the authoritative new attempt count (5 min, doubling
        // to a 60-min cap from the 5th failure). The MongoDB equivalent of
        // the SQL CASE/LEAST/POWER expression.
        const updated = await db.collection<UserDoc>('users').findOneAndUpdate(
          { _id: lockState._id },
          [
            {
              $set: {
                failedLoginAttempts: { $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1] },
                lockedUntil: {
                  $let: {
                    vars: { attempts: { $add: [{ $ifNull: ['$failedLoginAttempts', 0] }, 1] } },
                    in: {
                      $cond: [
                        { $gte: ['$$attempts', 5] },
                        {
                          $dateAdd: {
                            startDate: '$$NOW',
                            unit: 'minute',
                            amount: {
                              $min: [
                                { $multiply: [{ $pow: [2, { $subtract: ['$$attempts', 5] }] }, 5] },
                                60,
                              ],
                            },
                          },
                        },
                        '$lockedUntil',
                      ],
                    },
                  },
                },
              },
            },
          ],
          { returnDocument: 'after', projection: { failedLoginAttempts: 1, lockedUntil: 1 } }
        );
        const attempts = updated?.failedLoginAttempts ?? 0;
        const lockMinutes = attempts >= 5 ? Math.min(5 * 2 ** (attempts - 5), 60) : 0;
        if (lockMinutes > 0) {
          await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'ACCOUNT_LOCKED', ip: req.ip, requestId: req.requestId, userId: lockState._id, metadata: { failedAttempts: attempts } });
        }
      }
      await recordAudit({ action: 'AUTHENTICATION_FAILURE', success: false, reason: 'INVALID_CREDENTIALS', ip: req.ip, requestId: req.requestId });
      throw Errors.unauthorized('INVALID_CREDENTIALS', 'Invalid email or password');
    }
    await db.collection<UserDoc>('users').updateOne(
      { _id: user.id },
      { $set: { failedLoginAttempts: 0, lockedUntil: null } }
    );
    const membership = chooseMembership(await membershipsFor(user.id), parsed.data.tenantId);
    const response = await issueLogin(user, membership, reply);
    await recordAudit({ tenantId: membership.tenantId, userId: user.id, action: 'LOGIN', requestId: req.requestId, ip: req.ip });
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
    // Replaces the sessions/users/memberships/tenants/roles join: resolve the
    // live session, its active user, and the membership row with sequential
    // tenant-scoped queries. The session lookup filters by tenantId — the
    // primary tenant-isolation enforcement (no RLS in MongoDB, ADR-014).
    const resolved = await tenantOp(tenantId, async (db) => {
      const now = new Date();
      const session = await db.collection<SessionDoc>('sessions').findOne({
        refreshTokenHash: hashRefreshToken(refreshToken),
        tenantId,
        revokedAt: null,
        expiresAt: { $gt: now },
      });
      if (!session) return null;
      const user = await db.collection<UserDoc>('users').findOne({ _id: session.userId, isActive: true });
      if (!user) return null;
      const membership = (await membershipsFor(user._id)).find(
        (row) => row.tenantId === session.tenantId
      );
      if (!membership) return null;
      return {
        user: toUserRow(user),
        membership,
        sessionId: session._id,
      };
    });
    if (!resolved) {
      return handleInvalidRefresh(tenantId, refreshToken, req, reply);
    }
    // The rotation update is conditional on the presented hash, so two
    // concurrent refreshes with the same token cannot both succeed: the loser
    // throws InvalidRefreshSessionError and is routed through reuse detection
    // (its token is now superseded) rather than surfacing a 500. Only that
    // typed error is caught here: signing failures, DB errors, and caller
    // cancellation (AbortError) propagate so a broken signer is never
    // misreported as token theft.
    const completeAuth = await buildAuth(resolved.user, resolved.membership);
    try {
      const rotated = await rotateRefreshToken(refreshToken, completeAuth, resolved.sessionId);
      setRefreshCookie(reply, rotated.refreshToken);
      return reply.send({ accessToken: rotated.accessToken, expiresIn: config.JWT_EXPIRES_IN, user: rotated.auth });
    } catch (error) {
      if (error instanceof InvalidRefreshSessionError) {
        return handleInvalidRefresh(tenantId, refreshToken, req, reply);
      }
      throw error;
    }
  });

  // The logout routes take no body, but some clients (e.g. fetch with default
  // JSON headers) send `content-type: application/json` with an empty payload.
  // Fastify's default JSON parser rejects that with FST_ERR_CTP_EMPTY_JSON_BODY
  // before the handler runs, so these routes live in an encapsulated context
  // with a scoped parser that treats an empty JSON body as "no body" instead
  // of a parse error. Nothing else in the app is affected.
  await fastify.register(async function logoutRoutes(instance: FastifyInstance) {
    instance.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
      const text = typeof body === 'string' ? body : body.toString('utf8');
      if (text === '') {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(text));
      } catch (err) {
        // Match the default JSON parser: malformed JSON is a 400, not a 500.
        (err as { statusCode?: number }).statusCode = 400;
        done(err as Error);
      }
    });

    instance.post('/auth/logout', { preHandler: [requireAuth] }, async (req, reply) => {
      await revokeSession(req.auth!.tenantId, req.auth!.sessionId);
      clearRefreshCookie(reply);
      await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'LOGOUT', requestId: req.requestId, ip: req.ip });
      return reply.status(204).send();
    });

    // Log out everywhere: revokes all of the user's sessions, so a stolen
    // refresh token does not survive the victim logging out.
    instance.post('/auth/logout/all', { preHandler: [requireAuth] }, async (req, reply) => {
      const revoked = await revokeAllUserSessions(req.auth!.tenantId, req.auth!.userId);
      clearRefreshCookie(reply);
      await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'LOGOUT_ALL', requestId: req.requestId, ip: req.ip, metadata: { revokedSessions: revoked } });
      return reply.send({ revokedSessions: revoked });
    });
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
    const owned = await tenantOp(req.auth!.tenantId, async (db) =>
      db.collection<SessionDoc>('sessions').findOne(
        { _id: parsed.data.id, tenantId: req.auth!.tenantId, userId: req.auth!.userId, revokedAt: null },
        { projection: { _id: 1 } }
      )
    );
    if (!owned) throw Errors.notFound('SESSION_NOT_FOUND', 'Session not found');
    await revokeSession(req.auth!.tenantId, parsed.data.id);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, action: 'SESSION_REVOKE', requestId: req.requestId, ip: req.ip, resource: 'session', resourceId: parsed.data.id });
    return reply.status(204).send();
  });

  if (config.DEV_AUTH_ENABLED) {
    fastify.post('/auth/dev-login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const parsed = devLoginSchema.safeParse(req.body);
      if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid development login request');
      const db = await getDb();
      const doc = await db.collection<UserDoc>('users').findOne({ email: parsed.data.email });
      const user: UserRow | undefined = doc ? toUserRow(doc) : undefined;
      if (!user?.isActive) throw Errors.unauthorized('USER_NOT_FOUND', 'Development user not found or inactive');
      const membership = chooseMembership(await membershipsFor(user.id), parsed.data.tenantId);
      const response = await issueLogin(user, membership, reply);
      await recordAudit({ tenantId: membership.tenantId, userId: user.id, action: 'DEV_LOGIN', requestId: req.requestId, ip: req.ip });
      return reply.send(response);
    });
  }

  fastify.get('/me', { preHandler: [requireAuth] }, async (req, reply) => reply.send(req.auth));
}
