import { tenantQuery } from '../../db/pool.js';
import { Errors } from '../../errors.js';
import { Classification } from '../../authz/permissions.js';

export interface ApprovedModel {
  id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  model_identifier: string;
  status: 'APPROVED';
  license: string | null;
  source: string | null;
  sha256: string | null;
  context_window: number;
  capabilities: Record<string, unknown>;
  allowed_classifications: Classification[];
  deployment: Record<string, unknown>;
  /** Per-model inference timeout override (ms); null = server default. */
  request_timeout_ms: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  max_tokens: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  temperature: number | null;
  /** Fail over to this model (once, no chains) when the primary fails. */
  fallback_model_id: string | null;
  created_at: Date;
}

const MODEL_FIELDS = `m.id, m.name, m.version, m.provider, m.endpoint, m.model_identifier,
  m.status, m.license, m.source, m.sha256, m.context_window, m.capabilities,
  m.allowed_classifications, m.deployment, m.request_timeout_ms, m.max_tokens,
  m.temperature, m.fallback_model_id, m.created_at`;

export async function listApprovedModelsForUser(tenantId: string, userId: string, roleId: string): Promise<ApprovedModel[]> {
  return (
    await tenantQuery<ApprovedModel>(
      tenantId,
      `SELECT DISTINCT ${MODEL_FIELDS}
       FROM models m JOIN model_access ma ON ma.model_id = m.id AND ma.tenant_id = $1
       WHERE m.status = 'APPROVED' AND m.enabled AND (ma.user_id = $2 OR ma.role_id = $3)
       ORDER BY m.name ASC`,
      [tenantId, userId, roleId]
    )
  ).rows;
}

export async function getApprovedModelForUser(modelId: string, tenantId: string, userId: string, roleId: string): Promise<ApprovedModel> {
  const model = (
    await tenantQuery<ApprovedModel>(
      tenantId,
      `SELECT DISTINCT ${MODEL_FIELDS}
       FROM models m JOIN model_access ma ON ma.model_id = m.id AND ma.tenant_id = $2
       WHERE m.id = $1 AND m.status = 'APPROVED' AND m.enabled
         AND (ma.user_id = $3 OR ma.role_id = $4)`,
      [modelId, tenantId, userId, roleId]
    )
  ).rows[0];
  if (!model) throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
  return model;
}
