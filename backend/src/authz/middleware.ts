import { FastifyRequest, FastifyReply } from 'fastify';
import { Permission } from './permissions.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';

export function requirePermission(permission: Permission) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.auth) {
      throw Errors.unauthorized('AUTHENTICATION_REQUIRED', 'Authentication required');
    }
    if (!req.auth.permissions.includes(permission)) {
      await recordAudit({
        tenantId: req.auth.tenantId,
        userId: req.auth.userId,
        requestId: req.requestId,
        ip: req.ip,
        action: 'AUTHORIZATION_FAILURE',
        success: false,
        reason: `Missing permission: ${permission}`,
        metadata: { method: req.method, route: req.routeOptions.url },
      });
      throw Errors.forbidden(
        'AUTHORIZATION_FAILURE',
        `Missing required permission: ${permission}`
      );
    }
  };
}
