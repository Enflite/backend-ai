/**
 * routes.ts — user memory CRUD API (Phase: persistent user memory).
 *
 *   GET    /memory        → list the caller's own facts (most-recent first)
 *   POST   /memory        → store a new fact
 *   GET    /memory/:id    → one fact
 *   PATCH  /memory/:id    → update fact text / category / classification
 *   DELETE /memory/:id    → delete a fact
 *
 * All endpoints require auth; every query is scoped by the caller's
 * tenant_id AND user_id (see memory/store.ts), so users can see and delete
 * exactly what the assistant remembers about them — and nothing about
 * anyone else. Create/update/delete are audited; reads of a single fact
 * are audited like conversation reads (listing is not, by the same
 * convention).
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS } from '../authz/permissions.js';
import type { AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  MEMORY_CATEGORIES,
  MEMORY_SOURCES,
  MemoryContext,
} from './store.js';

const idSchema = z.object({ id: z.string().uuid() });
const categorySchema = z.enum(MEMORY_CATEGORIES);
const createSchema = z.object({
  fact: z.string().trim().min(1).max(2000),
  category: categorySchema.optional(),
  // Omitted classification resolves to the caller's own clearance floor
  // (PUBLIC for public-only callers) so valid PUBLIC callers are not
  // forced into a classification they are not cleared for.
  classification: z.enum(CLASSIFICATIONS).optional(),
  source: z.enum(MEMORY_SOURCES).optional(),
}).strict();
const updateSchema = z.object({
  fact: z.string().trim().min(1).max(2000).optional(),
  category: categorySchema.optional(),
  classification: z.enum(CLASSIFICATIONS).optional(),
}).strict();
const listQuerySchema = z.object({
  category: categorySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

function contextOf(auth: AuthContext): MemoryContext {
  return { tenantId: auth.tenantId, userId: auth.userId, clearance: auth.clearance };
}

export async function memoryRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/memory', { preHandler: [requireAuth, requirePermission('memory:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) throw Errors.badRequest('INVALID_QUERY', 'Invalid query parameters');
    const memories = await listMemories(contextOf(auth), parsed.data);
    return reply.send({ memories, pagination: { limit: parsed.data.limit, offset: parsed.data.offset } });
  });

  fastify.post('/memory', { preHandler: [requireAuth, requirePermission('memory:write')] }, async (req, reply) => {
    const auth = req.auth!;
    const body = createSchema.safeParse(req.body ?? {});
    if (!body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid memory parameters');
    const memory = await createMemory(contextOf(auth), body.data);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'MEMORY_CREATE',
      resource: 'memory',
      resourceId: memory.id,
      classification: memory.classification,
    });
    return reply.status(201).send({ memory });
  });

  fastify.get('/memory/:id', { preHandler: [requireAuth, requirePermission('memory:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid memory ID');
    const memory = await getMemory(contextOf(auth), params.data.id);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'MEMORY_ACCESS',
      resource: 'memory',
      resourceId: params.data.id,
    });
    return reply.send({ memory });
  });

  fastify.patch('/memory/:id', { preHandler: [requireAuth, requirePermission('memory:write')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    const body = updateSchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid memory update');
    const memory = await updateMemory(contextOf(auth), params.data.id, body.data);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'MEMORY_UPDATE',
      resource: 'memory',
      resourceId: params.data.id,
      classification: memory.classification,
    });
    return reply.send({ memory });
  });

  fastify.delete('/memory/:id', { preHandler: [requireAuth, requirePermission('memory:write')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_ID', 'Invalid memory ID');
    await deleteMemory(contextOf(auth), params.data.id);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'MEMORY_DELETE',
      resource: 'memory',
      resourceId: params.data.id,
    });
    return reply.status(204).send();
  });
}
