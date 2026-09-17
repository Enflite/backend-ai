import { FastifyRequest, FastifyReply } from 'fastify';
import { verifyToken } from './jwt.js';
import { Errors } from '../errors.js';

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
    req.auth = auth;
  } catch {
    throw Errors.unauthorized('INVALID_TOKEN', 'Invalid or expired token');
  }
}
