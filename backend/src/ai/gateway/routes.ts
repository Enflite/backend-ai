import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { listApprovedModelsForUser } from './modelRegistry.js';
import { query } from '../../db/pool.js';
import { Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';

const modelIdSchema = z.object({ id: z.string().uuid() });

// Enabled-toggle is the only admin-mutable field today: the schema has no
// approval/lifecycle columns beyond status/enabled, and every other field
// (endpoint, provider, model_identifier, tuning knobs) changes inference
// behavior, so it stays immutable until Phase 3 model lifecycle lands.
const modelPatchSchema = z.object({ enabled: z.boolean() }).strict();

export async function modelRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get(
    '/models',
    {
      preHandler: [requireAuth, requirePermission('model:use')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const approved = await listApprovedModelsForUser(auth.tenantId, auth.userId, auth.roleId);
      const models = approved.map((m) => ({
        id: m.id,
        name: m.name,
        version: m.version,
        contextWindow: m.context_window,
        capabilities: m.capabilities,
        allowedClassifications: m.allowed_classifications,
        provider: m.provider,
      }));

      return reply.send({ models });
    }
  );
}

const ADMIN_MODEL_FIELDS = `id, name, version, provider, endpoint, model_identifier,
  status, license, source, sha256, context_window, capabilities,
  allowed_classifications, deployment, request_timeout_ms, max_tokens,
  temperature, fallback_model_id, enabled, created_at`;

interface AdminModelRow {
  id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  model_identifier: string;
  status: string;
  license: string | null;
  source: string | null;
  sha256: string | null;
  context_window: number;
  capabilities: Record<string, unknown>;
  allowed_classifications: string[];
  deployment: Record<string, unknown>;
  request_timeout_ms: number | null;
  max_tokens: number | null;
  temperature: number | null;
  fallback_model_id: string | null;
  enabled: boolean;
  created_at: Date;
}

function toAdminModel(m: AdminModelRow) {
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    provider: m.provider,
    endpoint: m.endpoint,
    modelIdentifier: m.model_identifier,
    status: m.status,
    license: m.license,
    source: m.source,
    sha256: m.sha256,
    contextWindow: m.context_window,
    capabilities: m.capabilities,
    allowedClassifications: m.allowed_classifications,
    deployment: m.deployment,
    requestTimeoutMs: m.request_timeout_ms,
    maxTokens: m.max_tokens,
    temperature: m.temperature,
    fallbackModelId: m.fallback_model_id,
    enabled: m.enabled,
    createdAt: m.created_at,
  };
}

/**
 * Platform model administration. Models carry no tenant_id: the registry is
 * tenant-agnostic, so these routes do not use tenant-scoped queries and
 * `model_access` grants are irrelevant here — they scope which models a
 * non-admin user may USE, not who may administer them. The only gate is
 * `model:manage` (Admin and AI Admin roles).
 */
export async function modelAdminRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/admin/models', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (_req, reply) => {
    const rows = (await query<AdminModelRow>(
      `SELECT ${ADMIN_MODEL_FIELDS} FROM models ORDER BY name ASC`
    )).rows;
    return reply.send({ models: rows.map(toAdminModel) });
  });

  fastify.patch('/admin/models/:id', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = modelIdSchema.safeParse(req.params);
    const parsedBody = modelPatchSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model update request');
    const current = (
      await query<Pick<AdminModelRow, 'id' | 'enabled'>>('SELECT id, enabled FROM models WHERE id = $1', [parsedId.data.id])
    ).rows[0];
    if (!current) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
    // Single-statement UPDATE: atomic; the pre-read only feeds the audit event.
    const updated = (
      await query<AdminModelRow>(
        `UPDATE models SET enabled = $2 WHERE id = $1 RETURNING ${ADMIN_MODEL_FIELDS}`,
        [parsedId.data.id, parsedBody.data.enabled]
      )
    ).rows[0];
    // The pre-read guaranteed existence, but the guard keeps the type honest
    // (and covers a delete raced between the two statements).
    if (!updated) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'MODEL_ENABLED_CHANGED', resource: 'model', resourceId: parsedId.data.id,
      metadata: { previousEnabled: current.enabled, newEnabled: parsedBody.data.enabled } });
    return reply.send({ model: toAdminModel(updated) });
  });
}
