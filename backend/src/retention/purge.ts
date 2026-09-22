/**
 * purge.ts — retention purge job (Phase 5c).
 *
 * Deletes expired conversations, messages, and audit events per the
 * effective retention policy (per-tenant `retention_policies` overrides,
 * falling back to the global RETENTION_*_DAYS config). NULL/0 disables
 * purging for that table.
 *
 * Legal holds exempt records: conversations with legalHold (and all of
 * their messages, via the conversation lookup) and audit events with
 * legalHold are never deleted.
 *
 * Audit reconciliation: audit is append-only by convention, but legal
 * retention requires old audit rows to be deletable. Every purge writes a
 * RETENTION_PURGE summary event *after* deleting (counts per table, the
 * effective policy, the cutoff window — no sensitive content). The summary
 * row is new, so it survives its own retention window, and it is the
 * durable non-sensitive record of what was deleted and why.
 */

import { config } from '../config.js';
import { getDb, withTenantTx } from '../db/mongo.js';
import { Filter } from 'mongodb';
import { purgeGlobalAuditEvents, recordAudit, type AuditEventDoc } from '../audit/audit.js';

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

/** Test seam: policy document shape in the retention_policies collection. */
export interface RetentionPolicyRow {
  conversationsDays: number | null;
  messagesDays: number | null;
  auditEventsDays: number | null;
}

/** Document shape for the `retention_policies` collection. `_id` IS the tenantId (migration 005). */
interface RetentionPolicyDoc {
  _id: string;
  conversationsDays: number | null;
  messagesDays: number | null;
  auditEventsDays: number | null;
  updatedAt?: Date;
}

/** Document shape for the `messages` collection (only the fields this module reads). */
interface MessageDoc {
  _id: string;
  tenantId: string;
  conversationId: string;
  createdAt: Date;
}

/** Document shape for the `conversations` collection (only the fields this module reads). */
interface ConversationDoc {
  _id: string;
  tenantId: string;
  legalHold: boolean;
  updatedAt: Date;
}

/** Document shape for the `tenants` collection (only the fields this module reads). */
interface TenantDoc {
  _id: string;
}

export function effectivePolicy(row: RetentionPolicyRow | undefined): RetentionPolicy {
  return {
    conversationsDays: row?.conversationsDays ?? config.RETENTION_CONVERSATIONS_DAYS,
    messagesDays: row?.messagesDays ?? config.RETENTION_MESSAGES_DAYS,
    auditEventsDays: row?.auditEventsDays ?? config.RETENTION_AUDIT_EVENTS_DAYS,
  };
}

export async function resolvePolicy(tenantId: string): Promise<RetentionPolicy> {
  // retention_policies._id IS the tenantId (migration 005).
  const db = await getDb();
  const doc = await db.collection<RetentionPolicyDoc>('retention_policies').findOne({ _id: tenantId });
  const row = doc as unknown as RetentionPolicyRow | null;
  return effectivePolicy(row ?? undefined);
}

async function purgeMessages(tenantId: string, days: number): Promise<number> {
  const db = await getDb();
  const messages = db.collection<MessageDoc>('messages');
  const conversations = db.collection<ConversationDoc>('conversations');
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  // _id-ordered pagination (UUID strings order lexicographically): every
  // batch advances, so legal-hold-skipped messages can never pin the loop.
  let lastId: string | null = null;
  for (;;) {
    const filter: Filter<MessageDoc> = { tenantId, createdAt: { $lt: cutoff } };
    if (lastId !== null) filter._id = { $gt: lastId };
    const batch = await messages
      .find(filter)
      .sort({ _id: 1 })
      .project({ _id: 1, conversationId: 1 })
      .limit(PURGE_BATCH_SIZE)
      .toArray();
    if (batch.length === 0) break;
    lastId = String(batch[batch.length - 1]!._id);
    // Legal-hold join: messages in held conversations are never deleted.
    const conversationIds = [...new Set(batch.map((message) => message.conversationId))];
    const holdFree = await conversations
      .find({ tenantId, _id: { $in: conversationIds }, legalHold: false })
      .project({ _id: 1 })
      .toArray();
    const holdFreeIds = new Set(holdFree.map((conversation) => String(conversation._id)));
    const deletableIds = batch
      .filter((message) => holdFreeIds.has(String(message.conversationId)))
      .map((message) => message._id);
    if (deletableIds.length > 0) {
      const result = await messages.deleteMany({ tenantId, _id: { $in: deletableIds } });
      total += result.deletedCount ?? 0;
    }
  }
  return total;
}

async function purgeConversations(
  tenantId: string,
  days: number
): Promise<{ conversations: number; messages: number }> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let conversations = 0;
  let messages = 0;
  for (;;) {
    const batch = await db
      .collection<ConversationDoc>('conversations')
      .find({ tenantId, legalHold: false, updatedAt: { $lt: cutoff } })
      .project({ _id: 1 })
      .limit(PURGE_BATCH_SIZE)
      .toArray();
    if (batch.length === 0) break;
    const ids = batch.map((doc) => doc._id);
    // Messages are deleted explicitly (not left to a cascade) so the
    // audit summary counts every deleted record. Both deletes run in one
    // multi-document transaction.
    const deleted = await withTenantTx(tenantId, async (session, txDb) => {
      const messagesResult = await txDb
        .collection<MessageDoc>('messages')
        .deleteMany({ tenantId, conversationId: { $in: ids } }, { session });
      const conversationsResult = await txDb
        .collection<ConversationDoc>('conversations')
        .deleteMany({ tenantId, _id: { $in: ids } }, { session });
      return {
        messages: messagesResult.deletedCount ?? 0,
        conversations: conversationsResult.deletedCount ?? 0,
      };
    });
    conversations += deleted.conversations;
    messages += deleted.messages;
    if (batch.length < PURGE_BATCH_SIZE) break;
  }
  return { conversations, messages };
}

async function purgeAuditEvents(tenantId: string | null, days: number): Promise<number> {
  // NULL-tenant (platform-global) audit rows are purged via audit.ts: there
  // is no tenant context for them, and the filter there pins tenantId null
  // explicitly. Tenant rows always filter by the tenant's tenantId.
  if (tenantId === null) return purgeGlobalAuditEvents(days, PURGE_BATCH_SIZE);
  const db = await getDb();
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let total = 0;
  for (;;) {
    const batch = await db
      .collection<AuditEventDoc>('audit_events')
      .find({ tenantId, legalHold: false, createdAt: { $lt: cutoff } })
      .project({ _id: 1 })
      .limit(PURGE_BATCH_SIZE)
      .toArray();
    if (batch.length === 0) break;
    const result = await db
      .collection<AuditEventDoc>('audit_events')
      .deleteMany({ tenantId, _id: { $in: batch.map((doc) => doc._id) } });
    total += result.deletedCount ?? 0;
    if (batch.length < PURGE_BATCH_SIZE) break;
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
  // conversations go first; deleting a conversation removes its rest.
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
  /**
   * Set when purging the platform-global (NULL-tenant) audit log failed.
   * Unlike tenant failures (which abort that tenant's sweep), this can only
   * be discovered after the sweep, so it is surfaced here — and in the
   * sweep's audit record — instead of being swallowed into a log line.
   */
  globalAuditPurgeError: string | null;
}

/** Sweeps every tenant, then platform-global (NULL-tenant) audit events. */
export async function purgeAllTenants(): Promise<PurgeAllResult> {
  const result: PurgeAllResult = {
    tenants: 0,
    counts: { conversations: 0, messages: 0, auditEvents: 0 },
    failed: [],
    globalAuditPurgeError: null,
  };
  const db = await getDb();
  const tenants = await db.collection<TenantDoc>('tenants').find({}).project({ _id: 1 }).toArray();
  for (const tenant of tenants) {
    const tenantId = String(tenant._id);
    try {
      const counts = await purgeTenant(tenantId);
      result.tenants += 1;
      result.counts.conversations += counts.conversations;
      result.counts.messages += counts.messages;
      result.counts.auditEvents += counts.auditEvents;
    } catch (error) {
      result.failed.push(tenantId);
      console.error(`Retention purge failed for tenant ${tenantId}`, error);
    }
  }
  // Platform-global audit rows belong to no tenant; purge them against the
  // global default and audit the sweep itself without a tenant scope.
  // A failure here is surfaced on the result (and in the sweep audit
  // below), not just logged: a silently skipped global audit purge would
  // leave expired audit rows behind with a "successful" sweep on record.
  if (purgeEnabled(config.RETENTION_AUDIT_EVENTS_DAYS)) {
    try {
      const globalDeleted = await purgeAuditEvents(null, config.RETENTION_AUDIT_EVENTS_DAYS);
      result.counts.auditEvents += globalDeleted;
    } catch (error) {
      result.globalAuditPurgeError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      console.error('Retention purge failed for platform-global audit events', error);
    }
  }
  await recordAudit({
    action: 'RETENTION_PURGE_SWEEP',
    classification: 'INTERNAL',
    success: result.failed.length === 0 && result.globalAuditPurgeError === null,
    metadata: {
      tenants: result.tenants,
      counts: result.counts,
      failedTenants: result.failed.length,
      globalAuditPurgeError: result.globalAuditPurgeError,
    },
  }).catch((error) => console.error('Failed to audit retention sweep', error));
  return result;
}
