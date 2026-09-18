import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { recordAudit } from '../audit/audit.js';
import { getApprovedModelForUser, listApprovedModelsForUser } from '../ai/gateway/modelRegistry.js';

const idSchema = z.object({ id: z.string().uuid() });
const createSchema = z.object({
  title: z.string().trim().min(1).max(255).optional(),
  modelId: z.string().uuid().optional(),
  // Optional: an omitted classification resolves to the caller's own clearance
  // floor (PUBLIC for public-only callers) so valid PUBLIC callers are not
  // forced into a classification they are not cleared for.
  classification: z.enum(CLASSIFICATIONS).optional(),
}).strict();
const updateSchema = z.object({ title: z.string().trim().min(1).max(255) }).strict();
const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/conversations', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    const result = await tenantQuery(
      auth.tenantId,
      `SELECT id, tenant_id, user_id, title, model_id, classification, created_at, updated_at
       FROM conversations WHERE tenant_id = $1 AND user_id = $2 ORDER BY updated_at DESC LIMIT $3 OFFSET $4`,
      [auth.tenantId, auth.userId, pagination.data.limit, pagination.data.offset]
    );
    return reply.send({ conversations: result.rows, pagination: pagination.data });
  });

  fastify.post('/conversations', { preHandler: [requireAuth, requirePermission('chat:create')] }, async (req, reply) => {
    const auth = req.auth!;
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid conversation parameters');
    // Clearance-aware default: a PUBLIC caller omitting classification gets
    // PUBLIC, not INTERNAL (which they are not cleared for).
    const classification = body.data.classification ?? (auth.clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL');
    assertClassificationAllowed(auth.clearance, classification);
    const modelId = body.data.modelId ?? (await listApprovedModelsForUser(auth.tenantId, auth.userId, auth.roleId))[0]?.id;
    if (!modelId) throw Errors.forbidden('NO_APPROVED_MODEL', 'No approved model is available');
    const model = await getApprovedModelForUser(modelId, auth.tenantId, auth.userId, auth.roleId);
    const result = await tenantQuery(
      auth.tenantId,
      `INSERT INTO conversations (tenant_id, user_id, title, model, model_id, classification)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, tenant_id, user_id, title, model_id, classification, created_at, updated_at`,
      [auth.tenantId, auth.userId, body.data.title ?? 'New Conversation', model.name, modelId, classification]
    );
    return reply.status(201).send({ conversation: result.rows[0] });
  });

  fastify.get('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    const conversation = (
      await tenantQuery(auth.tenantId, `SELECT id, tenant_id, user_id, title, model_id, classification, created_at, updated_at FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3`, [params.data.id, auth.tenantId, auth.userId])
    ).rows[0];
    if (!conversation) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'CONVERSATION_ACCESS', resource: 'conversation', resourceId: params.data.id });
    return reply.send({ conversation });
  });

  fastify.get('/conversations/:id/messages', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    const pagination = paginationSchema.safeParse(req.query);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    const result = await tenantQuery(
      auth.tenantId,
      `SELECT m.id, m.conversation_id, m.role, m.content, m.model_id, m.citations, m.created_at
       FROM messages m JOIN conversations c ON c.id = m.conversation_id AND c.tenant_id = m.tenant_id
       WHERE m.conversation_id = $1 AND m.tenant_id = $2 AND c.user_id = $3 ORDER BY m.created_at LIMIT $4 OFFSET $5`,
      [params.data.id, auth.tenantId, auth.userId, pagination.data.limit, pagination.data.offset]
    );
    if (result.rowCount === 0) {
      const exists = await tenantQuery(auth.tenantId, 'SELECT 1 FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3', [params.data.id, auth.tenantId, auth.userId]);
      if (exists.rowCount === 0) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    }
    return reply.send({ messages: result.rows, pagination: pagination.data });
  });

  fastify.patch('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:update')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    const body = updateSchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid conversation update');
    const conversation = (
      await tenantQuery(auth.tenantId, `UPDATE conversations SET title = $1, updated_at = NOW() WHERE id = $2 AND tenant_id = $3 AND user_id = $4 RETURNING id, tenant_id, user_id, title, model_id, classification, created_at, updated_at`, [body.data.title, params.data.id, auth.tenantId, auth.userId])
    ).rows[0];
    if (!conversation) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    return reply.send({ conversation });
  });

  fastify.delete('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:delete')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    const result = await tenantQuery(auth.tenantId, 'DELETE FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3 RETURNING id', [params.data.id, auth.tenantId, auth.userId]);
    if (result.rowCount === 0) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip, action: 'CONVERSATION_DELETE', resource: 'conversation', resourceId: params.data.id });
    return reply.status(204).send();
  });
}
