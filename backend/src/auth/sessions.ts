import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { FastifyReply } from 'fastify';
import { config } from '../config.js';
import { tenantOp } from '../db/mongo.js';
import { AuthContext } from '../authz/permissions.js';
import { signToken } from './jwt.js';

export const REFRESH_COOKIE = 'enflite_refresh';

interface SessionDoc {
  _id: string;
  userId: string;
  tenantId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date;
  createdAt: Date;
  replacedRefreshTokenHash: string | null;
  replacedAt: Date | null;
  previousRefreshTokenHashes: string[];
}

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
  const now = new Date();
  await tenantOp(auth.tenantId, async (db) => {
    await db.collection<SessionDoc>('sessions').insertOne({
      _id: sessionId,
      userId: auth.userId,
      tenantId: auth.tenantId,
      refreshTokenHash: hashRefreshToken(refreshToken),
      expiresAt: new Date(now.getTime() + config.REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000),
      revokedAt: null,
      lastUsedAt: now,
      createdAt: now,
      replacedRefreshTokenHash: null,
      replacedAt: null,
      previousRefreshTokenHashes: [] as string[],
    });
  });
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
 * Thrown when the conditional rotation update matches no session document:
 * the presented token is unknown, expired, revoked, or was already rotated
 * (the concurrent-rotation loser). Callers must catch only this error for
 * reuse handling; signing failures, DB errors, and caller cancellation
 * (AbortError) must propagate so a broken signer is never misreported as
 * token theft (which would revoke every session of an innocent user).
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
  const oldHash = hashRefreshToken(oldToken);
  const now = new Date();
  // The update is conditional on the presented hash, so two concurrent
  // refreshes with the same token cannot both succeed: findOneAndUpdate is
  // atomic, the loser gets null and is routed through reuse detection (its
  // token is now superseded) rather than surfacing a 500.
  const updated = await tenantOp(auth.tenantId, async (db) =>
    db.collection<SessionDoc>('sessions').findOneAndUpdate(
      {
        _id: sessionId,
        userId: auth.userId,
        tenantId: auth.tenantId,
        refreshTokenHash: oldHash,
        revokedAt: null,
        expiresAt: { $gt: now },
      },
      {
        $set: {
          refreshTokenHash: hashRefreshToken(refreshToken),
          replacedRefreshTokenHash: oldHash,
          replacedAt: now,
          lastUsedAt: now,
        },
        // Prepend the superseded hash, keeping the five most recent —
        // the MongoDB equivalent of (ARRAY[$4] || prev)[1:5].
        $push: {
          previousRefreshTokenHashes: { $each: [oldHash], $position: 0, $slice: 5 },
        },
      },
      { returnDocument: 'after' }
    )
  );
  if (!updated) throw new InvalidRefreshSessionError('Refresh session is invalid');
  const completeAuth = { ...auth, sessionId };
  return { auth: completeAuth, accessToken: await signToken(completeAuth), refreshToken };
}

/**
 * Refresh-token reuse detection. After rotation the superseded token hashes
 * are retained (most recent in replacedRefreshTokenHash, last five in
 * previousRefreshTokenHashes); if a superseded hash is ever presented again
 * the token was likely stolen (legitimate clients only ever hold the newest
 * token). Returns the owning user when reuse is detected so the caller can
 * revoke everything.
 */
export async function findRefreshReuse(
  tenantId: string,
  token: string
): Promise<{ sessionId: string; userId: string } | null> {
  const hash = hashRefreshToken(token);
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  const doc = await tenantOp(tenantId, async (db) =>
    db.collection<SessionDoc>('sessions').findOne(
      {
        tenantId,
        $or: [
          { replacedRefreshTokenHash: hash, replacedAt: { $gt: tenMinutesAgo } },
          // Multikey equality match on the array — the MongoDB equivalent
          // of the GIN-indexed `@> ARRAY[$1]` containment check.
          { previousRefreshTokenHashes: hash },
        ],
      },
      { projection: { userId: 1 } }
    )
  );
  return doc ? { sessionId: doc._id, userId: doc.userId } : null;
}

export async function revokeSession(tenantId: string, sessionId: string): Promise<void> {
  await tenantOp(tenantId, async (db) => {
    await db.collection<SessionDoc>('sessions').updateOne(
      { _id: sessionId, tenantId },
      { $set: { revokedAt: new Date() } }
    );
  });
}

export async function revokeAllUserSessions(tenantId: string, userId: string): Promise<number> {
  return tenantOp(tenantId, async (db) => {
    const result = await db.collection<SessionDoc>('sessions').updateMany(
      { tenantId, userId, revokedAt: null },
      { $set: { revokedAt: new Date() } }
    );
    return result.modifiedCount;
  });
}

export interface SessionSummary {
  id: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revoked: boolean;
}

export async function listUserSessions(tenantId: string, userId: string): Promise<SessionSummary[]> {
  const docs = await tenantOp(tenantId, async (db) =>
    db.collection<SessionDoc>('sessions')
      .find({ tenantId, userId })
      .sort({ lastUsedAt: -1 })
      .limit(50)
      .toArray()
  );
  return docs.map((doc) => ({
    id: doc._id,
    createdAt: doc.createdAt.toISOString(),
    lastUsedAt: doc.lastUsedAt.toISOString(),
    expiresAt: doc.expiresAt.toISOString(),
    revoked: doc.revokedAt != null,
  }));
}
