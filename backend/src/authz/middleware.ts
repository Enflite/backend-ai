import { FastifyRequest, FastifyReply } from 'fastify';
import { Permission } from './permissions.js';
import { Errors } from '../errors.js';

export function requirePermission(permission: Permission) {
  return async function (req: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!req.auth) {
      throw Errors.unauthorized('AUTHENTICATION_REQUIRED', 'Authentication required');
    }
    if (!req.auth.permissions.includes(permission)) {
      throw Errors.forbidden(
        'AUTHORIZATION_FAILURE',
        `Missing required permission: ${permission}`
      );
    }
  };
}
