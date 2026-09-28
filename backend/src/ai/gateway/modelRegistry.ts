import { randomUUID } from 'node:crypto';
import { getDb, tenantOp } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { Classification } from '../../authz/permissions.js';

/**
 * Canonical tenant default model. Default-open serving: this model is
 * implicitly available to every user in every tenant — no `model_access`
 * grant row required — unless explicitly revoked for their principal.
 * It is also the last-resort fallback for model resolution, so chat can
 * never dead-end on NO_APPROVED_MODEL in normal operation.
 */
export const DEFAULT_MODEL_NAME = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

/** Statuses the gateway will serve traffic to (mirrors modelLifecycle). */
const SERVABLE_STATUSES = ['ACTIVE', 'CANARY'] as const;

export interface ApprovedModel {
  id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  modelIdentifier: string;
  /** Lifecycle status; the gateway only serves ACTIVE and CANARY models. */
  status: 'ACTIVE' | 'CANARY';
  license: string | null;
  source: string | null;
  sha256: string | null;
  contextWindow: number;
  capabilities: Record<string, unknown>;
  allowedClassifications: Classification[];
  deployment: Record<string, unknown>;
  /** Per-model inference timeout override (ms); null = server default. */
  requestTimeoutMs: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  maxTokens: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  temperature: number | null;
  /** Fail over to this model (once, no chains) when the primary fails. */
  fallbackModelId: string | null;
  createdAt: Date;
}

/**
 * MongoDB document shape for the `models` collection: camelCase fields,
 * `_id` is the UUID string (ADR-014). `enabled` and `isDefault` are
 * storage-only — they are not part of the ApprovedModel view.
 */
type ModelDoc = Omit<ApprovedModel, 'id'> & {
  _id: string;
  enabled: boolean;
  /** Marks the tenant default model (set by migration 029; self-healed by ensure). */
  isDefault?: boolean;
};

/** MongoDB document shape for the `model_access` collection. */
interface ModelAccessDoc {
  _id: string;
  tenantId: string;
  modelId: string;
  userId?: string;
  roleId?: string;
  /**
   * Explicit denial for this principal+model. Default-open serving treats a
   * missing row as "allowed" for the default model, so revocation must be
   * written explicitly — deleting a grant row no longer revokes the default.
   */
  revoked?: boolean;
  createdAt: Date;
}

function toApprovedModel(doc: ModelDoc): ApprovedModel {
  const { _id, enabled: _enabled, isDefault: _isDefault, ...rest } = doc;
  return { id: _id, ...rest };
}

/** True when this model doc is the tenant default (flag or canonical name). */
export function isDefaultModelDoc(doc: { name: string; isDefault?: boolean }): boolean {
  return doc.isDefault === true || doc.name === DEFAULT_MODEL_NAME;
}

type MinimalDb = {
  collection<T>(name: string): {
    findOne(filter: unknown, options?: unknown): Promise<T | null>;
    find(filter: unknown): { sort(spec: unknown): { toArray(): Promise<T[]> } };
    updateOne(filter: unknown, update: unknown): Promise<unknown>;
    insertOne(doc: unknown): Promise<unknown>;
  };
};

/** The servable tenant default model doc, if one exists. Prefers an
 * operator-flagged default (`isDefault`) over the canonical seed name. */
async function findServableDefaultModel(db: MinimalDb): Promise<ModelDoc | null> {
  const flagged = await db.collection<ModelDoc>('models').findOne({
    isDefault: true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
  if (flagged) return flagged;
  return db.collection<ModelDoc>('models').findOne({
    name: DEFAULT_MODEL_NAME,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
}

/**
 * Seed shape for the platform default model (mirrors migration 002's seed
 * with migration 028's Ollama repoint). Used only by ensureTenantDefaultModel
 * when the `models` collection has no default at all.
 */
function defaultModelSeed(now: Date): Record<string, unknown> {
  return {
    _id: randomUUID(),
    name: DEFAULT_MODEL_NAME,
    version: '1.0',
    provider: 'ollama',
    endpoint: 'http://ollama:11434',
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    license: 'llama3.1',
    source: 'meta',
    sha256: null,
    contextWindow: 131072,
    capabilities: { chat: true, streaming: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    isDefault: true,
    enabled: true,
    lifecycleUpdatedAt: now,
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: now,
  };
}

/**
 * Ensure the tenant default model exists and is servable (create-on-read).
 * Idempotent: safe to call on every resolution miss.
 *
 * - Returns the servable default when one exists (self-healing the
 *   `isDefault` flag on the canonical seed doc when needed).
 * - Returns null WITHOUT creating anything when the default-named doc
 *   exists but is not servable: an admin deliberately disabled it, and
 *   resurrecting it would override that decision.
 * - Inserts the seed default only when no model doc exists at all
 *   (wiped/dev database); a duplicate-key race re-reads instead of failing.
 */
export async function ensureTenantDefaultModel(): Promise<ApprovedModel | null> {
  const db = (await getDb()) as unknown as MinimalDb;
  const existing = await findServableDefaultModel(db);
  if (existing) {
    if (existing.isDefault !== true) {
      await db.collection<ModelDoc>('models').updateOne({ _id: existing._id }, { $set: { isDefault: true } });
    }
    return toApprovedModel(existing);
  }
  const named = await db
    .collection<ModelDoc>('models')
    .findOne({ name: DEFAULT_MODEL_NAME }, { projection: { _id: 1 } });
  if (named) return null;
  const now = new Date();
  try {
    const seed = defaultModelSeed(now);
    await db.collection<ModelDoc>('models').insertOne(seed);
    return toApprovedModel(seed as unknown as ModelDoc);
  } catch (err) {
    if ((err as { code?: number })?.code !== 11000) throw err;
    const raced = await findServableDefaultModel(db);
    return raced ? toApprovedModel(raced) : null;
  }
}

/** Principal legs for `model_access` queries: exactly one of userId/roleId. */
function principalOr(userId: string, roleId: string): Array<Record<string, string>> {
  return [{ userId }, { roleId }];
}

export async function listApprovedModelsForUser(tenantId: string, userId: string, roleId: string): Promise<ApprovedModel[]> {
  return tenantOp(tenantId, async (db) => {
    // A grant row is (tenantId, modelId) plus exactly one of userId/roleId.
    // Rows marked revoked are explicit denials, not grants.
    const grants = await db
      .collection<ModelAccessDoc>('model_access')
      .find({ tenantId, $or: principalOr(userId, roleId), revoked: { $ne: true } })
      .toArray();
    const modelIds = [...new Set(grants.map((g) => g.modelId))];
    // Default-open: the tenant default model is implicitly available to
    // every user in the tenant — no grant row needed — unless explicitly
    // revoked for their principal. Ensure-on-read: a fresh tenant (or a
    // wiped/never-migrated registry) gets its default model created here,
    // so /models never comes back empty for lack of one. (The chat path
    // ensures independently; the model list must not depend on a chat
    // having happened first.)
    await ensureTenantDefaultModel();
    const defaultDoc = await findServableDefaultModel(db as unknown as MinimalDb);
    if (defaultDoc && !modelIds.includes(defaultDoc._id)) {
      const revocation = await db.collection<ModelAccessDoc>('model_access').findOne(
        { tenantId, modelId: defaultDoc._id, $or: principalOr(userId, roleId), revoked: true },
        { projection: { _id: 1 } }
      );
      if (!revocation) modelIds.push(defaultDoc._id);
    }
    if (modelIds.length === 0) return [];
    const docs = await db
      .collection<ModelDoc>('models')
      .find({ _id: { $in: modelIds }, status: { $in: ['ACTIVE', 'CANARY'] }, enabled: true })
      .sort({ name: 1 })
      .toArray();
    return docs.map(toApprovedModel);
  });
}

export async function getApprovedModelForUser(modelId: string, tenantId: string, userId: string, roleId: string): Promise<ApprovedModel> {
  return tenantOp(tenantId, async (db) => {
    const doc = await db.collection<ModelDoc>('models').findOne({ _id: modelId });
    if (!doc || (doc.status !== 'ACTIVE' && doc.status !== 'CANARY') || !doc.enabled) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
    }
    const access = await db.collection<ModelAccessDoc>('model_access').findOne({
      tenantId,
      modelId,
      $or: principalOr(userId, roleId),
    });
    // An explicit revocation always wins, including for the default model.
    if (access?.revoked === true) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model access has been revoked for this user and tenant');
    }
    // Default-open: the tenant default model needs no grant row.
    if (isDefaultModelDoc(doc)) return toApprovedModel(doc);
    // Non-default models stay fail-closed: an explicit grant is required.
    if (!access) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
    }
    return toApprovedModel(doc);
  });
}
