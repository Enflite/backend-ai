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

export async function rotateRefreshToken(
  oldToken: string,
  auth: Omit<AuthContext, 'sessionId'>,
  sessionId: string
): Promise<{ auth: AuthContext; accessToken: string; refreshToken: string }> {
  const refreshToken = makeRefreshToken(auth.tenantId);
  const result = await tenantQuery(
    auth.tenantId,
    `UPDATE sessions
     SET refresh_token_hash = $1, last_used_at = NOW()
     WHERE id = $2 AND user_id = $3 AND refresh_token_hash = $4
       AND revoked_at IS NULL AND expires_at > NOW()
     RETURNING id`,
    [hashRefreshToken(refreshToken), sessionId, auth.userId, hashRefreshToken(oldToken)]
  );
  if (result.rowCount !== 1) throw new Error('Refresh session is invalid');
  const completeAuth = { ...auth, sessionId };
  return { auth: completeAuth, accessToken: await signToken(completeAuth), refreshToken };
}

export async function revokeSession(tenantId: string, sessionId: string): Promise<void> {
  await tenantQuery(tenantId, 'UPDATE sessions SET revoked_at = NOW() WHERE id = $1', [sessionId]);
}
