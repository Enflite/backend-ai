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
 * serves, never WHETHER an unauthorized one may. Serving is default-open:
 * the tenant default model (see modelRegistry.ensureTenantDefaultModel) is
 * implicitly available to every user in the tenant, so a user with no
 * explicit grants still resolves to the default instead of failing closed.
 */
import { Errors, AppError } from '../../errors.js';
import { config } from '../../config.js';
import { tenantOp, withTenantTx } from '../../db/mongo.js';
import { recordAudit, recordAuditInTx } from '../../audit/audit.js';
import { KNOWN_CAPABILITIES, resolveServingModel } from './modelLifecycle.js';
import {
  getApprovedModelForUser,
  listApprovedModelsForUser,
  ensureTenantDefaultModel,
  ensureVisionModel,
  findServableVisionModelForGroup,
  isVisionCapableModel,
  type ApprovedModel,
} from './modelRegistry.js';
import type { ProviderGroup } from '../providers/providerDisplay.js';

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

/** MongoDB document shape for the `model_routing_policies` collection (ADR-014). */
interface RoutingPolicyDoc {
  _id: string;
  tenantId: string;
  capability: string;
  strategy: RoutingStrategy;
  fallbackToChat: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

function toRoutingPolicy(doc: RoutingPolicyDoc): RoutingPolicy {
  return {
    tenantId: doc.tenantId,
    capability: doc.capability,
    strategy: doc.strategy,
    fallbackToChat: doc.fallbackToChat,
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  };
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
  const doc = await tenantOp(tenantId, async (db) =>
    db.collection<RoutingPolicyDoc>('model_routing_policies').findOne({ tenantId, capability: normalized })
  );
  if (doc) return toRoutingPolicy(doc);
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
  const docs = await tenantOp(tenantId, async (db) =>
    db
      .collection<RoutingPolicyDoc>('model_routing_policies')
      .find({ tenantId })
      .sort({ capability: 1 })
      .toArray()
  );
  return docs.map(toRoutingPolicy);
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
  // Tenant-scoped transaction: the policy upsert and its audit event commit
  // together, so a policy can never change unaudited.
  return withTenantTx(tenantId, async (session, db) => {
    const coll = db.collection<RoutingPolicyDoc>('model_routing_policies');
    await coll.updateOne(
      { tenantId, capability: normalized },
      {
        $set: {
          strategy: policy.strategy,
          fallbackToChat: policy.fallbackToChat,
          updatedBy: actorUserId,
          updatedAt: new Date(),
        },
      },
      { upsert: true, session }
    );
    const doc = await coll.findOne({ tenantId, capability: normalized }, { session });
    if (!doc) {
      throw Errors.internal('Routing policy upsert did not return a document', undefined, 'MODEL_ROUTING_POLICY_UPSERT_FAILED');
    }
    await recordAuditInTx(session, {
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
    return toRoutingPolicy(doc);
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
 * first-approved model, else the ensured tenant default. Shared so the
 * router and the route cannot drift.
 *
 * Default-open: a stale or ungranted admin serving default falls through
 * to the next legs instead of failing the turn (only unexpected errors —
 * database outage, programming bug — propagate). The ensured tenant
 * default makes a null return possible only when no servable model exists
 * at all (e.g. an admin disabled the default).
 */
export async function resolveChatDefault(
  tenantId: string,
  userId: string,
  roleId: string
): Promise<ApprovedModel | null> {
  try {
    const serving = await resolveServingModel(tenantId, userId, roleId, 'chat');
    if (serving) return serving;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'MODEL_NOT_APPROVED') throw error;
  }
  return (
    (await listApprovedModelsForUser(tenantId, userId, roleId))[0] ??
    (await ensureTenantDefaultModel())
  );
}

/**
 * Default-open model resolution for routes. Every tenant always resolves
 * to at least the tenant default model, so the old NO_APPROVED_MODEL dead
 * end is unreachable in normal operation.
 *
 * Throws MODEL_UNAVAILABLE (an operational error, never a permissions
 * denial) only when no servable model exists at all — e.g. an admin
 * disabled the default model.
 */
export async function resolveDefaultOpenModel(
  tenantId: string,
  userId: string,
  roleId: string
): Promise<ApprovedModel> {
  const model = await resolveChatDefault(tenantId, userId, roleId);
  if (model) return model;
  throw Errors.internal(
    'No servable AI model is available for this tenant. An administrator may have disabled the default model.',
    undefined,
    'MODEL_UNAVAILABLE'
  );
}

function noModelAvailable(requested: Capability): Error {
  return Errors.forbidden(
    'NO_APPROVED_MODEL',
    `No approved model is available for capability '${requested}'`
  );
}

/**
 * Resolve the platform vision model for a turn carrying image attachments.
 *
 * Unlike the other capabilities this NEVER falls back to the text chat
 * default: the default model (llama3.1:8b) is text-only and must never
 * receive image payloads. Resolution order:
 *
 * 1. The admin-configured vision serving default (verified servable and
 *    authorized for this caller by resolveServingModel) — and verified to
 *    actually advertise vision capability, so a misconfigured text-only
 *    default can never receive image payloads.
 * 2. The platform vision model (ensure-on-read seed), re-verified for this
 *    caller via getApprovedModelForUser so an explicit revocation still
 *    denies.
 *
 * While OLLAMA_ENABLED=false (Claude-only launch) step 2 is replaced: the
 * Qwen seed is never created and image turns resolve the configured Claude
 * vision model instead. A text-only model must never receive image
 * payloads on either path.
 *
 * Fails closed (NO_APPROVED_MODEL) when no servable vision model exists —
 * an admin disabled the vision model deliberately.
 */
export async function resolveVisionModel(options: {
  tenantId: string;
  userId: string;
  roleId: string;
  requestId?: string;
}): Promise<ApprovedModel> {
  const { tenantId, userId, roleId, requestId } = options;
  try {
    const serving = await resolveServingModel(tenantId, userId, roleId, 'vision');
    if (serving) {
      // A serving default is admin-configured, not capability-checked: a
      // text-only model in the vision slot must never receive image payloads.
      if (isVisionCapableModel(serving)) return serving;
      await recordAudit({
        tenantId,
        userId,
        requestId,
        action: 'MODEL_CAPABILITY_FALLBACK',
        resource: 'model',
        resourceId: serving.id,
        success: false,
        reason: `vision serving default "${serving.name}" is not vision-capable; falling back to platform vision model`,
        metadata: { capability: 'vision', misconfiguredModel: serving.name },
      });
    }
  } catch (error) {
    // Only the expected "stale default" failure falls through to the
    // platform vision model. Anything else (outage, programming bug) must
    // surface rather than masquerade as a healthy resolution.
    if (!(error instanceof AppError) || error.code !== 'MODEL_NOT_APPROVED') throw error;
    await recordAudit({
      tenantId,
      userId,
      requestId,
      action: 'MODEL_CAPABILITY_FALLBACK',
      resource: 'model',
      resourceId: 'none',
      success: false,
      reason: `stale vision serving default: ${error.message}; falling back to platform vision model`,
      metadata: { capability: 'vision', resolutionFailure: error.message },
    });
  }
  // Claude-only launch: never create or resolve the Qwen seed — the
  // configured Claude vision model serves image turns.
  if (!config.OLLAMA_ENABLED) {
    const claudeVision = await findServableVisionModelForGroup('claude');
    if (claudeVision) {
      return getApprovedModelForUser(claudeVision._id, tenantId, userId, roleId);
    }
    throw noModelAvailable('vision');
  }
  const ensured = await ensureVisionModel();
  if (ensured) {
    return getApprovedModelForUser(ensured.id, tenantId, userId, roleId);
  }
  throw noModelAvailable('vision');
}

export { isVisionCapableModel };

/**
 * Resolve the vision model for a provider group (ADR-018).
 *
 * Image turns stay on the user's active provider when that provider has a
 * servable vision model: 'enflite' reuses the platform vision model,
 * 'claude'/'openai' resolve their own vision-capable seeds (ensured on
 * read). When the group has no servable vision model — provider not
 * configured, or the model revoked — the turn falls back to the platform
 * vision model rather than failing: the chat route tells the user which
 * model is reading their images, never silently.
 *
 * While OLLAMA_ENABLED=false the platform vision model is the configured
 * Claude vision model (the Qwen seed is never created); the 'enflite'
 * group resolves through resolveVisionModel and lands on Claude as well.
 */
export async function resolveVisionModelForGroup(options: {
  tenantId: string;
  userId: string;
  roleId: string;
  group: ProviderGroup;
  requestId?: string;
}): Promise<ApprovedModel> {
  const { tenantId, userId, roleId, group, requestId } = options;
  if (group === 'enflite') {
    return resolveVisionModel({ tenantId, userId, roleId, requestId });
  }
  const ensured = await findServableVisionModelForGroup(group);
  if (ensured) {
    try {
      return await getApprovedModelForUser(ensured._id, tenantId, userId, roleId);
    } catch (error) {
      // Only the expected "not approved for this caller" failure falls
      // through to the Enflite vision model. Anything else (outage,
      // programming bug) must surface.
      if (!(error instanceof AppError) || error.code !== 'MODEL_NOT_APPROVED') throw error;
    }
  }
  return resolveVisionModel({ tenantId, userId, roleId, requestId });
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
    // Default-open: resolveDefaultOpenModel throws MODEL_UNAVAILABLE (never
    // a permissions denial) only when no servable model exists at all.
    const model = await resolveDefaultOpenModel(tenantId, userId, roleId);
    return { requested, resolved: 'chat', model, fallbackUsed: false, strategy: policy.strategy };
  }

  if (requested === 'vision') {
    // Vision turns never fall back to the text chat default: the default
    // model is text-only and must never receive image payloads. Fails closed
    // (NO_APPROVED_MODEL) when no servable vision model exists.
    const model = await resolveVisionModel({ tenantId, userId, roleId, requestId });
    return { requested, resolved: 'vision', model, fallbackUsed: false, strategy: policy.strategy };
  }

  if (requested === 'embeddings') {    // The embeddings slot is not a chat model: document retrieval and
    // ingestion resolve through resolveEmbeddingProvider (see
    // docs/inference.md §3). A chat turn asking for 'embeddings' gets the
    // chat default, audited, rather than a confusing failure.
    const model = await resolveDefaultOpenModel(tenantId, userId, roleId);
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

  const fallback = await resolveDefaultOpenModel(tenantId, userId, roleId);
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
