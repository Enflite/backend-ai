/**
 * routes.ts — retention policy and legal-hold API (Phase 5c).
 *
 *   GET  /retention/policy                        → effective policy + overrides
 *   PUT  /retention/policy                        → upsert per-tenant overrides
 *   POST /retention/conversations/:id/legal-hold   → { hold: boolean }
 *   POST /retention/audit-events/:id/legal-hold   → { hold: boolean }
 *
 * All endpoints require the retention:manage permission (Admin, Security
 * Admin). Every change is audited; legal holds exempt records from the
 * scheduled purge (see retention/purge.ts).
 */

import { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { getDb, withTenantTx } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { recordAuditInTx, type AuditEventDoc } from '../audit/audit.js';
import { effectivePolicy, type RetentionPolicyRow } from './purge.js';

/** Document shape for the `retention_policies` collection. `_id` IS the tenantId (migration 005). */
interface RetentionPolicyDoc {
  _id: string;
  conversationsDays: number | null;
  messagesDays: number | null;
  auditEventsDays: number | null;
  updatedAt?: Date;
}

/** Document shape for the `conversations` collection (only the fields this module touches). */
interface ConversationDoc {
  _id: string;
  tenantId: string;
  legalHold: boolean;
}

const idSchema = z.object({ id: z.string().uuid() });
const holdSchema = z.object({ hold: z.boolean() }).strict();
const policySchema = z
  .object({
    conversationsDays: z.number().int().min(0).max(36500).nullable().optional(),
    messagesDays: z.number().int().min(0).max(36500).nullable().optional(),
    auditEventsDays: z.number().int().min(0).max(36500).nullable().optional(),
  })
  .strict();

function auditBase(req: FastifyRequest) {
  return { requestId: req.requestId, ip: req.ip, classification: 'INTERNAL' as const };
}

/**
 * Read the tenant's policy overrides. retention_policies._id IS the
 * tenantId (migration 005) — one document per tenant.
 */
async function readPolicyRow(tenantId: string): Promise<RetentionPolicyRow | null> {
  const db = await getDb();
  const doc = await db.collection<RetentionPolicyDoc>('retention_policies').findOne({ _id: tenantId });
  if (!doc) return null;
  return {
    conversationsDays: (doc.conversationsDays as number | null) ?? null,
    messagesDays: (doc.messagesDays as number | null) ?? null,
    auditEventsDays: (doc.auditEventsDays as number | null) ?? null,
  };
}

export async function retentionRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: [requireAuth, requirePermission('retention:manage')] };

  fastify.get('/retention/policy', guard, async (req) => {
    const auth = req.auth!;
    const row = await readPolicyRow(auth.tenantId);
    return { overrides: row ?? null, effective: effectivePolicy(row ?? undefined) };
  });

  fastify.put('/retention/policy', guard, async (req) => {
    const auth = req.auth!;
    const body = policySchema.parse(req.body);
    // The policy upsert and its audit row commit in ONE tenant transaction:
    // a fail-closed audit failure rolls the policy change back instead of
    // leaving it committed but unaudited.
    await withTenantTx(auth.tenantId, async (session, db, tenantId) => {
      await db.collection<RetentionPolicyDoc>('retention_policies').updateOne(
        { _id: tenantId },
        {
          $set: {
            conversationsDays: body.conversationsDays ?? null,
            messagesDays: body.messagesDays ?? null,
            auditEventsDays: body.auditEventsDays ?? null,
            updatedAt: new Date(),
          },
        },
        { upsert: true, session }
      );
      await recordAuditInTx(session, {
        ...auditBase(req),
        action: 'RETENTION_POLICY_UPDATED',
        tenantId: auth.tenantId,
        userId: auth.userId,
        success: true,
        metadata: { overrides: body },
      });
    });
    const row = await readPolicyRow(auth.tenantId);
    return { overrides: row ?? null, effective: effectivePolicy(row ?? undefined) };
  });

  fastify.post('/retention/conversations/:id/legal-hold', guard, async (req) => {
    const auth = req.auth!;
    const { id } = idSchema.parse(req.params);
    const { hold } = holdSchema.parse(req.body);
    // Hold update and its audit row commit in ONE tenant transaction so a
    // fail-closed audit failure rolls the hold back instead of leaving it
    // committed but unaudited.
    const updatedId = await withTenantTx(auth.tenantId, async (session, db, tenantId) => {
      const updated = await db.collection<ConversationDoc>('conversations').findOneAndUpdate(
        { _id: id, tenantId },
        { $set: { legalHold: hold } },
        { session, returnDocument: 'after', projection: { _id: 1 } }
      );
      if (!updated) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      await recordAuditInTx(session, {
        ...auditBase(req),
        action: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_CLEARED',
        resource: 'conversation',
        resourceId: id,
        tenantId: auth.tenantId,
        userId: auth.userId,
        success: true,
      });
      return String(updated._id);
    });
    return { id: updatedId, legalHold: hold };
  });

  fastify.post('/retention/audit-events/:id/legal-hold', guard, async (req) => {
    const auth = req.auth!;
    const { id } = idSchema.parse(req.params);
    const { hold } = holdSchema.parse(req.body);
    // Audit rows may be tenant-scoped or platform-global (tenantId null);
    // retention managers act within their own tenant scope. The hold update
    // and its audit row commit in ONE tenant transaction (see above).
    await withTenantTx(auth.tenantId, async (session, db, tenantId) => {
      const updated = await db.collection<AuditEventDoc>('audit_events').findOneAndUpdate(
        { _id: id, tenantId },
        { $set: { legalHold: hold } },
        { session, returnDocument: 'after', projection: { _id: 1 } }
      );
      if (!updated) throw Errors.notFound('AUDIT_EVENT_NOT_FOUND', 'Audit event not found');
      await recordAuditInTx(session, {
        ...auditBase(req),
        action: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_CLEARED',
        resource: 'audit_event',
        resourceId: id,
        tenantId: auth.tenantId,
        userId: auth.userId,
        success: true,
      });
    });
    return { id, legalHold: hold };
  });
}
