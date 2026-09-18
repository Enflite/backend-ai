import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));

import { AuditPersistenceError, recordAudit } from '../src/audit/audit.js';
import { config } from '../src/config.js';

const DB_DOWN = new Error('connect ECONNREFUSED 127.0.0.1:5432');

beforeEach(() => {
  vi.clearAllMocks();
  config.AUDIT_FAIL_CLOSED = false;
  tenantQuery.mockRejectedValue(DB_DOWN);
  query.mockRejectedValue(DB_DOWN);
});

describe('recordAudit failure mode', () => {
  it('fails open by default outside production: swallows the DB error and resolves', async () => {
    config.AUDIT_FAIL_CLOSED = false;
    await expect(
      recordAudit({ tenantId: 't1', userId: 'u1', action: 'DOCUMENT_ACCESS', resourceId: 'd1' })
    ).resolves.toBeUndefined();
  });

  it('fails closed when enabled: throws a dedicated 503 error', async () => {
    config.AUDIT_FAIL_CLOSED = true;
    const error = await recordAudit({
      tenantId: 't1', userId: 'u1', action: 'DOCUMENT_ACCESS', resourceId: 'd1',
    }).catch((err) => err);
    expect(error).toBeInstanceOf(AuditPersistenceError);
    expect(error.statusCode).toBe(503);
    expect(error.code).toBe('AUDIT_PERSISTENCE_FAILED');
  });

  it('never exposes secrets in the fail-closed error surface', async () => {
    config.AUDIT_FAIL_CLOSED = true;
    const error = await recordAudit({
      tenantId: 't1', userId: 'u1', action: 'LOGIN',
      metadata: { token: 'super-secret-token-value', password: 'hunter2' },
    }).catch((err) => err);
    const rendered = JSON.stringify(error);
    expect(rendered).not.toContain('super-secret-token-value');
    expect(rendered).not.toContain('hunter2');
    expect(rendered).not.toContain('ECONNREFUSED');
    expect(error.details).toBeUndefined();
  });

  it('still writes the audit event when the database is healthy', async () => {
    config.AUDIT_FAIL_CLOSED = true;
    tenantQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(
      recordAudit({ tenantId: 't1', userId: 'u1', action: 'LOGIN' })
    ).resolves.toBeUndefined();
    expect(tenantQuery).toHaveBeenCalledTimes(1);
  });

  it('sanitizes credential-shaped metadata before the insert', async () => {
    config.AUDIT_FAIL_CLOSED = false;
    tenantQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await recordAudit({
      tenantId: 't1', userId: 'u1', action: 'LOGIN',
      metadata: { token: 'abc123', nested: { password: 'hunter2' }, benign: 'ok' },
    });
    const params = tenantQuery.mock.calls[0]![2] as unknown[];
    const stored = JSON.parse(params[12] as string) as Record<string, unknown>;
    expect(stored).toMatchObject({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]' },
      benign: 'ok',
    });
  });
});
