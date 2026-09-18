/**
 * retentionRoutes.test.ts — retention policy and legal-hold API (Phase 5c).
 *
 * Covers authorization (retention:manage), tenant scoping, policy
 * get/update, legal-hold set/clear on conversations and audit events,
 * 404s, and the audit trail. The real requirePermission middleware is
 * used; only requireAuth (session) and the DB are mocked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { tenantQuery, withTenantTx } = vi.hoisted(() => ({
  tenantQuery: vi.fn(),
  withTenantTx: vi.fn(),
}));
const { recordAudit, recordAuditInTx } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  recordAuditInTx: vi.fn(),
}));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-1',
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'admin@example.test',
    displayName: 'Admin',
    roleName: 'Admin',
    clearance: 'INTERNAL',
    permissions: ['retention:manage'],
  } as Record<string, unknown>,
}));

vi.mock('../src/db/pool.js', () => ({ tenantQuery, withTenantTx }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit, recordAuditInTx }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));

import { AppError } from '../src/errors.js';
import { retentionRoutes } from '../src/retention/routes.js';

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(retentionRoutes);
  return app;
}

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const AUDIT_ID = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  vi.clearAllMocks();
  (currentAuth as Record<string, unknown>).permissions = ['retention:manage'];
  (currentAuth as Record<string, unknown>).tenantId = 'tenant-1';
  tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
    const text = String(sql);
    if (text.includes('FROM retention_policies')) return { rows: [] };
    if (text.includes('UPDATE conversations SET legal_hold')) return { rows: [{ id: CONV_ID }] };
    if (text.includes('UPDATE audit_events SET legal_hold')) return { rows: [{ id: AUDIT_ID }] };
    return { rows: [] };
  });
  // Default transaction mock: runs the callback on a fake client whose
  // queries delegate to tenantQuery, mirroring withTenantTx's real
  // contract (one client, one transaction).
  withTenantTx.mockImplementation(async (tenant: string, callback: (client: any) => Promise<any>) => {
    const client = { query: (sql: string, params?: unknown[]) => tenantQuery(tenant, sql, params) };
    return callback(client);
  });
  recordAudit.mockResolvedValue(undefined);
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('retention routes', () => {
  it('GET /retention/policy returns overrides and the effective policy, tenant-scoped', async () => {
    tenantQuery.mockImplementation(async (tenant: string, sql: string) => {
      if (String(sql).includes('FROM retention_policies')) {
        expect(tenant).toBe('tenant-1');
        return { rows: [{ conversations_days: 30, messages_days: null, audit_events_days: 0 }] };
      }
      return { rows: [] };
    });
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/retention/policy' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { overrides: unknown; effective: Record<string, number | null> };
    expect(body.overrides).toMatchObject({ conversations_days: 30 });
    // NULL override falls back to the global default; 0 stays disabled.
    expect(body.effective.conversationsDays).toBe(30);
    expect(body.effective.auditEventsDays).toBe(0);
    await app.close();
  });

  it('PUT /retention/policy upserts overrides and audits the change', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/retention/policy',
      payload: { conversationsDays: 90, messagesDays: null, auditEventsDays: 0 },
    });
    expect(res.statusCode).toBe(200);
    const upsert = tenantQuery.mock.calls.find((call) => String(call[1]).includes('INSERT INTO retention_policies'));
    expect(upsert).toBeDefined();
    expect(upsert![0]).toBe('tenant-1');
    expect(upsert![2]).toEqual(['tenant-1', 90, null, 0]);
    expect(recordAuditInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'RETENTION_POLICY_UPDATED',
      tenantId: 'tenant-1',
      userId: 'user-1',
      success: true,
    }));
    await app.close();
  });

  it('POST legal-hold sets and clears a conversation hold with audits', async () => {
    const app = await buildApp();
    const setRes = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json()).toEqual({ id: CONV_ID, legalHold: true });
    const update = tenantQuery.mock.calls.find((call) => String(call[1]).includes('UPDATE conversations SET legal_hold'));
    expect(update![2]).toEqual([true, CONV_ID, 'tenant-1']);
    expect(recordAuditInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'LEGAL_HOLD_SET',
      resource: 'conversation',
      resourceId: CONV_ID,
    }));

    const clearRes = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: false },
    });
    expect(clearRes.json()).toEqual({ id: CONV_ID, legalHold: false });
    expect(recordAuditInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'LEGAL_HOLD_CLEARED' }));
    await app.close();
  });

  it('POST legal-hold on audit events is tenant-scoped and audited', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/audit-events/${AUDIT_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: AUDIT_ID, legalHold: true });
    const update = tenantQuery.mock.calls.find((call) => String(call[1]).includes('UPDATE audit_events SET legal_hold'));
    expect(update![2]).toEqual([true, AUDIT_ID, 'tenant-1']);
    expect(recordAuditInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'LEGAL_HOLD_SET',
      resource: 'audit_event',
      resourceId: AUDIT_ID,
    }));
    await app.close();
  });

  it('legal-hold on a missing conversation returns 404', async () => {
    tenantQuery.mockImplementation(async () => ({ rows: [] }));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CONVERSATION_NOT_FOUND');
    await app.close();
  });

  it('requires the retention:manage permission on every endpoint', async () => {
    (currentAuth as Record<string, unknown>).permissions = ['chat:create'];
    const app = await buildApp();
    for (const [method, url, payload] of [
      ['GET', '/retention/policy', undefined],
      ['PUT', '/retention/policy', { conversationsDays: 10 }],
      ['POST', `/retention/conversations/${CONV_ID}/legal-hold`, { hold: true }],
      ['POST', `/retention/audit-events/${AUDIT_ID}/legal-hold`, { hold: true }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
    }
    expect(tenantQuery).not.toHaveBeenCalled();
    await app.close();
  });

  it('writes the legal-hold update and its audit row on the same transaction client', async () => {
    let updateClient: unknown;
    let auditClient: unknown;
    withTenantTx.mockImplementationOnce(async (_tenant: string, callback: (client: any) => Promise<any>) => {
      const client = {
        query: async (sql: string, params?: unknown[]) => {
          if (String(sql).includes('UPDATE conversations SET legal_hold')) {
            updateClient = client;
            return { rows: [{ id: CONV_ID }] };
          }
          return tenantQuery(_tenant, sql, params);
        },
      };
      return callback(client);
    });
    recordAuditInTx.mockImplementationOnce(async (client: unknown) => {
      auditClient = client;
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(200);
    // Same client for the mutation and the audit write: they commit or roll
    // back together, never one without the other.
    expect(updateClient).toBeDefined();
    expect(auditClient).toBe(updateClient);
    await app.close();
  });

  it('aborts the policy upsert transaction when the in-transaction audit write fails', async () => {
    const statements: string[] = [];
    let committed = false;
    let rolledBack = false;
    // Mirrors the real withTenantTx contract: a throw inside the callback
    // rolls the transaction back instead of committing it.
    withTenantTx.mockImplementationOnce(async (_tenant: string, callback: (client: any) => Promise<any>) => {
      const client = {
        query: async (sql: string) => {
          statements.push(String(sql));
          return { rows: [] };
        },
      };
      try {
        const result = await callback(client);
        committed = true;
        return result;
      } catch (error) {
        rolledBack = true;
        throw error;
      }
    });
    recordAuditInTx.mockRejectedValueOnce(new Error('audit store down'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/retention/policy',
      payload: { conversationsDays: 90 },
    });
    // The audit failure propagates instead of being swallowed after commit.
    expect(res.statusCode).toBe(500);
    expect(statements.some((s) => s.includes('INSERT INTO retention_policies'))).toBe(true);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'RETENTION_POLICY_UPDATED' })
    );
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
    await app.close();
  });
});
