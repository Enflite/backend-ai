/**
 * purge.ts — retention purge job (Phase 5c).
 *
 * Deletes expired conversations, messages, and audit events per the
 * effective retention policy (per-tenant `retention_policies` overrides,
 * falling back to the global RETENTION_*_DAYS config). NULL/0 disables
 * purging for that table.
 *
 * Legal holds exempt records: conversations with legal_hold (and all of
 * their messages, via the join) and audit events with legal_hold are
 * never deleted.
 *
 * Audit reconciliation: audit is append-only by convention, but legal
 * retention requires old audit rows to be deletable. Every purge writes a
 * RETENTION_PURGE summary event *after* deleting (counts per table, the
 * effective policy, the cutoff window — no sensitive content). The summary
 * row is new, so it survives its own retention window, and it is the
 * durable non-sensitive record of what was deleted and why.
 */

import { config } from '../config.js';
import { query, tenantQuery } from '../db/pool.js';
import { purgeGlobalAuditEvents, recordAudit } from '../audit/audit.js';

export interface RetentionPolicy {
  conversationsDays: number | null;
  messagesDays: number | null;
  auditEventsDays: number | null;
}

export interface PurgeCounts {
  conversations: number;
  messages: number;
  auditEvents: number;
}

/** Deletes run in bounded batches so a large backlog never holds a long transaction. */
const PURGE_BATCH_SIZE = 1000;

function purgeEnabled(days: number | null | undefined): days is number {
  return typeof days === 'number' && days > 0;
}

/** Test seam: row type returned from retention_policies. */
export interface RetentionPolicyRow {
  conversations_days: number | null;
  messages_days: number | null;
  audit_events_days: number | null;
}

export function effectivePolicy(row: RetentionPolicyRow | undefined): RetentionPolicy {
  return {
    conversationsDays: row?.conversations_days ?? config.RETENTION_CONVERSATIONS_DAYS,
    messagesDays: row?.messages_days ?? config.RETENTION_MESSAGES_DAYS,
    auditEventsDays: row?.audit_events_days ?? config.RETENTION_AUDIT_EVENTS_DAYS,
  };
}

export async function resolvePolicy(tenantId: string): Promise<RetentionPolicy> {
  const row = (
    await tenantQuery<RetentionPolicyRow>(
      tenantId,
      'SELECT conversations_days, messages_days, audit_events_days FROM retention_policies WHERE tenant_id = $1',
      [tenantId]
    )
  ).rows[0];
  return effectivePolicy(row);
}

async function purgeMessages(tenantId: string, days: number): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await tenantQuery(
      tenantId,
      `DELETE FROM messages
       WHERE id IN (
         SELECT m.id FROM messages m
         JOIN conversations c ON c.id = m.conversation_id
         WHERE m.tenant_id = $1
           AND c.legal_hold = false
           AND m.created_at < NOW() - ($2 || ' days')::interval
         LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [tenantId, String(days)]
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < PURGE_BATCH_SIZE) break;
  }
  return total;
}

async function purgeConversations(
  tenantId: string,
  days: number
): Promise<{ conversations: number; messages: number }> {
  let conversations = 0;
  let messages = 0;
  for (;;) {
    // Messages are deleted explicitly (not left to the FK cascade) so the
    // audit summary counts every deleted record.
    const result = await tenantQuery<{ conversations: string; messages: string }>(
      tenantId,
      `WITH conv AS (
         SELECT id FROM conversations
         WHERE tenant_id = $1
           AND legal_hold = false
           AND updated_at < NOW() - ($2 || ' days')::interval
         LIMIT ${PURGE_BATCH_SIZE}
       ),
       msg AS (
         DELETE FROM messages WHERE conversation_id IN (SELECT id FROM conv)
         RETURNING id
       ),
       del AS (
         DELETE FROM conversations WHERE id IN (SELECT id FROM conv)
         RETURNING id
       )
       SELECT (SELECT COUNT(*) FROM del) AS conversations,
              (SELECT COUNT(*) FROM msg) AS messages`,
      [tenantId, String(days)]
    );
    const row = result.rows[0];
    const deletedConvs = Number(row?.conversations ?? 0);
    conversations += deletedConvs;
    messages += Number(row?.messages ?? 0);
    if (deletedConvs < PURGE_BATCH_SIZE) break;
  }
  return { conversations, messages };
}

async function purgeAuditEvents(tenantId: string | null, days: number): Promise<number> {
  // NULL-tenant (platform-global) audit rows are purged via audit.ts: there
  // is no tenant context for them, and the audit_events RLS policy
  // explicitly permits NULL-tenant rows without one. Tenant rows go through
  // tenantQuery so RLS applies.
  if (tenantId === null) return purgeGlobalAuditEvents(days, PURGE_BATCH_SIZE);
  let total = 0;
  for (;;) {
    const result = await tenantQuery(
      tenantId,
      `DELETE FROM audit_events
       WHERE id IN (
         SELECT id FROM audit_events
         WHERE tenant_id = $1
           AND legal_hold = false
           AND created_at < NOW() - ($2 || ' days')::interval
         LIMIT ${PURGE_BATCH_SIZE}
       )`,
      [tenantId, String(days)]
    );
    const deleted = result.rowCount ?? 0;
    total += deleted;
    if (deleted < PURGE_BATCH_SIZE) break;
  }
  return total;
}

/**
 * Purges one tenant's expired data and writes the RETENTION_PURGE audit
 * summary afterwards (see module docstring for why the ordering matters).
 */
export async function purgeTenant(tenantId: string): Promise<PurgeCounts> {
  const policy = await resolvePolicy(tenantId);
  const counts: PurgeCounts = { conversations: 0, messages: 0, auditEvents: 0 };
  // Messages before conversations: old messages in still-active
  // conversations go first; deleting a conversation cascades its rest.
  if (purgeEnabled(policy.messagesDays)) {
    counts.messages = await purgeMessages(tenantId, policy.messagesDays);
  }
  if (purgeEnabled(policy.conversationsDays)) {
    const convResult = await purgeConversations(tenantId, policy.conversationsDays);
    counts.conversations = convResult.conversations;
    counts.messages += convResult.messages;
  }
  if (purgeEnabled(policy.auditEventsDays)) {
    counts.auditEvents = await purgeAuditEvents(tenantId, policy.auditEventsDays);
  }
  await recordAudit({
    action: 'RETENTION_PURGE',
    classification: 'INTERNAL',
    tenantId,
    success: true,
    metadata: {
      counts,
      policy: {
        conversationsDays: policy.conversationsDays,
        messagesDays: policy.messagesDays,
        auditEventsDays: policy.auditEventsDays,
      },
    },
  });
  return counts;
}

export interface PurgeAllResult {
  tenants: number;
  counts: PurgeCounts;
  /** tenantIds that failed; their error is logged, the sweep continues. */
  failed: string[];
}

/** Sweeps every tenant, then platform-global (NULL-tenant) audit events. */
export async function purgeAllTenants(): Promise<PurgeAllResult> {
  const result: PurgeAllResult = {
    tenants: 0,
    counts: { conversations: 0, messages: 0, auditEvents: 0 },
    failed: [],
  };
  const tenants = (await query<{ id: string }>('SELECT id FROM tenants')).rows;
  for (const tenant of tenants) {
    try {
      const counts = await purgeTenant(tenant.id);
      result.tenants += 1;
      result.counts.conversations += counts.conversations;
      result.counts.messages += counts.messages;
      result.counts.auditEvents += counts.auditEvents;
    } catch (error) {
      result.failed.push(tenant.id);
      console.error(`Retention purge failed for tenant ${tenant.id}`, error);
    }
  }
  // Platform-global audit rows belong to no tenant; purge them against the
  // global default and audit the sweep itself without a tenant scope.
  if (purgeEnabled(config.RETENTION_AUDIT_EVENTS_DAYS)) {
    try {
      const globalDeleted = await purgeAuditEvents(null, config.RETENTION_AUDIT_EVENTS_DAYS);
      result.counts.auditEvents += globalDeleted;
    } catch (error) {
      console.error('Retention purge failed for platform-global audit events', error);
    }
  }
  await recordAudit({
    action: 'RETENTION_PURGE_SWEEP',
    classification: 'INTERNAL',
    success: result.failed.length === 0,
    metadata: {
      tenants: result.tenants,
      counts: result.counts,
      failedTenants: result.failed.length,
    },
  }).catch((error) => console.error('Failed to audit retention sweep', error));
  return result;
}
