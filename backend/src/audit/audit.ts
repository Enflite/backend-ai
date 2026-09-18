import { query, tenantQuery } from '../db/pool.js';

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
// bounded and free of credential-shaped material anyway.
export function sanitizeReason(reason?: string | null): string | null {
  if (reason == null) return null;
  return reason
    .replace(/\bbearer\s+\S+/gi, 'Bearer=[REDACTED]')
    .replace(/(token|api[_-]?key|secret|password)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .replace(/:\/\/[^/\s:]+:[^/\s@]+@/g, '://[REDACTED]@')
    .slice(0, MAX_REASON_LENGTH);
}

export async function recordAudit(input: AuditInput): Promise<void> {
  try {
    const sanitizedMeta = sanitizeMetadata(input.metadata);
    const execute = input.tenantId ? tenantQuery.bind(null, input.tenantId) : query;
    await execute(
      `INSERT INTO audit_events (
        tenant_id, user_id, request_id, ip, action, resource,
        resource_id, classification, model, tool, success, reason, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
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
        JSON.stringify(sanitizedMeta),
      ]
    );
  } catch (err) {
    console.error('Failed to record audit event:', err);
  }
}
