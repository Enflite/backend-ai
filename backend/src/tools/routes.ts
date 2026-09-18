import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { runToolCall, toolRegistry } from './gateway.js';

const paramsSchema = z.object({ name: z.string().min(1).max(100) });
const bodySchema = z.object({
  parameters: z.unknown(),
  classification: z.enum(CLASSIFICATIONS),
  confirmed: z.boolean().default(false),
}).strict();

export async function toolRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/tools', { preHandler: [requireAuth, requirePermission('tool:use')] }, async (_req, reply) => {
    return reply.send({ tools: toolRegistry.map(({ name, description, action, destructive, allowedClassifications }) => ({ name, description, action, destructive, allowedClassifications })) });
  });

  fastify.post('/tools/:name/execute', {
    preHandler: [requireAuth, requirePermission('tool:use')],
    // Tool parameters are small by design; cap the body well below the 1MB
    // global limit to bound oversized-JSON validation/stringify work.
    bodyLimit: 64 * 1024,
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_TOOL_REQUEST', 'Invalid tool execution request');
    const auth = req.auth!;
    // runToolCall performs authorization, per-tool timeout, audited execution,
    // and output capping; denials are returned as structured failures.
    const result = await runToolCall({
      auth,
      name: params.data.name,
      rawArguments: JSON.stringify(body.data.parameters ?? {}),
      classification: body.data.classification as Classification,
      confirmed: body.data.confirmed,
      requestId: req.requestId,
      signal: AbortSignal.timeout(30000),
    });
    if (!result.ok) {
      // Map denial/failure codes back onto the API error surface.
      if (result.errorCode === 'TOOL_FORBIDDEN') throw Errors.forbidden('TOOL_FORBIDDEN', 'Tool permission required');
      if (result.errorCode === 'CLASSIFICATION_DENIED') throw Errors.forbidden('CLASSIFICATION_DENIED', result.message ?? 'Classification denied');
      if (result.errorCode === 'TOOL_CLASSIFICATION_DENIED') throw Errors.forbidden('TOOL_CLASSIFICATION_DENIED', result.message ?? 'Tool cannot receive this data classification');
      if (result.errorCode === 'CONFIRMATION_REQUIRED') throw Errors.conflict('CONFIRMATION_REQUIRED', result.message ?? 'Destructive tool action requires explicit confirmation');
      if (result.errorCode === 'TOOL_NOT_FOUND') throw Errors.notFound('TOOL_NOT_FOUND', 'Tool is not registered');
      if (result.errorCode === 'INVALID_TOOL_PARAMETERS' || result.errorCode === 'INVALID_TOOL_ARGUMENTS') {
        throw Errors.badRequest(result.errorCode, result.message ?? 'Tool parameters are invalid');
      }
      throw Errors.internal(result.message ?? 'Tool execution failed', undefined, result.errorCode);
    }
    return reply.send({ executionId: result.executionId, result: result.data ?? null, truncated: result.truncated ?? false });
  });
}
