import { query } from '../../db/pool.js';
import { Errors } from '../../errors.js';

export interface ApprovedModel {
  id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  status: 'APPROVED';
  license: string | null;
  source: string | null;
  sha256: string | null;
  context_window: number;
  capabilities: Record<string, unknown>;
  classification: string;
  created_at: Date;
}

export async function listApprovedModels(): Promise<ApprovedModel[]> {
  const result = await query<ApprovedModel>(
    `SELECT id, name, version, provider, endpoint, status, license, source,
            sha256, context_window, capabilities, classification, created_at
     FROM models
     WHERE status = 'APPROVED'
     ORDER BY name ASC`
  );
  return result.rows;
}

export async function getApprovedModelByName(name: string): Promise<ApprovedModel> {
  const result = await query<ApprovedModel>(
    `SELECT id, name, version, provider, endpoint, status, license, source,
            sha256, context_window, capabilities, classification, created_at
     FROM models
     WHERE name = $1 AND status = 'APPROVED'`,
    [name]
  );

  const model = result.rows[0];
  if (!model) {
    throw Errors.forbidden(
      'MODEL_NOT_APPROVED',
      `Model '${name}' is not found or not approved for use`
    );
  }

  return model;
}
