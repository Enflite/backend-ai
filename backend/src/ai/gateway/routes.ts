import { FastifyInstance } from 'fastify';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { listApprovedModelsForUser } from './modelRegistry.js';

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/models',
    {
      preHandler: [requireAuth, requirePermission('model:use')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const approved = await listApprovedModelsForUser(auth.tenantId, auth.userId, auth.roleId);
      const models = approved.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        contextWindow: m.context_window,
        capabilities: m.capabilities,
        allowedClassifications: m.allowed_classifications,
        provider: m.provider,
      }));

      return reply.send({ models });
    }
  );
}
