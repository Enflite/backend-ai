import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { tenantOp } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { recordAudit } from '../audit/audit.js';
import { getApprovedModelForUser } from '../ai/gateway/modelRegistry.js';
import { resolveDefaultOpenModel } from '../ai/gateway/capabilityRouter.js';

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

export interface Conversation {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  model_id: string;
  classification: string;
  created_at: Date;
  updated_at: Date;
}

/**
 * MongoDB document shape for the `conversations` collection: camelCase
 * fields, `_id` is the UUID string (ADR-014). `model` (the denormalized
 * serving-model name) is storage-only — it is not part of the Conversation
 * API view, which keeps its original snake_case shape.
 */
interface ConversationDoc {
  _id: string;
  tenantId: string;
  userId: string;
  title: string;
  model: string;
  modelId: string;
  classification: string;
  createdAt: Date;
  updatedAt: Date;
}

function toConversation(doc: ConversationDoc): Conversation {
  return {
    id: doc._id,
    tenant_id: doc.tenantId,
    user_id: doc.userId,
    title: doc.title,
    model_id: doc.modelId,
    classification: doc.classification,
    created_at: doc.createdAt,
    updated_at: doc.updatedAt,
  };
}

/** MongoDB document shape for the `messages` collection. */
interface MessageDoc {
  _id: string;
  conversationId: string;
  tenantId: string;
  role: string;
  content: string;
  model?: string;
  modelId?: string;
  citations?: unknown;
  metadata?: unknown;
  createdAt: Date;
}

export async function conversationRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/conversations', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const pagination = paginationSchema.safeParse(req.query);
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    const docs = await tenantOp(auth.tenantId, (db) =>
      db
        .collection<ConversationDoc>('conversations')
        .find({ tenantId: auth.tenantId, userId: auth.userId })
        .sort({ updatedAt: -1 })
        .skip(pagination.data.offset)
        .limit(pagination.data.limit)
        .toArray()
    );
    return reply.send({ conversations: docs.map(toConversation), pagination: pagination.data });
  });

  fastify.post('/conversations', { preHandler: [requireAuth, requirePermission('chat:create')] }, async (req, reply) => {
    const auth = req.auth!;
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid conversation parameters');
    // Clearance-aware default: a PUBLIC caller omitting classification gets
    // PUBLIC, not INTERNAL (which they are not cleared for).
    const classification = body.data.classification ?? (auth.clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL');
    assertClassificationAllowed(auth.clearance, classification);
    // Default-open: the admin's chat serving default, else the first
    // approved model, else the ensured tenant default — so a user with no
    // explicit model grants still gets a model. resolveDefaultOpenModel
    // throws MODEL_UNAVAILABLE only when no servable model exists at all.
    const modelId =
      body.data.modelId ?? (await resolveDefaultOpenModel(auth.tenantId, auth.userId, auth.roleId)).id;
    const model = await getApprovedModelForUser(modelId, auth.tenantId, auth.userId, auth.roleId);
    const now = new Date();
    const doc: ConversationDoc = {
      _id: randomUUID(),
      tenantId: auth.tenantId,
      userId: auth.userId,
      title: body.data.title ?? 'New Conversation',
      model: model.name,
      modelId,
      classification,
      createdAt: now,
      updatedAt: now,
    };
    await tenantOp(auth.tenantId, async (db) => {
      await db.collection<ConversationDoc>('conversations').insertOne(doc);
    });
    return reply.status(201).send({ conversation: toConversation(doc) });
  });

  fastify.get('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    const doc = await tenantOp(auth.tenantId, (db) =>
      db.collection<ConversationDoc>('conversations').findOne(
        { _id: params.data.id, tenantId: auth.tenantId, userId: auth.userId }
      )
    );
    if (!doc) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'CONVERSATION_ACCESS', resource: 'conversation', resourceId: params.data.id });
    return reply.send({ conversation: toConversation(doc) });
  });

  fastify.get('/conversations/:id/messages', { preHandler: [requireAuth, requirePermission('conversation:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    const pagination = paginationSchema.safeParse(req.query);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    // The SQL JOIN verified conversation ownership inline; in MongoDB this
    // is a two-step: confirm the conversation belongs to the caller first
    // (404 when it does not exist or is not theirs), then list its messages.
    const messages = await tenantOp(auth.tenantId, async (db) => {
      const conversation = await db.collection<ConversationDoc>('conversations').findOne(
        { _id: params.data.id, tenantId: auth.tenantId, userId: auth.userId },
        { projection: { _id: 1 } }
      );
      if (!conversation) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      const docs = await db
        .collection<MessageDoc>('messages')
        .find({ conversationId: params.data.id, tenantId: auth.tenantId })
        .sort({ createdAt: 1 })
        .skip(pagination.data.offset)
        .limit(pagination.data.limit)
        .toArray();
      return docs.map(({ _id, conversationId, role, content, modelId, citations, metadata, createdAt }) => ({
        id: _id,
        conversationId,
        role,
        content,
        modelId,
        citations,
        metadata,
        createdAt,
      }));
    });
    return reply.send({ messages, pagination: pagination.data });
  });

  fastify.patch('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:update')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    const body = updateSchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid conversation update');
    const doc = await tenantOp(auth.tenantId, (db) =>
      db.collection<ConversationDoc>('conversations').findOneAndUpdate(
        { _id: params.data.id, tenantId: auth.tenantId, userId: auth.userId },
        { $set: { title: body.data.title, updatedAt: new Date() } },
        { returnDocument: 'after' }
      )
    );
    if (!doc) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
    return reply.send({ conversation: toConversation(doc) });
  });

  fastify.delete('/conversations/:id', { preHandler: [requireAuth, requirePermission('conversation:delete')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid conversation ID');
    await tenantOp(auth.tenantId, async (db) => {
      const conversation = await db.collection<ConversationDoc>('conversations').findOne(
        { _id: params.data.id, tenantId: auth.tenantId, userId: auth.userId },
        { projection: { _id: 1 } }
      );
      if (!conversation) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      // Explicit cascade: PostgreSQL's ON DELETE CASCADE has no MongoDB
      // equivalent, so messages are deleted first, then the conversation.
      await db.collection<MessageDoc>('messages').deleteMany({ conversationId: params.data.id, tenantId: auth.tenantId });
      await db.collection<ConversationDoc>('conversations').deleteOne({ _id: params.data.id, tenantId: auth.tenantId });
    });
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip, action: 'CONVERSATION_DELETE', resource: 'conversation', resourceId: params.data.id });
    return reply.status(204).send();
  });
}
