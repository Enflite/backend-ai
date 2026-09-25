/**
 * feedbackRoutes.ts — feedback capture API (ADR-015, stage 1).
 *
 *   POST   /feedback        → rate an assistant message (+ optional correction)
 *   GET    /feedback        → list (curators see all; authors see their own)
 *   GET    /feedback/:id    → one row
 *   PATCH  /feedback/:id    → curate (approve/reject into the training pipeline)
 *
 * All endpoints require auth and are tenant-scoped. Submitting needs
 * `feedback:submit`; curating needs `feedback:curate`. Every write is
 * audited.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  createFeedback,
  curateFeedback,
  getFeedback,
  listFeedback,
  FEEDBACK_RATINGS,
  FEEDBACK_STATUSES,
  FeedbackContext,
} from './feedbackStore.js';

const uuidSchema = z.string().uuid();

const createSchema = z.object({
  conversationId: uuidSchema,
  messageId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(100).optional(),
  rating: z.enum(FEEDBACK_RATINGS),
  correction: z.string().trim().min(1).max(8000).optional(),
  comment: z.string().trim().min(1).max(2000).optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
}).strict();

const listQuerySchema = z.object({
  status: z.enum(FEEDBACK_STATUSES).optional(),
  rating: z.enum(FEEDBACK_RATINGS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const curateSchema = z.object({
  status: z.enum(['approved', 'rejected'] as const),
}).strict();

function contextOf(auth: AuthContext): FeedbackContext {
  return { tenantId: auth.tenantId, userId: auth.userId, clearance: auth.clearance };
}

export async function feedbackRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/feedback', { preHandler: [requireAuth, requirePermission('feedback:submit')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid feedback parameters');
    const feedback = await createFeedback(contextOf(auth), parsed.data);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'FEEDBACK_SUBMIT',
      resource: 'feedback',
      resourceId: feedback._id,
      classification: feedback.classification,
    });
    return reply.status(201).send({ feedback });
  });

  fastify.get('/feedback', { preHandler: [requireAuth, requirePermission('feedback:curate')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.badRequest('INVALID_QUERY', 'Invalid query parameters');
    const items = await listFeedback(contextOf(auth), parsed.data);
    return reply.send({ feedback: items, pagination: { limit: parsed.data.limit, offset: parsed.data.offset } });
  });

  fastify.get('/feedback/:id', { preHandler: [requireAuth, requirePermission('feedback:curate')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid feedback id');
    const feedback = await getFeedback(contextOf(auth), params.data.id);
    if (!feedback) throw Errors.notFound('FEEDBACK_NOT_FOUND', 'Feedback not found');
    return reply.send({ feedback });
  });

  fastify.patch('/feedback/:id', { preHandler: [requireAuth, requirePermission('feedback:curate')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    const body = curateSchema.safeParse(req.body ?? {});
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid curate parameters');
    const feedback = await curateFeedback(contextOf(auth), params.data.id, body.data.status);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: body.data.status === 'approved' ? 'FEEDBACK_APPROVE' : 'FEEDBACK_REJECT',
      resource: 'feedback',
      resourceId: feedback._id,
      classification: feedback.classification,
    });
    return reply.send({ feedback });
  });
}
