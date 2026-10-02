import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { CLASSIFICATIONS } from '../../authz/permissions.js';
import { listApprovedModelsForUser, isClaudeConfigured, isOpenAIConfigured } from './modelRegistry.js';
import { config } from '../../config.js';
import {
  PROVIDER_GROUPS,
  PROVIDER_GROUP_INFO,
  displayNameForModel,
  providerGroupFor,
  providerLabelFor,
  type ProviderGroup,
} from '../providers/providerDisplay.js';
import { getDb, withTx } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { recordAuditInTx } from '../../audit/audit.js';
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
import {
  SENSITIVE_CATEGORIES,
  getPrivacyAutoRouting,
  setPrivacyRoutingSetting,
} from './privacyRouting.js';

const modelIdSchema = z.object({ id: z.string().uuid() });

/** `models` collection projection used by the access endpoints (ADR-014: UUID-string `_id`). */
interface ModelIdDoc {
  _id: string;
}

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
        /** User-facing name — never a raw registry ID (ADR-018). */
        displayName: displayNameForModel(m),
        version: m.version,
        contextWindow: m.contextWindow,
        capabilities: m.capabilities,
        allowedClassifications: m.allowedClassifications,
        provider: m.provider,
        /** One of 'enflite' | 'claude' | 'openai' — drives the UI switcher. */
        providerGroup: providerGroupFor(m.provider),
        providerLabel: providerLabelFor(m.provider),
        /** The provider's preferred chat model — auto-selected on switch. */
        isProviderDefault: m.isProviderDefault ?? false,
      }));

      return reply.send({ models });
    }
  );

  // Provider availability for the one-tap switcher (ADR-018). Never
  // includes keys or key material: `configured` only reports presence.
  // Enflite (local models) is operator-gated by OLLAMA_ENABLED: while the
  // flag is off it is omitted from the list entirely so the switcher only
  // ever shows providers that can actually serve. Cloud providers appear
  // disabled with an admin hint when their key is missing.
  fastify.get(
    '/providers',
    {
      preHandler: [requireAuth, requirePermission('model:use')],
    },
    async (req, reply) => {
      const providers = PROVIDER_GROUPS.filter(
        (key: ProviderGroup) => key !== 'enflite' || config.OLLAMA_ENABLED
      ).map((key: ProviderGroup) => {
        const info = PROVIDER_GROUP_INFO[key];
        if (key === 'enflite') {
          return { ...info, configured: true, enabled: true };
        }
        const keyPresent =
          key === 'claude' ? config.ANTHROPIC_API_KEY.trim().length > 0 : config.OPENAI_API_KEY.trim().length > 0;
        const adminEnabled = key === 'claude' ? config.CLAUDE_ENABLED : config.OPENAI_ENABLED;
        const configured = key === 'claude' ? isClaudeConfigured() : isOpenAIConfigured();
        return {
          ...info,
          configured,
          enabled: configured,
          hint: keyPresent && !adminEnabled
            ? `${info.label} is disabled by the server administrator`
            : !keyPresent
              ? `Ask your admin to set ${key === 'claude' ? 'ANTHROPIC_API_KEY' : 'OPENAI_API_KEY'}`
              : undefined,
        };
      });

      return reply.send({ providers });
    }
  );
}

/** MongoDB document shape for the `models` collection (ADR-014): camelCase, `_id` is the UUID string. */
interface AdminModelDoc {
  _id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  modelIdentifier: string;
  status: string;
  license: string | null;
  source: string | null;
  sha256: string | null;
  contextWindow: number;
  capabilities: Record<string, unknown>;
  allowedClassifications: string[];
  deployment: Record<string, unknown>;
  requestTimeoutMs: number | null;
  maxTokens: number | null;
  temperature: number | null;
  fallbackModelId: string | null;
  enabled: boolean;
  createdAt: Date;
  lifecycleUpdatedAt: Date;
  approvedBy: string | null;
  approvedAt: Date | null;
  lastEvalRunId: string | null;
}

function toAdminModel(m: AdminModelDoc) {
  return {
    id: m._id,
    name: m.name,
    version: m.version,
    provider: m.provider,
    endpoint: m.endpoint,
    modelIdentifier: m.modelIdentifier,
    status: m.status,
    license: m.license,
    source: m.source,
    sha256: m.sha256,
    contextWindow: m.contextWindow,
    capabilities: m.capabilities,
    allowedClassifications: m.allowedClassifications,
    deployment: m.deployment,
    requestTimeoutMs: m.requestTimeoutMs,
    maxTokens: m.maxTokens,
    temperature: m.temperature,
    fallbackModelId: m.fallbackModelId,
    enabled: m.enabled,
    createdAt: m.createdAt,
    lifecycleUpdatedAt: m.lifecycleUpdatedAt,
    approvedBy: m.approvedBy,
    approvedAt: m.approvedAt,
    lastEvalRunId: m.lastEvalRunId,
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
    const docs = await (await getDb())
      .collection<AdminModelDoc>('models')
      .find({})
      .sort({ name: 1 })
      .toArray();
    return reply.send({ models: docs.map(toAdminModel) });
  });

  fastify.patch('/admin/models/:id', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = modelIdSchema.safeParse(req.params);
    const parsedBody = modelPatchSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model update request');
    const db = await getDb();
    const current = await db
      .collection<AdminModelDoc>('models')
      .findOne({ _id: parsedId.data.id }, { projection: { enabled: 1 } });
    if (!current) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
    // The model update and its audit event commit in ONE transaction: under
    // AUDIT_FAIL_CLOSED a failed audit insert rolls the enabled change back
    // instead of leaving it committed but unaudited.
    const updated = await withTx(async (session, db) => {
      // Atomic find-and-modify: the pre-read only feeds the audit event.
      const row = await db
        .collection<AdminModelDoc>('models')
        .findOneAndUpdate(
          { _id: parsedId.data.id },
          { $set: { enabled: parsedBody.data.enabled } },
          { session, returnDocument: 'after' }
        );
      // The pre-read guaranteed existence, but the guard keeps the type honest
      // (and covers a delete raced between the two statements).
      if (!row) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
      await recordAuditInTx(session, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
        action: 'MODEL_ENABLED_CHANGED', resource: 'model', resourceId: parsedId.data.id,
        metadata: { previousEnabled: current.enabled, newEnabled: parsedBody.data.enabled } });
      return row;
    });
    return reply.send({ model: toAdminModel(updated) });
  });

  // Explicit per-principal model access. Serving is default-open: the
  // tenant default model needs no grant row, so "revoking" it (or any
  // model) for a user/role is an explicit write, not a row deletion.
  // - POST sets the access: revoked:false = explicit grant (required for
  //   non-default models), revoked:true = explicit denial (wins over the
  //   default model's implicit grant).
  // - DELETE clears the row, returning the principal to the default-open
  //   default. Both commit with their audit event in one transaction.
  const modelAccessSetSchema = z.object({
    userId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
    revoked: z.boolean(),
  }).strict().refine(
    (body) => (body.userId ? 1 : 0) + (body.roleId ? 1 : 0) === 1,
    { message: 'Exactly one of userId or roleId is required' }
  );
  const modelAccessClearSchema = z.object({
    userId: z.string().uuid().optional(),
    roleId: z.string().uuid().optional(),
  }).strict().refine(
    (body) => (body.userId ? 1 : 0) + (body.roleId ? 1 : 0) === 1,
    { message: 'Exactly one of userId or roleId is required' }
  );

  fastify.post('/admin/models/:id/access', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = modelIdSchema.safeParse(req.params);
    const parsedBody = modelAccessSetSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model access request');
    const { userId, roleId, revoked } = parsedBody.data;
    // The absent principal field must be omitted (not null) for the sparse
    // unique index on (tenantId, modelId, roleId, userId) to work.
    const principal = userId ? { userId } : { roleId: roleId! };
    await withTx(async (session, db) => {
      const model = await db.collection<ModelIdDoc>('models').findOne({ _id: parsedId.data.id }, { session, projection: { _id: 1 } });
      if (!model) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
      const now = new Date();
      await db.collection('model_access').updateOne(
        { tenantId: auth.tenantId, modelId: parsedId.data.id, ...principal },
        {
          $set: { revoked, updatedAt: now },
          $setOnInsert: {
            _id: crypto.randomUUID(),
            tenantId: auth.tenantId,
            modelId: parsedId.data.id,
            ...principal,
            createdAt: now,
          },
        },
        { session, upsert: true }
      );
      await recordAuditInTx(session, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
        action: 'MODEL_ACCESS_SET', resource: 'model', resourceId: parsedId.data.id,
        metadata: { ...principal, revoked } });
    });
    return reply.send({ modelId: parsedId.data.id, ...principal, revoked });
  });

  fastify.delete('/admin/models/:id/access', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = modelIdSchema.safeParse(req.params);
    const parsedBody = modelAccessClearSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid model access request');
    const { userId, roleId } = parsedBody.data;
    const principal = userId ? { userId } : { roleId: roleId! };
    const result = await withTx(async (session, db) => {
      const model = await db.collection<ModelIdDoc>('models').findOne({ _id: parsedId.data.id }, { session, projection: { _id: 1 } });
      if (!model) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
      const deleted = await db.collection('model_access').deleteOne(
        { tenantId: auth.tenantId, modelId: parsedId.data.id, ...principal },
        { session }
      );
      await recordAuditInTx(session, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
        action: 'MODEL_ACCESS_CLEARED', resource: 'model', resourceId: parsedId.data.id,
        metadata: { ...principal } });
      return deleted;
    });
    return reply.send({ modelId: parsedId.data.id, ...principal, cleared: result.deletedCount === 1 });
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
    // Model endpoints come from the operator-controlled registry: no
    // allowlist gate here. The model source URL must still be allowlisted.
    assertAllowedModelSource(body.source ?? null);
    try {
      const created = await withTx(async (session, db) => {
        const now = new Date();
        const doc: AdminModelDoc = {
          _id: crypto.randomUUID(),
          name: body.name,
          version: body.version,
          provider: body.provider,
          endpoint: body.endpoint,
          modelIdentifier: body.modelIdentifier,
          status: 'REGISTERED',
          license: body.license ?? null,
          source: body.source ?? null,
          sha256: body.sha256 ?? null,
          contextWindow: body.contextWindow,
          // Native nested documents in MongoDB — no JSON.stringify (ADR-014).
          capabilities: body.capabilities,
          allowedClassifications: body.allowedClassifications,
          deployment: body.deployment,
          requestTimeoutMs: null,
          maxTokens: null,
          temperature: null,
          fallbackModelId: null,
          enabled: true,
          createdAt: now,
          lifecycleUpdatedAt: now,
          approvedBy: null,
          approvedAt: null,
          lastEvalRunId: null,
        };
        await db.collection<AdminModelDoc>('models').insertOne(doc, { session });
        await recordAuditInTx(session, { tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
          action: 'MODEL_REGISTERED', resource: 'model', resourceId: doc._id,
          metadata: { name: body.name, version: body.version, provider: body.provider } });
        return doc;
      });
      return reply.code(201).send({ model: toAdminModel(created) });
    } catch (err) {
      // Duplicate key on the unique models.name index -> 409, not 500.
      if (err instanceof Error && 'code' in err && (err as { code: unknown }).code === 11000) {
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

  // Privacy-aware provider routing settings. autoRouteToCloud defaults ON
  // (clean, unpinned turns auto-route to Claude when configured); admins
  // can disable it per tenant. sensitiveCategories defaults to all three
  // (customer, finance, proprietary) — default-deny. codeRoutableToCloud
  // is the code carve-out: repo source code stays routable to Claude for
  // coding help; flip it to false to make code local-only too. The toggle
  // only ever moves clean turns to cloud — the sensitive-data rule is not
  // toggleable, only the enforced category list is.
  fastify.get('/admin/privacy-routing', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    return reply.send({ setting: await getPrivacyAutoRouting(auth.tenantId) });
  });

  fastify.put('/admin/privacy-routing', {
    preHandler: [requireAuth, requirePermission('model:manage')],
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = z
      .object({
        autoRouteToCloud: z.boolean().optional(),
        sensitiveCategories: z.array(z.enum(SENSITIVE_CATEGORIES)).optional(),
        codeRoutableToCloud: z.boolean().optional(),
      })
      .strict()
      .safeParse(req.body);
    if (!parsed.success) {
      throw Errors.badRequest(
        'INVALID_BODY',
        'Request body must be { autoRouteToCloud?: boolean, sensitiveCategories?: ("customer"|"finance"|"proprietary")[], codeRoutableToCloud?: boolean }'
      );
    }
    const setting = await setPrivacyRoutingSetting(
      auth.tenantId,
      parsed.data,
      auth.userId,
      req.requestId,
      req.ip
    );
    return reply.send({ setting });
  });
}

/**
 * Local model artifact management (Ollama). Weight downloads via this API
 * stay gated by ALLOW_DEV_PROVIDERS (deprecated for inference, still the
 * switch for pulls), and these routes additionally require model:manage.
 * Remote model deployment is configuration-driven (see docs/inference.md)
 * — the application never downloads weights on the vLLM path.
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
