import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { CLASSIFICATIONS } from '../../authz/permissions.js';
import { listApprovedModelsForUser } from './modelRegistry.js';
import { query, withTx } from '../../db/pool.js';
import { Errors } from '../../errors.js';
import { recordAuditInTx } from '../../audit/audit.js';
import { assertEndpointAllowed } from './gateway.js';
import { isKnownChatProvider } from '../providers/factory.js';
import { assertAllowedModelSource } from '../artifacts.js';
import {
  MODEL_STATUSES,
  transitionModel,
  setServingDefault,
  listServingDefaults,
} from './modelLifecycle.js';
import {
  ROUTING_STRATEGIES,
  getRoutingPolicy,
  listRoutingPolicies,
  setRoutingPolicy,
} from './capabilityRouter.js';

const modelIdSchema = z.object({ id: z.string().uuid() });

// Enabled-toggle is the only mutable field on the PATCH route: endpoint,
// provider, model_identifier, and tuning knobs change inference behavior,
// so they are immutable after registration — register a new model version
// instead. Lifecycle moves through POST /admin/models/:id/transition.
const modelPatchSchema = z.object({ enabled: z.boolean() }).strict();

const modelRegisterSchema = z.object({
  name: z.string().min(1).max(200),
  version: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  endpoint: z.string().url().max(500),
  modelIdentifier: z.string().min(1).max(500),
  license: z.string().max(200).nullish(),
  source: z.string().url().max(500).nullish(),
  sha256: z.string().regex(/^[0-9a-fA-F]{64}$/).nullish(),
  contextWindow: z.number().int().min(1024).max(2000000).default(8192),
  capabilities: z.record(z.unknown()).default({}),
  // 'UNKNOWN' is fail-closed and can never be an allowed classification
  // (the DB check constraint enforces the same rule).
  allowedClassifications: z
    .array(z.enum(CLASSIFICATIONS))
    .min(1)
    .refine((values) => !values.includes('UNKNOWN'), { message: 'UNKNOWN cannot be an allowed classification' }),
  deployment: z.record(z.unknown()).default({}),
}).strict();

const modelTransitionSchema = z.object({
  status: z.enum(MODEL_STATUSES),
}).strict();

const servingDefaultSchema = z.object({
  modelId: z.string().uuid(),
}).strict();

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
  temperature, fallback_model_id, enabled, created_at,
  lifecycle_updated_at, approved_by, approved_at, last_eval_run_id`;

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
  lifecycle_updated_at: Date;
  approved_by: string | null;
  approved_at: Date | null;
  last_eval_run_id: string | null;
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
    lifecycleUpdatedAt: m.lifecycle_updated_at,
    approvedBy: m.approved_by,
    approvedAt: m.approved_at,
    lastEvalRunId: m.last_eval_run_id,
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
    // The model update and its audit event commit in ONE transaction: under
    // AUDIT_FAIL_CLOSED a failed audit insert rolls the enabled change back
    // instead of leaving it committed but unaudited.
    const updated = await withTx(async (client) => {
      // Single-statement UPDATE: atomic; the pre-read only feeds the audit event.
      const row = (
        await client.query<AdminModelRow>(
          `UPDATE models SET enabled = $2 WHERE id = $1 RETURNING ${ADMIN_MODEL_FIELDS}`,
          [parsedId.data.id, parsedBody.data.enabled]
        )
      ).rows[0];
      // The pre-read guaranteed existence, but the guard keeps the type honest
      // (and covers a delete raced between the two statements).
      if (!row) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
      await recordAuditInTx(client, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
        action: 'MODEL_ENABLED_CHANGED', resource: 'model', resourceId: parsedId.data.id,
        metadata: { previousEnabled: current.enabled, newEnabled: parsedBody.data.enabled } });
      return row;
    });
    return reply.send({ model: toAdminModel(updated) });
  });

  // Register a new model. It enters the lifecycle at REGISTERED: it serves
  // no traffic until it walks DOWNLOADING -> VALIDATING -> EVALUATING ->
  // PENDING_APPROVAL -> APPROVED (eval gate) -> CANARY/ACTIVE.
  fastify.post('/admin/models', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = modelRegisterSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model registration request');
    const body = parsed.data;
    if (!isKnownChatProvider(body.provider)) {
      throw Errors.badRequest('MODEL_PROVIDER_UNSUPPORTED', `Unknown model provider: ${body.provider}`);
    }
    // No arbitrary endpoints or model sources: both must be allowlisted.
    assertEndpointAllowed(body.endpoint);
    assertAllowedModelSource(body.source ?? null);
    try {
      const created = await withTx(async (client) => {
        const row = (
          await client.query<AdminModelRow>(
            `INSERT INTO models (name, version, provider, endpoint, model_identifier, status,
                                 license, source, sha256, context_window, capabilities,
                                 allowed_classifications, deployment)
             VALUES ($1,$2,$3,$4,$5,'REGISTERED',$6,$7,$8,$9,$10,$11,$12)
             RETURNING ${ADMIN_MODEL_FIELDS}`,
            [
              body.name, body.version, body.provider, body.endpoint, body.modelIdentifier,
              body.license ?? null, body.source ?? null, body.sha256 ?? null,
              body.contextWindow, JSON.stringify(body.capabilities),
              body.allowedClassifications, JSON.stringify(body.deployment),
            ]
          )
        ).rows[0]!;
        await recordAuditInTx(client, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
          action: 'MODEL_REGISTERED', resource: 'model', resourceId: row.id,
          metadata: { name: body.name, version: body.version, provider: body.provider } });
        return row;
      });
      return reply.code(201).send({ model: toAdminModel(created) });
    } catch (err) {
      // Unique violation on models.name -> 409, not 500.
      if (err instanceof Error && 'code' in err && (err as { code: string }).code === '23505') {
        throw Errors.badRequest('MODEL_NAME_EXISTS', 'A model with this name is already registered');
      }
      throw err;
    }
  });

  // Move a model through the approval/promotion lifecycle. The state machine
  // and the eval promotion gate are enforced in modelLifecycle.transitionModel;
  // approval (PENDING_APPROVAL -> APPROVED) fails when required evals fail.
  fastify.post('/admin/models/:id/transition', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = modelIdSchema.safeParse(req.params);
    const parsedBody = modelTransitionSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid lifecycle transition request');
    const result = await transitionModel({
      modelId: parsedId.data.id,
      toStatus: parsedBody.data.status,
      actorUserId: auth.userId,
      tenantId: auth.tenantId,
      requestId: req.requestId,
      ip: req.ip,
    });
    return reply.send({ transition: result });
  });

  // Admin-controlled serving defaults: which model serves a
  // tenant+capability slot. Audited; must point at a servable model.
  fastify.get('/admin/serving-defaults', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    return reply.send({ defaults: await listServingDefaults(auth.tenantId) });
  });

  fastify.put('/admin/serving-defaults/:capability', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedCapability = z.object({ capability: z.string().min(1).max(64) }).safeParse(req.params);
    const parsedBody = servingDefaultSchema.safeParse(req.body);
    if (!parsedCapability.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid serving default request');
    const def = await setServingDefault(
      auth.tenantId,
      parsedCapability.data.capability,
      parsedBody.data.modelId,
      auth.userId,
      req.requestId,
      req.ip
    );
    return reply.send({ default: def });
  });

  // Admin-controlled routing policies: per tenant+capability, the declared
  // routing intent (quality | latency | cost) and whether an unavailable
  // capability model falls back to the chat default. Audited; never bypasses
  // model authorization (see capabilityRouter.ts).
  const routingPolicySchema = z.object({
    strategy: z.enum(ROUTING_STRATEGIES as unknown as [string, ...string[]]),
    fallbackToChat: z.boolean(),
  }).strict();
  fastify.get('/admin/routing-policies', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    return reply.send({ policies: await listRoutingPolicies(auth.tenantId) });
  });
  fastify.get('/admin/routing-policies/:capability', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = z.object({ capability: z.string().min(1).max(64) }).safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid capability');
    return reply.send({ policy: await getRoutingPolicy(auth.tenantId, parsed.data.capability) });
  });
  fastify.put('/admin/routing-policies/:capability', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedCapability = z.object({ capability: z.string().min(1).max(64) }).safeParse(req.params);
    const parsedBody = routingPolicySchema.safeParse(req.body);
    if (!parsedCapability.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid routing policy request');
    const policy = await setRoutingPolicy(
      auth.tenantId,
      parsedCapability.data.capability,
      {
        strategy: parsedBody.data.strategy as (typeof ROUTING_STRATEGIES)[number],
        fallbackToChat: parsedBody.data.fallbackToChat,
      },
      auth.userId,
      req.requestId,
      req.ip
    );
    return reply.send({ policy });
  });
}

/**
 * Local-dev model artifact management (Ollama). DEV ONLY: every function in
 * artifacts.ts refuses unless ALLOW_DEV_PROVIDERS is enabled, and these
 * routes additionally require model:manage. Production model deployment is
 * configuration-driven (see docs/inference.md) — the application never
 * downloads weights in production.
 */
export async function modelArtifactRoutes(fastify: FastifyInstance): Promise<void> {
  const { listLocalModels, pullLocalModel, assertLocalPullAllowed } = await import('../artifacts.js');

  fastify.get('/admin/models/artifacts/local', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (_req, reply) => {
    return reply.send({ models: await listLocalModels() });
  });

  fastify.post('/admin/models/artifacts/pull', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const parsed = z.object({ name: z.string().min(1).max(200) }).strict().safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model pull request');
    const auth = req.auth!;
    // Audit the pull request (non-transactional: the pull itself streams).
    const { recordAudit } = await import('../../audit/audit.js');
    await recordAudit({
      tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'MODEL_PULL_REQUESTED', resource: 'model_artifact', resourceId: parsed.data.name, success: true,
    });
    // Eager allowlist/dev-gate check BEFORE switching to raw SSE: once
    // reply.raw headers are set, Fastify can no longer render an AppError
    // as JSON, so a denied pull would surface as a bare 500 instead of the
    // real 403 code.
    assertLocalPullAllowed(parsed.data.name);
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    for await (const progress of pullLocalModel(parsed.data.name)) {
      if (reply.raw.destroyed) break;
      reply.raw.write(`data: ${JSON.stringify(progress)}\n\n`);
    }
    reply.raw.end();
  });
}
