import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './jwt.js';
import { Errors } from '../errors.js';
import { tenantQuery } from '../db/pool.js';
import { recordAudit } from '../audit/audit.js';

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
    const session = await tenantQuery<{ role_id: string; role_name: string; permissions: string[] }>(
      auth.tenantId,
      `SELECT r.id AS role_id, r.name AS role_name, array_agg(p.name ORDER BY p.name) AS permissions
       FROM sessions s
       JOIN users u ON u.id = s.user_id AND u.is_active
       JOIN memberships m ON m.user_id = s.user_id AND m.tenant_id = s.tenant_id
       JOIN roles r ON r.id = m.role_id
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE s.id = $1 AND s.user_id = $2 AND s.tenant_id = $3
         AND s.revoked_at IS NULL AND s.expires_at > NOW()
       GROUP BY r.id, r.name`,
      [auth.sessionId, auth.userId, auth.tenantId]
    );
    if (session.rowCount !== 1) {
      throw new Error('Session is invalid');
    }
    req.auth = {
      ...auth,
      roleId: session.rows[0]!.role_id,
      roleName: session.rows[0]!.role_name,
      permissions: session.rows[0]!.permissions as typeof auth.permissions,
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
