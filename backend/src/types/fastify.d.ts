import { AuthContext } from '../authz/permissions.js';

declare module 'fastify' {
  interface FastifyRequest {
    requestId: string;
    traceId: string;
    auth?: AuthContext;
  }
}
