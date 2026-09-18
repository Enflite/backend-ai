import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';

const querySchema = z.object({
  action: z.string().optional(),
  limit: z.coerce.number().min(1).max(200).default(50),
  offset: z.coerce.number().min(0).default(0),
});

export async function auditRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/audit',
    {
      preHandler: [requireAuth, requirePermission('audit:read')],
    },
    async (req, reply) => {
      if (!req.auth) {
        throw Errors.unauthorized();
      }

      const parsedQuery = querySchema.safeParse(req.query);
      if (!parsedQuery.success) {
        throw Errors.badRequest('INVALID_QUERY', 'Invalid query parameters', parsedQuery.error.format());
      }

      const { action, limit, offset } = parsedQuery.data;
      const tenantId = req.auth.tenantId;

      let sql = 'SELECT id, tenant_id, user_id, request_id, ip, action, resource, resource_id, classification, model, tool, success, reason, metadata, created_at FROM audit_events WHERE tenant_id = $1';
      const params: unknown[] = [tenantId];

      if (action) {
        params.push(action);
        sql += ` AND action = $${params.length}`;
      }

      params.push(limit);
      sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

      params.push(offset);
      sql += ` OFFSET $${params.length}`;

      const result = await tenantQuery(tenantId, sql, params);
      return reply.send({ events: result.rows, limit, offset });
    }
  );
}
