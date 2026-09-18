/**
 * retention.test.ts — retention purge unit tests (Phase 5c).
 *
 * Mocks the DB pool and the audit writer; asserts the purge SQL honors
 * legal holds, batches deletes, resolves per-tenant overrides, audits the
 * purge *after* deleting audit rows, and keeps sweeping when one tenant
 * fails. VALIDATED IN CI with mocks; real PostgreSQL behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { queryMock, tenantQueryMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  tenantQueryMock: vi.fn(),
}));
vi.mock('../src/db/pool.js', () => ({ query: queryMock, tenantQuery: tenantQueryMock }));

const { recordAuditMock, purgeGlobalAuditEventsMock } = vi.hoisted(() => ({
  recordAuditMock: vi.fn(),
  purgeGlobalAuditEventsMock: vi.fn(),
}));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  purgeGlobalAuditEvents: purgeGlobalAuditEventsMock,
}));

import {
  effectivePolicy,
  purgeAllTenants,
  purgeTenant,
  resolvePolicy,
} from '../src/retention/purge.js';
import { config } from '../src/config.js';

beforeEach(() => {
  queryMock.mockReset();
  tenantQueryMock.mockReset();
  recordAuditMock.mockReset();
  purgeGlobalAuditEventsMock.mockReset();
  recordAuditMock.mockResolvedValue(undefined);
  purgeGlobalAuditEventsMock.mockResolvedValue(0);
  // Default: no policy row, no expired rows.
  tenantQueryMock.mockResolvedValue({ rows: [], rowCount: 0 });
  queryMock.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('retention policy resolution', () => {
  it('falls back to global config when no tenant override exists', () => {
    const policy = effectivePolicy(undefined);
    expect(policy).toEqual({
      conversationsDays: config.RETENTION_CONVERSATIONS_DAYS,
      messagesDays: config.RETENTION_MESSAGES_DAYS,
      auditEventsDays: config.RETENTION_AUDIT_EVENTS_DAYS,
    });
  });

  it('prefers tenant overrides column by column', () => {
    const policy = effectivePolicy({ conversations_days: 30, messages_days: null, audit_events_days: 0 });
    expect(policy.conversationsDays).toBe(30);
    expect(policy.messagesDays).toBe(config.RETENTION_MESSAGES_DAYS);
    expect(policy.auditEventsDays).toBe(0);
  });

  it('reads the override row for the tenant', async () => {
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ conversations_days: 90, messages_days: null, audit_events_days: null }],
      rowCount: 1,
    });
    const policy = await resolvePolicy('tenant-1');
    expect(policy.conversationsDays).toBe(90);
    expect(tenantQueryMock).toHaveBeenCalledWith(
      'tenant-1',
      expect.stringContaining('FROM retention_policies'),
      ['tenant-1']
    );
  });
});

describe('purgeTenant', () => {
  it('deletes expired rows honoring legal holds, then audits the purge', async () => {
    // resolvePolicy → no row; messages → 2 deleted; conversations → 1
    // (with 0 cascade-deleted messages in the mock); audit → 3.
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 2 })
      .mockResolvedValueOnce({ rows: [{ conversations: '1', messages: '0' }], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 3 });
    const counts = await purgeTenant('tenant-1');

    expect(counts).toEqual({ conversations: 1, messages: 2, auditEvents: 3 });
    const statements = tenantQueryMock.mock.calls.map((call) => String(call[1]));
    // Messages purge joins conversations and skips legal holds.
    expect(statements[1]).toContain('c.legal_hold = false');
    // Conversations purge skips legal holds.
    expect(statements[2]).toContain('legal_hold = false');
    // Audit purge skips legal holds.
    expect(statements[3]).toContain('legal_hold = false');
    // The purge audit is written AFTER the deletes (it must survive them).
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RETENTION_PURGE', tenantId: 'tenant-1' })
    );
    const deleteOrder = tenantQueryMock.mock.invocationCallOrder;
    const auditOrder = recordAuditMock.mock.invocationCallOrder[0]!;
    for (const order of deleteOrder) expect(order).toBeLessThan(auditOrder);
    const summary = recordAuditMock.mock.calls[0]![0] as { metadata: { counts: unknown } };
    expect(summary.metadata.counts).toEqual({ conversations: 1, messages: 2, auditEvents: 3 });
  });

  it('loops in bounded batches until the table is drained', async () => {
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // policy
      .mockResolvedValueOnce({ rows: [], rowCount: 1000 }) // messages batch 1
      .mockResolvedValueOnce({ rows: [], rowCount: 1000 }) // messages batch 2
      .mockResolvedValueOnce({ rows: [], rowCount: 5 }) // messages batch 3 (done)
      .mockResolvedValueOnce({ rows: [{ conversations: '0', messages: '0' }], rowCount: 0 }) // conversations
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // audit
    const counts = await purgeTenant('tenant-1');
    expect(counts.messages).toBe(2005);
  });

  it('counts messages deleted with their conversations (no silent cascade)', async () => {
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // policy
      .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // messages (none expired)
      .mockResolvedValueOnce({ rows: [{ conversations: '2', messages: '7' }], rowCount: 1 }); // conversations + their messages
    const counts = await purgeTenant('tenant-1');
    expect(counts).toEqual({ conversations: 2, messages: 7, auditEvents: 0 });
  });

  it('skips tables whose retention is disabled (0 override, null global)', async () => {
    // NULL override column = fall back to global (conversations enabled via
    // global default); explicit 0 = disabled (messages); 30 = enabled (audit).
    tenantQueryMock.mockResolvedValueOnce({
      rows: [{ conversations_days: null, messages_days: 0, audit_events_days: 30 }],
      rowCount: 1,
    });
    tenantQueryMock
      .mockResolvedValueOnce({ rows: [{ conversations: '2', messages: '0' }], rowCount: 1 }) // conversations
      .mockResolvedValueOnce({ rows: [], rowCount: 4 }); // audit events
    const counts = await purgeTenant('tenant-1');
    expect(counts).toEqual({ conversations: 2, messages: 0, auditEvents: 4 });
    const statements = tenantQueryMock.mock.calls.map((call) => String(call[1]));
    expect(statements.some((s) => s.includes('DELETE FROM conversations'))).toBe(true);
    // The standalone messages purge (the join against conversations) is not
    // issued when disabled; the conversation CTE's explicit message delete is
    // part of the conversation purge, not the standalone one.
    expect(statements.some((s) => s.includes('JOIN conversations c'))).toBe(false);
    expect(statements.some((s) => s.includes('DELETE FROM audit_events'))).toBe(true);
  });

  it('a null global default disables purging for that table', async () => {
    const original = config.RETENTION_CONVERSATIONS_DAYS;
    (config as Record<string, unknown>).RETENTION_CONVERSATIONS_DAYS = null;
    try {
      tenantQueryMock.mockResolvedValueOnce({ rows: [], rowCount: 0 }); // no override row
      const counts = await purgeTenant('tenant-1');
      const statements = tenantQueryMock.mock.calls.map((call) => String(call[1]));
      expect(statements.some((s) => s.includes('DELETE FROM conversations'))).toBe(false);
      expect(counts.conversations).toBe(0);
    } finally {
      (config as Record<string, unknown>).RETENTION_CONVERSATIONS_DAYS = original;
    }
  });
});

describe('purgeAllTenants', () => {
  it('sweeps every tenant, purges global audit rows, and audits the sweep', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM tenants')) {
        return { rows: [{ id: 't1' }, { id: 't2' }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    // Global (NULL-tenant) audit rows are purged through audit.ts, which
    // owns the audit_events table's pre-auth paths.
    purgeGlobalAuditEventsMock.mockResolvedValue(7);
    const result = await purgeAllTenants();
    expect(result.tenants).toBe(2);
    expect(result.failed).toEqual([]);
    expect(purgeGlobalAuditEventsMock).toHaveBeenCalledWith(config.RETENTION_AUDIT_EVENTS_DAYS, 1000);
    expect(result.counts.auditEvents).toBe(7); // global rows included
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RETENTION_PURGE_SWEEP' })
    );
  });

  it('continues past a failed tenant and reports it', async () => {
    queryMock.mockImplementation(async (sql: string) => {
      if (String(sql).includes('FROM tenants')) {
        return { rows: [{ id: 't1' }, { id: 't2' }], rowCount: 2 };
      }
      return { rows: [], rowCount: 0 };
    });
    tenantQueryMock.mockImplementation(async (tenantId: string, sql: string) => {
      if (tenantId === 't1' && String(sql).includes('retention_policies')) {
        throw new Error('db exploded');
      }
      return { rows: [], rowCount: 0 };
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await purgeAllTenants();
      expect(result.tenants).toBe(1);
      expect(result.failed).toEqual(['t1']);
      expect(recordAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RETENTION_PURGE_SWEEP', success: false })
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
