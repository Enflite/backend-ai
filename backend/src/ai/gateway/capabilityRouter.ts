/**
 * capabilityRouter.ts — Phase 6: route a request to the best model for its
 * capability.
 *
 * Capabilities are the slots Phase 3's `model_serving_defaults` defines
 * (`chat`, `syteline`, `coding`, `embeddings`; see KNOWN_CAPABILITIES in
 * modelLifecycle.ts). An admin binds a servable model to each slot; this
 * router resolves the slot at request time and handles the unavailable-model
 * cases:
 *
 * - Missing serving default, stale default (model deprecated / grant
 *   revoked — re-verified on every resolution by resolveServingModel), or a
 *   default that fails authorization for this caller: fall back to the
 *   tenant's chat default (then the legacy first-approved model), exactly
 *   once, BEFORE any streaming starts. The fallback is audited as
 *   MODEL_CAPABILITY_FALLBACK. Because it happens before gatewayStream runs,
 *   a turn can never stitch two models' output together.
 * - When the tenant's routing policy sets fallback_to_chat=false for a
 *   capability, a missing capability model fails the turn closed
 *   (NO_APPROVED_MODEL) instead of silently serving a different model.
 *
 * The routing policy's `strategy` ('quality' | 'latency' | 'cost') is the
 * tenant's declared intent for the capability. It is recorded on the
 * resolution (returned to callers, written into audit metadata) so operators
 * can segment MODEL_USED telemetry — TTFT/tokens-sec for 'latency', eval
 * promotion scores for 'quality' — by intent. The model bound to a
 * capability is still the admin's explicit serving-default choice, made with
 * those same signals in hand; the strategy does not silently re-rank models
 * at request time. See docs/capabilities.md §1.
 *
 * Security posture: this module makes no trust decisions of its own. Every
 * model it returns went through getApprovedModelForUser (approval status,
 * enabled flag, tenant grant, classification policy) inside
 * resolveServingModel. The router only decides WHICH authorized model
 * serves, never WHETHER an unauthorized one may.
 */
import { Errors, AppError } from '../../errors.js';
import { tenantQuery, withTenantTx } from '../../db/pool.js';
import { recordAudit, recordAuditInTx } from '../../audit/audit.js';
import { KNOWN_CAPABILITIES, resolveServingModel } from './modelLifecycle.js';
import { getApprovedModelForUser, listApprovedModelsForUser, type ApprovedModel } from './modelRegistry.js';

export type Capability = (typeof KNOWN_CAPABILITIES)[number];
export type RoutingStrategy = 'quality' | 'latency' | 'cost';

export const ROUTING_STRATEGIES: readonly RoutingStrategy[] = ['quality', 'latency', 'cost'] as const;

export interface RoutingPolicy {
  tenantId: string;
  capability: string;
  strategy: RoutingStrategy;
  fallbackToChat: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/** Platform default policy: used when the tenant never configured one. */
export const DEFAULT_ROUTING_POLICY: Pick<RoutingPolicy, 'strategy' | 'fallbackToChat'> = {
  strategy: 'quality',
  fallbackToChat: true,
};

export function normalizeCapability(capability: string): Capability {
  const normalized = capability.trim().toLowerCase();
  if (!(KNOWN_CAPABILITIES as readonly string[]).includes(normalized)) {
    throw Errors.badRequest('INVALID_CAPABILITY', `Unknown capability: ${capability}`);
  }
  return normalized as Capability;
}

/**
 * Read the tenant's routing policy for a capability. Returns the platform
 * default when the tenant never configured one — routing works out of the
 * box, policy only tunes it.
 */
export async function getRoutingPolicy(tenantId: string, capability: string): Promise<RoutingPolicy> {
  const normalized = normalizeCapability(capability);
  const row = (
    await tenantQuery<RoutingPolicy>(
      tenantId,
      `SELECT tenant_id AS "tenantId", capability, strategy,
              fallback_to_chat AS "fallbackToChat",
              updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM model_routing_policies WHERE tenant_id = $1 AND capability = $2`,
      [tenantId, normalized]
    )
  ).rows[0];
  if (row) return row;
  return {
    tenantId,
    capability: normalized,
    strategy: DEFAULT_ROUTING_POLICY.strategy,
    fallbackToChat: DEFAULT_ROUTING_POLICY.fallbackToChat,
    updatedBy: null,
    updatedAt: new Date(0),
  };
}

export async function listRoutingPolicies(tenantId: string): Promise<RoutingPolicy[]> {
  return (
    await tenantQuery<RoutingPolicy>(
      tenantId,
      `SELECT tenant_id AS "tenantId", capability, strategy,
              fallback_to_chat AS "fallbackToChat",
              updated_by AS "updatedBy", updated_at AS "updatedAt"
       FROM model_routing_policies WHERE tenant_id = $1 ORDER BY capability ASC`,
      [tenantId]
    )
  ).rows;
}

/**
 * Set (upsert) the routing policy for a tenant+capability. Admin-only
 * (model:manage), audited. The policy tunes routing intent and fallback
 * behavior; it never bypasses model authorization.
 */
export async function setRoutingPolicy(
  tenantId: string,
  capability: string,
  policy: { strategy: RoutingStrategy; fallbackToChat: boolean },
  actorUserId: string,
  requestId?: string,
  ip?: string
): Promise<RoutingPolicy> {
  const normalized = normalizeCapability(capability);
  if (!ROUTING_STRATEGIES.includes(policy.strategy)) {
    throw Errors.badRequest('INVALID_STRATEGY', `Strategy must be one of: ${ROUTING_STRATEGIES.join(', ')}`);
  }
  // Tenant-scoped transaction: model_routing_policies is under forced RLS,
  // so the tenant context must be established before the upsert.
  return withTenantTx(tenantId, async (client) => {
    const row = (
      await client.query<RoutingPolicy>(
        `INSERT INTO model_routing_policies (tenant_id, capability, strategy, fallback_to_chat, updated_by, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tenant_id, capability)
         DO UPDATE SET strategy = EXCLUDED.strategy,
                       fallback_to_chat = EXCLUDED.fallback_to_chat,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = NOW()
         RETURNING tenant_id AS "tenantId", capability, strategy,
                   fallback_to_chat AS "fallbackToChat",
                   updated_by AS "updatedBy", updated_at AS "updatedAt"`,
        [tenantId, normalized, policy.strategy, policy.fallbackToChat, actorUserId]
      )
    ).rows[0]!;
    await recordAuditInTx(client, {
      tenantId,
      userId: actorUserId,
      requestId,
      ip,
      action: 'MODEL_ROUTING_POLICY_SET',
      resource: 'model_routing_policy',
      resourceId: `${tenantId}:${normalized}`,
      success: true,
      metadata: { capability: normalized, strategy: policy.strategy, fallbackToChat: policy.fallbackToChat },
    });
    return row;
  });
}

export interface CapabilityResolution {
  /** The capability the turn asked for ('chat' when nothing else matched). */
  requested: Capability;
  /** The capability whose model is actually serving (differs on fallback). */
  resolved: Capability;
  /** The authorized model to stream from. */
  model: ApprovedModel;
  /** True when the capability model was unavailable and chat served instead. */
  fallbackUsed: boolean;
  /** Why the fallback happened (absent when no fallback). Audited, not user-facing. */
  fallbackReason?: string;
  /** The tenant's declared routing intent for the requested capability. */
  strategy: RoutingStrategy;
}

/**
 * Resolve the chat default exactly the way /chat did before capability
 * routing existed: the admin's chat serving default, else the legacy
 * first-approved model. Shared so the router and the route cannot drift.
 */
export async function resolveChatDefault(
  tenantId: string,
  userId: string,
  roleId: string
): Promise<ApprovedModel | null> {
  return (
    (await resolveServingModel(tenantId, userId, roleId, 'chat')) ??
    (await listApprovedModelsForUser(tenantId, userId, roleId))[0] ??
    null
  );
}

function noModelAvailable(requested: Capability): Error {
  return Errors.forbidden(
    'NO_APPROVED_MODEL',
    `No approved model is available for capability '${requested}'`
  );
}

/**
 * Resolve the model serving a turn for a capability.
 *
 * - 'chat' resolves exactly as before (chat serving default, then legacy
 *   first-approved). No fallback audit: this IS the fallback target.
 * - Other capabilities try their serving default first (servability,
 *   tenant grant, and classification re-verified on every call inside
 *   resolveServingModel). On any failure they fall back to the chat
 *   default — audited once as MODEL_CAPABILITY_FALLBACK, before streaming —
 *   unless the tenant policy disabled fallback, in which case the turn
 *   fails closed.
 * - The 'embeddings' slot never serves chat turns: it resolves to the chat
 *   default with fallbackUsed=true and an honest reason. Embedding traffic
 *   goes through resolveEmbeddingProvider, not the chat registry.
 */
export async function resolveCapabilityModel(options: {
  tenantId: string;
  userId: string;
  roleId: string;
  capability: string;
  requestId?: string;
}): Promise<CapabilityResolution> {
  const { tenantId, userId, roleId, requestId } = options;
  const requested = normalizeCapability(options.capability);
  const policy = await getRoutingPolicy(tenantId, requested);

  if (requested === 'chat') {
    const model = await resolveChatDefault(tenantId, userId, roleId);
    if (!model) throw noModelAvailable(requested);
    return { requested, resolved: 'chat', model, fallbackUsed: false, strategy: policy.strategy };
  }

  if (requested === 'embeddings') {
    // The embeddings slot is not a chat model: document retrieval and
    // ingestion resolve through resolveEmbeddingProvider (see
    // docs/inference.md §3). A chat turn asking for 'embeddings' gets the
    // chat default, audited, rather than a confusing failure.
    const model = await resolveChatDefault(tenantId, userId, roleId);
    if (!model) throw noModelAvailable(requested);
    await recordAudit({
      tenantId,
      userId,
      requestId,
      action: 'MODEL_CAPABILITY_FALLBACK',
      resource: 'model',
      resourceId: model.id,
      model: model.name,
      success: true,
      reason: 'embeddings capability does not serve chat turns; chat default used',
      metadata: { capability: requested, strategy: policy.strategy, fallbackModelId: model.id },
    });
    return {
      requested,
      resolved: 'chat',
      model,
      fallbackUsed: true,
      fallbackReason: 'embeddings capability does not serve chat turns',
      strategy: policy.strategy,
    };
  }

  let reason: string | undefined;
  try {
    const model = await resolveServingModel(tenantId, userId, roleId, requested);
    if (model) {
      return { requested, resolved: requested, model, fallbackUsed: false, strategy: policy.strategy };
    }
    reason = 'no serving default configured for capability';
  } catch (error) {
    // Only the expected "stale default" failure triggers fallback. An
    // unexpected error (database outage, programming bug) must surface
    // instead of being silently converted into a chat-model fallback —
    // otherwise a broken model registry would masquerade as a healthy
    // fallback and hide the outage.
    if (!(error instanceof AppError) || error.code !== 'MODEL_NOT_APPROVED') throw error;
    reason = error.message;
  }

  if (!policy.fallbackToChat) {
    await recordAudit({
      tenantId,
      userId,
      requestId,
      action: 'MODEL_CAPABILITY_FALLBACK',
      resource: 'model',
      resourceId: 'none',
      success: false,
      reason: `capability '${requested}' unavailable and fallback_to_chat is disabled`,
      metadata: { capability: requested, strategy: policy.strategy, resolutionFailure: reason },
    });
    throw noModelAvailable(requested);
  }

  const fallback = await resolveChatDefault(tenantId, userId, roleId);
  if (!fallback) throw noModelAvailable(requested);
  await recordAudit({
    tenantId,
    userId,
    requestId,
    action: 'MODEL_CAPABILITY_FALLBACK',
    resource: 'model',
    resourceId: fallback.id,
    model: fallback.name,
    success: true,
    reason,
    metadata: { capability: requested, strategy: policy.strategy, fallbackModelId: fallback.id },
  });
  return {
    requested,
    resolved: 'chat',
    model: fallback,
    fallbackUsed: true,
    fallbackReason: reason,
    strategy: policy.strategy,
  };
}

// Re-export for callers that only need the capability vocabulary.
export { KNOWN_CAPABILITIES };
export type { ApprovedModel };
