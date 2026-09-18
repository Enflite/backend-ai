import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { config } from '../config.js';
import { runToolCall, toolRegistry } from './gateway.js';
import { createToolConcurrencyLimiter, replyBusy } from '../ai/gateway/limits.js';

const paramsSchema = z.object({ name: z.string().min(1).max(100) });
const bodySchema = z.object({
  parameters: z.unknown(),
  classification: z.enum(CLASSIFICATIONS),
  confirmed: z.boolean().default(false),
}).strict();

/**
 * Concurrency limiter for direct tool executions (Phase 4b gateway
 * fairness): tool calls fan out, so this caps per-user in-flight executions
 * (config AI_MAX_CONCURRENT_TOOLS_PER_USER) while sharing the tenant cap
 * with chat. Exported for tests and operational introspection.
 */
export const toolConcurrency = createToolConcurrencyLimiter();

export async function toolRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/tools', { preHandler: [requireAuth, requirePermission('tool:use')] }, async (req, reply) => {
    const auth = req.auth!;
    return reply.send({
      tools: toolRegistry
        .filter((tool) => auth.permissions.includes(tool.permission ?? 'tool:use'))
        .map(({ name, description, action, destructive, allowedClassifications }) => ({ name, description, action, destructive, allowedClassifications })),
    });
  });

  fastify.post('/tools/:name/execute', {
    preHandler: [requireAuth, requirePermission('tool:use')],
    // Tool parameters are small by design; cap the body well below the 1MB
    // global limit to bound oversized-JSON validation/stringify work.
    bodyLimit: 64 * 1024,
    // Sustained request rate (config TOOL_RATE_LIMIT_PER_MIN): the tool
    // endpoint is cheap and bursty compared to chat, so it gets the higher
    // budget. Documented in docs/deployment.md.
    config: { rateLimit: { max: config.TOOL_RATE_LIMIT_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_TOOL_REQUEST', 'Invalid tool execution request');
    const auth = req.auth!;
    // Concurrency cap (gateway fairness): one slot per in-flight execution,
    // released in the finally on success, denial, timeout, or abort. The
    // error-mapping throws below all pass through the finally, so a denied
    // or failed tool call cannot leak its slot.
    const concurrencySlot = toolConcurrency.tryAcquire(auth.tenantId, auth.userId);
    if (!concurrencySlot.ok) {
      return replyBusy(reply, concurrencySlot.retryAfterSeconds);
    }
    try {
      // runToolCall performs authorization, per-tool timeout, audited execution,
      // and output capping; denials are returned as structured failures.
      const result = await runToolCall({
        auth,
        name: params.data.name,
        rawArguments: JSON.stringify(body.data.parameters ?? {}),
        classification: body.data.classification as Classification,
        confirmed: body.data.confirmed,
        requestId: req.requestId,
        signal: AbortSignal.timeout(config.AI_TOOL_TIMEOUT_MS),
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
    } finally {
      concurrencySlot.release();
    }
  });
}
