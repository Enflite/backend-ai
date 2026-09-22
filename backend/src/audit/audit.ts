import { randomUUID } from 'node:crypto';
import { ClientSession } from 'mongodb';
import { getDb } from '../db/mongo.js';
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

function auditDocument(input: AuditInput): AuditEventDoc {
  return {
    _id: randomUUID(),
    // tenantId is nullable by design: platform-global events are stored with
    // tenantId null (the old custom RLS policy allowed NULL-tenant rows).
    // There is no RLS in MongoDB — readers filter { tenantId } or
    // { tenantId: null } explicitly.
    tenantId: input.tenantId ?? null,
    userId: input.userId ?? null,
    requestId: input.requestId ?? null,
    ip: input.ip ?? null,
    action: input.action,
    resource: input.resource ?? null,
    resourceId: input.resourceId ?? null,
    classification: input.classification ?? null,
    model: input.model ?? null,
    tool: input.tool ?? null,
    success: input.success ?? true,
    reason: sanitizeReason(input.reason),
    metadata: sanitizeMetadata(input.metadata),
    legalHold: false,
    createdAt: new Date(),
  };
}

/** Document shape for the `audit_events` collection. `_id` is an app-generated UUID string (ADR-014). */
export interface AuditEventDoc {
  _id: string;
  tenantId: string | null;
  userId: string | null;
  requestId: string | null;
  ip: string | null;
  action: string;
  resource: string | null;
  resourceId: string | null;
  classification: string | null;
  model: string | null;
  tool: string | null;
  success: boolean;
  reason: string | null;
  metadata: Record<string, unknown>;
  legalHold: boolean;
  createdAt: Date;
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
    const db = await getDb();
    await db.collection<AuditEventDoc>('audit_events').insertOne(auditDocument(input));
  } catch (err) {
    handleAuditWriteError(input, err);
  }
}

/**
 * Delete platform-global (NULL-tenant) audit rows older than `days`,
 * honoring legal hold. Runs in bounded batches: there is no tenant context
 * for global rows, so the filter pins `tenantId: null` explicitly — only
 * global rows can ever match. Returns the total rows deleted.
 *
 * Tenant-scoped audit purging lives in retention/purge.ts and always
 * filters by the tenant's tenantId.
 */
export async function purgeGlobalAuditEvents(days: number, batchSize: number): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const batch = await db
      .collection<AuditEventDoc>('audit_events')
      .find({ tenantId: null, legalHold: false, createdAt: { $lt: cutoff } })
      .project({ _id: 1 })
      .limit(batchSize)
      .toArray();
    if (batch.length === 0) break;
    const result = await db
      .collection<AuditEventDoc>('audit_events')
      // The _id batch came from the tenantId-null query above; the
      // tenantId: null pin here is defense-in-depth so this delete can
      // never touch a tenant-scoped row even if a batch were corrupted.
      .deleteMany({ tenantId: null, _id: { $in: batch.map((doc) => doc._id) } });
    total += result.deletedCount ?? 0;
    if (batch.length < batchSize) break;
  }
  return total;
}

/**
 * Insert an audit row inside an existing transaction. Use this when the audit
 * event must commit atomically with the state change it describes (e.g. the
 * model enabled-toggle): a fail-closed audit failure then rolls the change
 * back instead of leaving it committed but unaudited. getDb() returns the
 * singleton client's database, and the session pins the insert to the
 * caller's multi-document transaction.
 */
export async function recordAuditInTx(session: ClientSession, input: AuditInput): Promise<void> {
  try {
    const db = await getDb();
    await db.collection<AuditEventDoc>('audit_events').insertOne(auditDocument(input), { session });
  } catch (err) {
    handleAuditWriteError(input, err);
  }
}
