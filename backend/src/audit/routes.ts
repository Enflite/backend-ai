import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Filter } from 'mongodb';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { getDb } from '../db/mongo.js';
import { Errors } from '../errors.js';
import type { AuditEventDoc } from './audit.js';

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

      // Tenant isolation: platform-global rows (tenantId null) are never
      // visible here — the filter pins the caller's tenantId explicitly.
      const filter: Filter<AuditEventDoc> = { tenantId };
      if (action) filter.action = action;

      const db = await getDb();
      const events = await db
        .collection<AuditEventDoc>('audit_events')
        .find(filter)
        .sort({ createdAt: -1 })
        .skip(offset)
        .limit(limit)
        .toArray();
      return reply.send({ events, limit, offset });
    }
  );
}
