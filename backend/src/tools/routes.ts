import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification } from '../authz/permissions.js';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import { authorizeTool, toolRegistry } from './gateway.js';

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
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const params = paramsSchema.safeParse(req.params);
    const body = bodySchema.safeParse(req.body);
    if (!params.success || !body.success) throw Errors.badRequest('INVALID_TOOL_REQUEST', 'Invalid tool execution request');
    const auth = req.auth!;
    const classification = body.data.classification as Classification;
    let executionId: string | undefined;
    let prepared: ReturnType<typeof authorizeTool>;
    try {
      prepared = authorizeTool(auth, params.data.name, body.data.parameters, classification, body.data.confirmed);
    } catch (error) {
      await tenantQuery(
        auth.tenantId,
        `INSERT INTO tool_executions (request_id, tenant_id, user_id, tool_name, action, parameters, authorization_decision, classification, status, error_code, completed_at)
         VALUES ($1,$2,$3,$4,'execute','{}','DENIED',$5,'DENIED',$6,NOW())`,
        [req.requestId, auth.tenantId, auth.userId, params.data.name, classification, error instanceof Error && 'code' in error ? String((error as any).code) : 'TOOL_REQUEST_DENIED']
      );
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'TOOL_EXECUTION', tool: params.data.name, classification, success: false, reason: error instanceof Error ? error.message : 'Tool request denied' });
      throw error;
    }
    try {
      const pending = await tenantQuery<{ id: string }>(
        auth.tenantId,
        `INSERT INTO tool_executions (request_id, tenant_id, user_id, tool_name, action, parameters, authorization_decision, classification, status)
         VALUES ($1,$2,$3,$4,'execute',$5,'ALLOWED',$6,'PENDING') RETURNING id`,
        [req.requestId, auth.tenantId, auth.userId, params.data.name, JSON.stringify(prepared.input), classification]
      );
      executionId = pending.rows[0]!.id;
      const output = await prepared.definition.execute(prepared.input, AbortSignal.timeout(30000));
      await tenantQuery(auth.tenantId, "UPDATE tool_executions SET status = 'SUCCEEDED', completed_at = NOW() WHERE id = $1", [executionId]);
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'TOOL_EXECUTION', tool: params.data.name, classification, metadata: { executionId } });
      return reply.send({ executionId, result: output });
    } catch (error) {
      if (executionId) await tenantQuery(auth.tenantId, "UPDATE tool_executions SET status = 'FAILED', error_code = $2, completed_at = NOW() WHERE id = $1", [executionId, error instanceof Error && 'code' in error ? String((error as any).code) : 'TOOL_EXECUTION_FAILED']);
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'TOOL_EXECUTION', tool: params.data.name, classification, success: false, reason: error instanceof Error ? error.message : 'Tool execution failed' });
      throw error;
    }
  });
}
