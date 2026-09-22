/**
 * modelLifecycle.ts — model approval/promotion lifecycle.
 *
 * Lifecycle: REGISTERED -> DOWNLOADING -> VALIDATING -> EVALUATING
 *   -> PENDING_APPROVAL -> APPROVED -> CANARY -> ACTIVE
 *   -> DEPRECATED -> RETIRED
 * DISABLED is an admin kill-switch (ACTIVE/CANARY/DEPRECATED -> DISABLED ->
 * ACTIVE); RETIRED is terminal.
 *
 * Only ACTIVE and CANARY models are servable. APPROVED means the model
 * passed evaluation and is cleared for activation — it serves no traffic
 * until explicitly activated. Every transition is validated against the
 * state machine, and the PENDING_APPROVAL -> APPROVED transition additionally
 * requires the Phase 2 eval promotion gate (getPromotionGate) to pass:
 * failed required evals block promotion, no exceptions, no bypass flag.
 *
 * Every transition commits together with its audit event in one
 * transaction, so a model can never change state unaudited.
 */
import { withTx, tenantOp } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { recordAuditInTx } from '../../audit/audit.js';
import { getPromotionGate } from '../../eval/compare.js';
import { getApprovedModelForUser } from './modelRegistry.js';

export const MODEL_STATUSES = [
  'REGISTERED',
  'DOWNLOADING',
  'VALIDATING',
  'EVALUATING',
  'PENDING_APPROVAL',
  'APPROVED',
  'CANARY',
  'ACTIVE',
  'DEPRECATED',
  'DISABLED',
  'RETIRED',
] as const;
export type ModelStatus = (typeof MODEL_STATUSES)[number];

/** Statuses the gateway will serve traffic to (plus the enabled flag). */
export const SERVABLE_STATUSES: readonly ModelStatus[] = ['CANARY', 'ACTIVE'];

/**
 * Allowed transitions. RETIRED is terminal. DISABLED is the admin
 * kill-switch: it can only be left via explicit re-activation to ACTIVE.
 */
export const LIFECYCLE_TRANSITIONS: Record<ModelStatus, readonly ModelStatus[]> = {
  REGISTERED: ['DOWNLOADING', 'VALIDATING', 'RETIRED'],
  DOWNLOADING: ['VALIDATING', 'REGISTERED', 'RETIRED'],
  VALIDATING: ['EVALUATING', 'REGISTERED', 'RETIRED'],
  EVALUATING: ['PENDING_APPROVAL', 'REGISTERED', 'RETIRED'],
  PENDING_APPROVAL: ['APPROVED', 'REGISTERED', 'RETIRED'],
  APPROVED: ['CANARY', 'ACTIVE', 'DEPRECATED', 'RETIRED'],
  CANARY: ['ACTIVE', 'DEPRECATED', 'RETIRED'],
  ACTIVE: ['DEPRECATED', 'DISABLED', 'RETIRED'],
  DEPRECATED: ['ACTIVE', 'RETIRED'],
  DISABLED: ['ACTIVE', 'RETIRED'],
  RETIRED: [],
};

export function isValidTransition(from: ModelStatus, to: ModelStatus): boolean {
  return LIFECYCLE_TRANSITIONS[from]?.includes(to) ?? false;
}

export function isServableStatus(status: string): status is 'CANARY' | 'ACTIVE' {
  return status === 'CANARY' || status === 'ACTIVE';
}

/** MongoDB document shape for the fields transitionModel reads (ADR-014). */
interface ModelLifecycleDoc {
  _id: string;
  status: string;
  version: string;
  enabled: boolean;
}

export interface TransitionModelInput {
  modelId: string;
  toStatus: ModelStatus;
  /** Admin performing the transition (for approved_by + audit). */
  actorUserId: string;
  tenantId: string;
  requestId?: string;
  ip?: string;
}

export interface TransitionModelResult {
  modelId: string;
  fromStatus: ModelStatus;
  toStatus: ModelStatus;
  /** Set when the transition ran the eval promotion gate. */
  gateRunId: string | null;
}

/**
 * Move a model to a new lifecycle status. Validates the state machine,
 * enforces the eval promotion gate on approval, and audits atomically.
 *
 * There is deliberately no "force" or "skip gate" option: a model that
 * fails required evals cannot be approved through this API, period.
 */
export async function transitionModel(input: TransitionModelInput): Promise<TransitionModelResult> {
  return withTx(async (session, db) => {
    const models = db.collection<ModelLifecycleDoc>('models');
    const row = await models.findOne({ _id: input.modelId }, { session });
    if (!row) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');

    const fromStatus = row.status as ModelStatus;
    if (!MODEL_STATUSES.includes(fromStatus)) {
      throw Errors.internal('Model has unknown lifecycle status', undefined, 'MODEL_STATUS_UNKNOWN');
    }
    if (!isValidTransition(fromStatus, input.toStatus)) {
      throw Errors.badRequest(
        'MODEL_TRANSITION_INVALID',
        `Cannot transition model from ${fromStatus} to ${input.toStatus}`
      );
    }

    // The promotion gate: PENDING_APPROVAL -> APPROVED requires a completed
    // eval run for the CURRENT version with zero p0 failures and no
    // grounding/honesty regressions. Failed required evals block promotion.
    let gateRunId: string | null = null;
    let approvedBy: string | null = null;
    let approvedAt: Date | null = null;
    if (input.toStatus === 'APPROVED') {
      const gate = await getPromotionGate(input.modelId);
      if (!gate.eligible) {
        throw Errors.badRequest(
          'MODEL_PROMOTION_GATE_FAILED',
          `Model cannot be approved: ${gate.reason}`
        );
      }
      gateRunId = gate.latestRunId;
      approvedBy = input.actorUserId;
      approvedAt = new Date();
    }

    // The approval fields are only stamped on the PENDING_APPROVAL ->
    // APPROVED transition; other transitions leave the existing values.
    await models.updateOne(
      { _id: input.modelId },
      {
        $set: {
          status: input.toStatus,
          lifecycleUpdatedAt: new Date(),
          ...(input.toStatus === 'APPROVED' ? { approvedBy, approvedAt, lastEvalRunId: gateRunId } : {}),
        },
      },
      { session }
    );

    await recordAuditInTx(session, {
      tenantId: input.tenantId,
      userId: input.actorUserId,
      requestId: input.requestId,
      ip: input.ip,
      action: 'MODEL_LIFECYCLE_TRANSITION',
      resource: 'model',
      resourceId: input.modelId,
      success: true,
      metadata: {
        fromStatus,
        toStatus: input.toStatus,
        ...(gateRunId ? { gateRunId, gatePassed: true } : {}),
      },
    });

    return { modelId: input.modelId, fromStatus, toStatus: input.toStatus, gateRunId };
  });
}

// ---------------------------------------------------------------------------
// Serving defaults: which model serves a tenant+capability.
// ---------------------------------------------------------------------------

/**
 * Well-known capability slots. The column itself is free-form so new
 * capabilities don't need a migration; these are the slots the platform
 * resolves today.
 */
export const KNOWN_CAPABILITIES = ['chat', 'syteline', 'coding', 'embeddings'] as const;

export interface ServingDefault {
  tenantId: string;
  capability: string;
  modelId: string;
  updatedBy: string | null;
  updatedAt: Date;
}

/** MongoDB document shape for the `model_serving_defaults` collection (ADR-014). */
interface ServingDefaultDoc {
  _id: string;
  tenantId: string;
  capability: string;
  modelId: string;
  updatedBy: string | null;
  updatedAt: Date;
}

function toServingDefault(doc: ServingDefaultDoc): ServingDefault {
  return {
    tenantId: doc.tenantId,
    capability: doc.capability,
    modelId: doc.modelId,
    updatedBy: doc.updatedBy,
    updatedAt: doc.updatedAt,
  };
}

/**
 * Set (upsert) the default model for a tenant+capability. Admin-only
 * (model:manage), audited. The model must be servable (ACTIVE/CANARY) and
 * enabled — a default that points at a non-servable model would silently
 * break resolution, so it is rejected up front.
 */
export async function setServingDefault(
  tenantId: string,
  capability: string,
  modelId: string,
  actorUserId: string,
  requestId?: string,
  ip?: string
): Promise<ServingDefault> {
  const normalizedCapability = capability.trim().toLowerCase();
  if (!normalizedCapability || normalizedCapability.length > 64) {
    throw Errors.badRequest('INVALID_CAPABILITY', 'Capability must be a non-empty string up to 64 characters');
  }
  return withTx(async (session, db) => {
    const model = await db
      .collection<{ _id: string; status: string; enabled: boolean }>('models')
      .findOne({ _id: modelId }, { session });
    if (!model) throw Errors.notFound('MODEL_NOT_FOUND', 'Model not found');
    if (!isServableStatus(model.status) || !model.enabled) {
      throw Errors.badRequest(
        'MODEL_NOT_SERVABLE',
        'Serving defaults must point at an enabled ACTIVE or CANARY model'
      );
    }
    const coll = db.collection<ServingDefaultDoc>('model_serving_defaults');
    await coll.updateOne(
      { tenantId, capability: normalizedCapability },
      { $set: { modelId, updatedBy: actorUserId, updatedAt: new Date() } },
      { upsert: true, session }
    );
    const doc = await coll.findOne({ tenantId, capability: normalizedCapability }, { session });
    if (!doc) {
      throw Errors.internal('Serving default upsert did not return a document', undefined, 'MODEL_SERVING_DEFAULT_UPSERT_FAILED');
    }
    await recordAuditInTx(session, {
      tenantId,
      userId: actorUserId,
      requestId,
      ip,
      action: 'MODEL_SERVING_DEFAULT_SET',
      resource: 'model_serving_default',
      resourceId: `${tenantId}:${normalizedCapability}`,
      success: true,
      metadata: { capability: normalizedCapability, modelId },
    });
    return toServingDefault(doc);
  });
}

export async function getServingDefault(tenantId: string, capability: string): Promise<ServingDefault | null> {
  const doc = await tenantOp(tenantId, async (db) =>
    db
      .collection<ServingDefaultDoc>('model_serving_defaults')
      .findOne({ tenantId, capability: capability.trim().toLowerCase() })
  );
  return doc ? toServingDefault(doc) : null;
}

export async function listServingDefaults(tenantId: string): Promise<ServingDefault[]> {
  const docs = await tenantOp(tenantId, async (db) =>
    db
      .collection<ServingDefaultDoc>('model_serving_defaults')
      .find({ tenantId })
      .sort({ capability: 1 })
      .toArray()
  );
  return docs.map(toServingDefault);
}

/**
 * Resolve the model a tenant+capability should serve: the admin-configured
 * default, verified servable and authorized for the caller. Returns null
 * when no default is configured (callers fall back to the first approved
 * model, as today).
 */
export async function resolveServingModel(
  tenantId: string,
  userId: string,
  roleId: string,
  capability: string
) {
  const def = await getServingDefault(tenantId, capability);
  if (!def) return null;
  // getApprovedModelForUser re-verifies servable status, enabled flag,
  // tenant grant, and classification on every resolution: a default that
  // went stale (model deprecated, grant revoked) fails closed here.
  return getApprovedModelForUser(def.modelId, tenantId, userId, roleId);
}
