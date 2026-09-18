import pg from 'pg';
import { query, tenantQuery } from '../db/pool.js';
import { config } from '../config.js';
import { AppError } from '../errors.js';

/**
 * Thrown by recordAudit when the audit write fails and AUDIT_FAIL_CLOSED is
 * enabled (the production default). The request fails with a 503 instead of
 * proceeding with a silently dropped audit trail. Carries no secrets: the
 * underlying database error is deliberately not attached to the message or
 * details, which the error handler renders into the HTTP response.
 */
export class AuditPersistenceError extends AppError {
  constructor() {
    super(503, 'AUDIT_PERSISTENCE_FAILED', 'Audit event could not be persisted');
    this.name = 'AuditPersistenceError';
  }
}

export interface AuditInput {
  tenantId?: string | null;
  userId?: string | null;
  requestId?: string | null;
  ip?: string | null;
  action: string;
  resource?: string | null;
  resourceId?: string | null;
  classification?: string | null;
  model?: string | null;
  tool?: string | null;
  success?: boolean;
  reason?: string | null;
  metadata?: Record<string, unknown>;
}

const SENSITIVE_KEYS = new Set([
  'password',
  'password_hash',
  'token',
  'jwt',
  'secret',
  'authorization',
  'content',
  'prompt',
  'messages',
  'user_message',
  'assistant_message',
]);

function sanitizeMetadata(metadata?: Record<string, unknown>): Record<string, unknown> {
  if (!metadata) return {};
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      cleaned[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      cleaned[key] = sanitizeMetadata(value as Record<string, unknown>);
    } else {
      cleaned[key] = value;
    }
  }
  return cleaned;
}

const MAX_REASON_LENGTH = 500;

// Upstream error messages can embed internal hostnames, URLs, or fragments of
// request data. Audit reasons are stored, not shown to end users, but keep them
// bounded and free of credential-shaped material anyway. The credential pattern
// also matches quoted keys (`"password":"..."`) and quoted values
// (`password="correct horse"`); a bare \S+ value would stop at the first space
// and leak the rest.
export function sanitizeReason(reason?: string | null): string | null {
  if (reason == null) return null;
  return reason
    .replace(/\bbearer\s+\S+/gi, 'Bearer=[REDACTED]')
    .replace(
      /["']?(token|api[_-]?key|secret|password)["']?\s*[:=]\s*("[^"\r\n]*"|'[^'\r\n]*'|\S+)/gi,
      '$1=[REDACTED]'
    )
    .replace(/:\/\/[^/\s:]+:[^/\s@]+@/g, '://[REDACTED]@')
    .slice(0, MAX_REASON_LENGTH);
}

const INSERT_AUDIT_SQL = `INSERT INTO audit_events (
    tenant_id, user_id, request_id, ip, action, resource,
    resource_id, classification, model, tool, success, reason, metadata
  ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

function auditParams(input: AuditInput): unknown[] {
  return [
    input.tenantId ?? null,
    input.userId ?? null,
    input.requestId ?? null,
    input.ip ?? null,
    input.action,
    input.resource ?? null,
    input.resourceId ?? null,
    input.classification ?? null,
    input.model ?? null,
    input.tool ?? null,
    input.success ?? true,
    sanitizeReason(input.reason),
    JSON.stringify(sanitizeMetadata(input.metadata)),
  ];
}

function handleAuditWriteError(input: AuditInput, err: unknown): void {
  if (config.AUDIT_FAIL_CLOSED) {
    // Fail closed: a dropped audit trail must not let the audited action
    // proceed silently. Log only non-sensitive correlation fields — never
    // the raw database error, which can embed connection details.
    console.error('Audit persistence failed (fail-closed):', {
      action: input.action,
      requestId: input.requestId ?? undefined,
    });
    throw new AuditPersistenceError();
  }
  console.error('Failed to record audit event:', err);
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const params = auditParams(input);
    if (input.tenantId) {
      await tenantQuery(input.tenantId, INSERT_AUDIT_SQL, params);
    } else {
      await query(INSERT_AUDIT_SQL, params);
    }
  } catch (err) {
    handleAuditWriteError(input, err);
  }
}

/**
 * Insert an audit row inside an existing transaction. Use this when the audit
 * event must commit atomically with the state change it describes (e.g. the
 * model enabled-toggle): a fail-closed audit failure then rolls the change
 * back instead of leaving it committed but unaudited. Preserves recordAudit's
 * RLS semantics by setting the tenant context when a tenantId is present.
 */
export async function recordAuditInTx(client: pg.PoolClient, input: AuditInput): Promise<void> {
  try {
    if (input.tenantId) {
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [input.tenantId]);
    }
    await client.query(INSERT_AUDIT_SQL, auditParams(input));
  } catch (err) {
    handleAuditWriteError(input, err);
  }
}
