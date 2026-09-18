import { describe, expect, it, vi, beforeEach } from 'vitest';

const { queryMock } = vi.hoisted(() => ({ queryMock: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ query: queryMock, tenantQuery: vi.fn() }));

import { purgeGlobalAuditEvents, sanitizeReason } from '../src/audit/audit.js';

beforeEach(() => {
  queryMock.mockReset();
});

describe('audit reason sanitization', () => {
  it('redacts credential-shaped fragments', () => {
    expect(sanitizeReason('login failed: password=supersecret123')).toBe('login failed: password=[REDACTED]');
    expect(sanitizeReason('saw header Bearer abc.def.ghi')).toBe('saw header Bearer=[REDACTED]');
    expect(sanitizeReason('api_key: xyz789')).toBe('api_key=[REDACTED]');
  });

  it('redacts quoted keys and fully-quoted values', () => {
    expect(sanitizeReason('upstream said {"password":"supersecret"}')).toBe(
      'upstream said {password=[REDACTED]}'
    );
    expect(sanitizeReason("config had password='correct horse' set")).toBe(
      'config had password=[REDACTED] set'
    );
    expect(sanitizeReason('token: "abc 123" rejected')).toBe('token=[REDACTED] rejected');
  });

  it('strips URL userinfo', () => {
    expect(sanitizeReason('fetch https://admin:s3cret@internal:8080/x failed')).toBe(
      'fetch https://[REDACTED]@internal:8080/x failed'
    );
  });

  it('bounds reason length', () => {
    expect(sanitizeReason('x'.repeat(600))).toHaveLength(500);
  });

  it('passes through null and benign text', () => {
    expect(sanitizeReason(null)).toBeNull();
    expect(sanitizeReason(undefined)).toBeNull();
    expect(sanitizeReason('DOCUMENT_INGESTION_FAILED')).toBe('DOCUMENT_INGESTION_FAILED');
  });
});

describe('purgeGlobalAuditEvents', () => {
  it('deletes only NULL-tenant rows past the cutoff, honoring legal hold, in batches', async () => {
    queryMock
      .mockResolvedValueOnce({ rowCount: 3 })
      .mockResolvedValueOnce({ rowCount: 1 });
    const total = await purgeGlobalAuditEvents(90, 3);
    expect(total).toBe(4);
    expect(queryMock).toHaveBeenCalledTimes(2);
    for (const [sql, params] of queryMock.mock.calls as Array<[string, unknown[]]>) {
      expect(sql).toContain('DELETE FROM audit_events');
      expect(sql).toContain('tenant_id IS NULL');
      expect(sql).toContain('legal_hold = false');
      // Tenant-scoped rows are never touched by the global purge.
      expect(sql).not.toMatch(/tenant_id = \$\d/);
      expect(params).toEqual(['90']);
    }
  });

  it('stops when a batch comes back short', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 2 });
    const total = await purgeGlobalAuditEvents(30, 1000);
    expect(total).toBe(2);
    expect(queryMock).toHaveBeenCalledTimes(1);
  });
});
