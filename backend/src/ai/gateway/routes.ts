import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { listApprovedModels } from './modelRegistry.js';

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/models',
    {
      preHandler: [requireAuth, requirePermission('model:use')],
    },
    async (_req, reply) => {
      const approved = await listApprovedModels();
      const models = approved.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        contextWindow: m.context_window,
        capabilities: m.capabilities,
      }));

      return reply.send({ models });
    }
  );
}
