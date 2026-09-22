import { tenantOp } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { Classification } from '../../authz/permissions.js';

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
 * `_id` is the UUID string (ADR-014). `enabled` is storage-only — it is
 * not part of the ApprovedModel view.
 */
type ModelDoc = Omit<ApprovedModel, 'id'> & { _id: string; enabled: boolean };

/** MongoDB document shape for the `model_access` collection. */
interface ModelAccessDoc {
  _id: string;
  tenantId: string;
  modelId: string;
  userId?: string;
  roleId?: string;
  createdAt: Date;
}

function toApprovedModel(doc: ModelDoc): ApprovedModel {
  const { _id, enabled: _enabled, ...rest } = doc;
  return { id: _id, ...rest };
}

export async function listApprovedModelsForUser(tenantId: string, userId: string, roleId: string): Promise<ApprovedModel[]> {
  return tenantOp(tenantId, async (db) => {
    // A grant row is (tenantId, modelId) plus exactly one of userId/roleId.
    const grants = await db
      .collection<ModelAccessDoc>('model_access')
      .find({ tenantId, $or: [{ userId }, { roleId }] })
      .toArray();
    const modelIds = [...new Set(grants.map((g) => g.modelId))];
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
    const grant = await db.collection<ModelAccessDoc>('model_access').findOne({
      tenantId,
      modelId,
      $or: [{ userId }, { roleId }],
    });
    if (!grant) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
    }
    return toApprovedModel(doc);
  });
}
