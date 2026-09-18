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
import { tenantQuery, withTenantTx } from '../db/pool.js';
import { Errors } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { recordAuditInTx } from '../audit/audit.js';
import { effectivePolicy, type RetentionPolicyRow } from './purge.js';

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

export async function retentionRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: [requireAuth, requirePermission('retention:manage')] };

  fastify.get('/retention/policy', guard, async (req) => {
    const auth = req.auth!;
    const row = (
      await tenantQuery<RetentionPolicyRow>(
        auth.tenantId,
        'SELECT conversations_days, messages_days, audit_events_days FROM retention_policies WHERE tenant_id = $1',
        [auth.tenantId]
      )
    ).rows[0];
    return { overrides: row ?? null, effective: effectivePolicy(row) };
  });

  fastify.put('/retention/policy', guard, async (req) => {
    const auth = req.auth!;
    const body = policySchema.parse(req.body);
    // The policy upsert and its audit row commit in ONE tenant transaction:
    // a fail-closed audit failure rolls the policy change back instead of
    // leaving it committed but unaudited.
    await withTenantTx(auth.tenantId, async (client) => {
      await client.query(
        `INSERT INTO retention_policies (tenant_id, conversations_days, messages_days, audit_events_days, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (tenant_id) DO UPDATE SET
           conversations_days = EXCLUDED.conversations_days,
           messages_days = EXCLUDED.messages_days,
           audit_events_days = EXCLUDED.audit_events_days,
           updated_at = NOW()`,
        [auth.tenantId, body.conversationsDays ?? null, body.messagesDays ?? null, body.auditEventsDays ?? null]
      );
      await recordAuditInTx(client, {
        ...auditBase(req),
        action: 'RETENTION_POLICY_UPDATED',
        tenantId: auth.tenantId,
        userId: auth.userId,
        success: true,
        metadata: { overrides: body },
      });
    });
    const row = (
      await tenantQuery<RetentionPolicyRow>(
        auth.tenantId,
        'SELECT conversations_days, messages_days, audit_events_days FROM retention_policies WHERE tenant_id = $1',
        [auth.tenantId]
      )
    ).rows[0];
    return { overrides: row ?? null, effective: effectivePolicy(row) };
  });

  fastify.post('/retention/conversations/:id/legal-hold', guard, async (req) => {
    const auth = req.auth!;
    const { id } = idSchema.parse(req.params);
    const { hold } = holdSchema.parse(req.body);
    // Hold update and its audit row commit in ONE tenant transaction so a
    // fail-closed audit failure rolls the hold back instead of leaving it
    // committed but unaudited.
    const updated = await withTenantTx(auth.tenantId, async (client) => {
      const row = (
        await client.query<{ id: string }>(
          'UPDATE conversations SET legal_hold = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id',
          [hold, id, auth.tenantId]
        )
      ).rows[0];
      if (!row) throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
      await recordAuditInTx(client, {
        ...auditBase(req),
        action: hold ? 'LEGAL_HOLD_SET' : 'LEGAL_HOLD_CLEARED',
        resource: 'conversation',
        resourceId: id,
        tenantId: auth.tenantId,
        userId: auth.userId,
        success: true,
      });
      return row;
    });
    return { id: updated.id, legalHold: hold };
  });

  fastify.post('/retention/audit-events/:id/legal-hold', guard, async (req) => {
    const auth = req.auth!;
    const { id } = idSchema.parse(req.params);
    const { hold } = holdSchema.parse(req.body);
    // Audit rows may be tenant-scoped or platform-global (tenant_id NULL);
    // retention managers act within their own tenant scope. The hold update
    // and its audit row commit in ONE tenant transaction (see above).
    await withTenantTx(auth.tenantId, async (client) => {
      const row = (
        await client.query<{ id: string }>(
          'UPDATE audit_events SET legal_hold = $1 WHERE id = $2 AND tenant_id = $3 RETURNING id',
          [hold, id, auth.tenantId]
        )
      ).rows[0];
      if (!row) throw Errors.notFound('AUDIT_EVENT_NOT_FOUND', 'Audit event not found');
      await recordAuditInTx(client, {
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
