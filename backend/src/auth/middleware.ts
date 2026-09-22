import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './jwt.js';
import { Errors } from '../errors.js';
import { tenantOp } from '../db/mongo.js';
import { recordAudit } from '../audit/audit.js';

interface SessionDoc {
  _id: string;
  userId: string;
  tenantId: string;
  refreshTokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
}

interface MembershipDoc {
  _id: string;
  userId: string;
  tenantId: string;
  roleId: string;
}

export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw Errors.unauthorized('MISSING_TOKEN', 'Authorization header with Bearer token required');
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    throw Errors.unauthorized('MISSING_TOKEN', 'Authorization token is empty');
  }

  try {
    const auth = await verifyToken(token);
    // Replaces the PostgreSQL join + GROUP BY permission aggregation:
    // resolve the live session, the active user, their tenant membership,
    // and the role's permission names with sequential tenant-scoped
    // queries. Every query filters by tenantId — the primary enforcement
    // (no RLS in MongoDB, ADR-014).
    const resolved = await tenantOp(auth.tenantId, async (db) => {
      const now = new Date();
      const session = await db.collection<SessionDoc>('sessions').findOne({
        _id: auth.sessionId,
        userId: auth.userId,
        tenantId: auth.tenantId,
        revokedAt: null,
        expiresAt: { $gt: now },
      });
      if (!session) return null;
      const user = await db.collection<{ _id: string; isActive: boolean }>('users').findOne(
        { _id: auth.userId, isActive: true },
        { projection: { isActive: 1 } }
      );
      if (!user) return null;
      const membership = await db.collection<MembershipDoc>('memberships').findOne({
        userId: auth.userId,
        tenantId: auth.tenantId,
      });
      if (!membership) return null;
      const role = await db.collection<{ _id: string; name: string }>('roles').findOne(
        { _id: membership.roleId },
        { projection: { name: 1 } }
      );
      if (!role) return null;
      const rolePermissions = await db.collection<{ _id: string; permissionId: string }>('role_permissions')
        .find({ roleId: role._id }, { projection: { permissionId: 1 } })
        .toArray();
      const permissionIds = rolePermissions.map((rp) => rp.permissionId);
      const permissions = await db.collection<{ _id: string; name: string }>('permissions')
        .find({ _id: { $in: permissionIds } }, { projection: { name: 1 } })
        .toArray();
      const names = permissions.map((p) => p.name).sort();
      return { roleId: role._id, roleName: role.name, permissions: names };
    });
    if (!resolved) {
      throw new Error('Session is invalid');
    }
    req.auth = {
      ...auth,
      roleId: resolved.roleId,
      roleName: resolved.roleName,
      permissions: resolved.permissions as typeof auth.permissions,
    };
  } catch {
    await recordAudit({
      action: 'AUTHENTICATION_FAILURE',
      success: false,
      reason: 'INVALID_OR_EXPIRED_TOKEN',
      requestId: req.requestId,
      ip: req.ip,
    });
    throw Errors.unauthorized('INVALID_TOKEN', 'Invalid or expired token');
  }
}
