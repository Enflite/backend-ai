import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FastifyReply } from 'fastify';
import { config } from '../config.js';
import { tenantQuery } from '../db/pool.js';
import { AuthContext } from '../authz/permissions.js';
import { signToken } from './jwt.js';

export const REFRESH_COOKIE = 'enflite_refresh';

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function makeRefreshToken(tenantId: string): string {
  return `${tenantId}.${randomBytes(48).toString('base64url')}`;
}

export function refreshTokenTenant(token: string): string | null {
  const separator = token.indexOf('.');
  if (separator < 1) return null;
  const tenantId = token.slice(0, separator);
  return /^[0-9a-f-]{36}$/i.test(tenantId) ? tenantId : null;
}

export async function createSession(
  auth: Omit<AuthContext, 'sessionId'>
): Promise<{ auth: AuthContext; accessToken: string; refreshToken: string }> {
  const sessionId = randomUUID();
  const refreshToken = makeRefreshToken(auth.tenantId);
  await tenantQuery(
    auth.tenantId,
    `INSERT INTO sessions (id, user_id, tenant_id, refresh_token_hash, expires_at)
     VALUES ($1, $2, $3, $4, NOW() + ($5 || ' days')::interval)`,
    [sessionId, auth.userId, auth.tenantId, hashRefreshToken(refreshToken), config.REFRESH_TOKEN_EXPIRES_DAYS]
  );
  const completeAuth = { ...auth, sessionId };
  return { auth: completeAuth, accessToken: await signToken(completeAuth), refreshToken };
}

export function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/v1/auth',
    maxAge: config.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60,
  });
}

export function clearRefreshCookie(reply: FastifyReply): void {
  reply.clearCookie(REFRESH_COOKIE, {
    httpOnly: true,
    secure: config.COOKIE_SECURE,
    sameSite: 'strict',
    path: '/api/v1/auth',
  });
}

/**
 * Thrown when the conditional rotation UPDATE matches no session row: the
 * presented token is unknown, expired, revoked, or was already rotated (the
 * concurrent-rotation loser). Callers must catch only this error for reuse
 * handling; signing failures, DB errors, and caller cancellation (AbortError)
 * must propagate so a broken signer is never misreported as token theft
 * (which would revoke every session of an innocent user).
 */
export class InvalidRefreshSessionError extends Error {
  constructor(message = 'Refresh session is invalid') {
    super(message);
    this.name = 'InvalidRefreshSessionError';
  }
}

export async function rotateRefreshToken(
  oldToken: string,
  auth: Omit<AuthContext, 'sessionId'>,
  sessionId: string
): Promise<{ auth: AuthContext; accessToken: string; refreshToken: string }> {
  const refreshToken = makeRefreshToken(auth.tenantId);
  const result = await tenantQuery(
    auth.tenantId,
    `UPDATE sessions
     SET refresh_token_hash = $1,
         replaced_refresh_token_hash = $4,
         replaced_at = NOW(),
         previous_refresh_token_hashes = (ARRAY[$4] || COALESCE(previous_refresh_token_hashes, '{}'))[1:5],
         last_used_at = NOW()
     WHERE id = $2 AND user_id = $3 AND refresh_token_hash = $4
       AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [hashRefreshToken(refreshToken), sessionId, auth.userId, hashRefreshToken(oldToken)]
  );
  if (result.rowCount !== 1) throw new InvalidRefreshSessionError('Refresh session is invalid');
  const completeAuth = { ...auth, sessionId };
  return { auth: completeAuth, accessToken: await signToken(completeAuth), refreshToken };
}

/**
 * Refresh-token reuse detection. After rotation the superseded token hashes
 * are retained (most recent in replaced_refresh_token_hash, last five in
 * previous_refresh_token_hashes); if a superseded hash is ever presented again
 * the token was likely stolen (legitimate clients only ever hold the newest
 * token). Returns the owning user when reuse is detected so the caller can
 * revoke everything.
 */
export async function findRefreshReuse(
  tenantId: string,
  token: string
): Promise<{ sessionId: string; userId: string } | null> {
  const row = (
    await tenantQuery<{ id: string; user_id: string }>(
      tenantId,
      // previous_refresh_token_hashes is GIN-indexed (migration 012): use the
      // containment operator so the history lookup stays index-backed instead
      // of a sequential scan with `= ANY`.
      `SELECT id, user_id FROM sessions
       WHERE (replaced_refresh_token_hash = $1 AND replaced_at > NOW() - INTERVAL '10 minutes')
          OR (previous_refresh_token_hashes @> ARRAY[$1])`,
      [hashRefreshToken(token)]
    )
  ).rows[0];
  return row ? { sessionId: row.id, userId: row.user_id } : null;
}

export async function revokeSession(tenantId: string, sessionId: string): Promise<void> {
  await tenantQuery(tenantId, 'UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [sessionId]);
}

export async function revokeAllUserSessions(tenantId: string, userId: string): Promise<number> {
  const result = await tenantQuery(
    tenantId,
    'UPDATE sessions SET revoked_at = NOW() WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL',
    [tenantId, userId]
  );
  return result.rowCount ?? 0;
}

export interface SessionSummary {
  id: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked: boolean;
}

export async function listUserSessions(tenantId: string, userId: string): Promise<SessionSummary[]> {
  const result = await tenantQuery<SessionSummary>(
    tenantId,
    `SELECT id, created_at, last_used_at, expires_at, revoked_at IS NOT NULL AS revoked
     FROM sessions WHERE tenant_id = $1 AND user_id = $2 ORDER BY last_used_at DESC LIMIT 50`,
    [tenantId, userId]
  );
  return result.rows;
}
