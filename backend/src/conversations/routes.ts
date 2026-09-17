import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { Errors } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { recordAudit } from '../audit/audit.js';

const idParamSchema = z.object({
  id: z.string().uuid(),
});

const createConversationSchema = z.object({
  title: z.string().min(1).max(255).optional(),
  model: z.string().optional(),
});

const updateConversationSchema = z.object({
  title: z.string().min(1).max(255),
});

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  // GET /conversations
  fastify.get(
    '/conversations',
    {
      preHandler: [requireAuth, requirePermission('conversation:read')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const result = await query(
        `SELECT id, tenant_id, user_id, title, model, created_at, updated_at
         FROM conversations
         WHERE tenant_id = $1 AND user_id = $2
         ORDER BY updated_at DESC`,
        [auth.tenantId, auth.userId]
      );

      return reply.send({ conversations: result.rows });
    }
  );

  // POST /conversations
  fastify.post(
    '/conversations',
    {
      preHandler: [requireAuth, requirePermission('chat:create')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = createConversationSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw Errors.badRequest('INVALID_REQUEST', 'Invalid conversation parameters', parsed.error.format());
      }

      const title = parsed.data.title ?? 'New Conversation';
      const model = parsed.data.model ?? config.VLLM_MODEL;

      const result = await query(
        `INSERT INTO conversations (tenant_id, user_id, title, model)
         VALUES ($1, $2, $3, $4)
         RETURNING id, tenant_id, user_id, title, model, created_at, updated_at`,
        [auth.tenantId, auth.userId, title, model]
      );

      return reply.status(201).send({ conversation: result.rows[0] });
    }
  );

  // GET /conversations/:id
  fastify.get(
    '/conversations/:id',
    {
      preHandler: [requireAuth, requirePermission('conversation:read')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) {
        throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID format');
      }

      const result = await query(
        `SELECT id, tenant_id, user_id, title, model, created_at, updated_at
         FROM conversations
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [params.data.id, auth.tenantId, auth.userId]
      );

      const conv = result.rows[0];
      if (!conv) {
        throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      }

      return reply.send({ conversation: conv });
    }
  );

  // GET /conversations/:id/messages
  fastify.get(
    '/conversations/:id/messages',
    {
      preHandler: [requireAuth, requirePermission('conversation:read')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) {
        throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID format');
      }

      const convRes = await query(
        `SELECT id FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
        [params.data.id, auth.tenantId, auth.userId]
      );

      if (convRes.rows.length === 0) {
        throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      }

      const result = await query(
        `SELECT id, conversation_id, tenant_id, role, content, model, prompt_tokens, completion_tokens, created_at
         FROM messages
         WHERE conversation_id = $1 AND tenant_id = $2
         ORDER BY created_at ASC`,
        [params.data.id, auth.tenantId]
      );

      return reply.send({ messages: result.rows });
    }
  );

  // PATCH /conversations/:id
  fastify.patch(
    '/conversations/:id',
    {
      preHandler: [requireAuth, requirePermission('conversation:read')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) {
        throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID format');
      }

      const body = updateConversationSchema.safeParse(req.body);
      if (!body.success) {
        throw Errors.badRequest('INVALID_BODY', 'Invalid update parameters', body.error.format());
      }

      const result = await query(
        `UPDATE conversations
         SET title = $1, updated_at = NOW()
         WHERE id = $2 AND tenant_id = $3 AND user_id = $4
         RETURNING id, tenant_id, user_id, title, model, created_at, updated_at`,
        [body.data.title, params.data.id, auth.tenantId, auth.userId]
      );

      const conv = result.rows[0];
      if (!conv) {
        throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      }

      return reply.send({ conversation: conv });
    }
  );

  // DELETE /conversations/:id
  fastify.delete(
    '/conversations/:id',
    {
      preHandler: [requireAuth, requirePermission('conversation:delete')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = idParamSchema.safeParse(req.params);
      if (!params.success) {
        throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID format');
      }

      const result = await query(
        `DELETE FROM conversations
         WHERE id = $1 AND tenant_id = $2 AND user_id = $3
         RETURNING id`,
        [params.data.id, auth.tenantId, auth.userId]
      );

      if (result.rows.length === 0) {
        throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      }

      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        ip: req.ip,
        action: 'CONVERSATION_DELETE',
        resource: 'conversation',
        resourceId: params.data.id,
        success: true,
      });

      return reply.send({ success: true });
    }
  );
}
