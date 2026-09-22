import { describe, expect, it, vi, beforeEach } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));

import { purgeGlobalAuditEvents, sanitizeReason } from '../src/audit/audit.js';

// Helper: mock cursor chain for find().project().limit().toArray()
function mockBatch(docs: Array<{ _id: string }>) {
  return {
    project: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    toArray: vi.fn().mockResolvedValue(docs),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
    const findMock = vi.fn();
    const deleteManyMock = vi.fn();
    // First batch: 3 docs, second batch: 1 doc (short batch stops the loop)
    findMock
      .mockReturnValueOnce(mockBatch([{ _id: 'a1' }, { _id: 'a2' }, { _id: 'a3' }]))
      .mockReturnValueOnce(mockBatch([{ _id: 'a4' }]));
    deleteManyMock
      .mockResolvedValueOnce({ deletedCount: 3 })
      .mockResolvedValueOnce({ deletedCount: 1 });
    getDbMock.mockResolvedValue({
      collection: vi.fn().mockReturnValue({ find: findMock, deleteMany: deleteManyMock }),
    });

    const total = await purgeGlobalAuditEvents(90, 3);
    expect(total).toBe(4);
    expect(findMock).toHaveBeenCalledTimes(2);
    expect(deleteManyMock).toHaveBeenCalledTimes(2);
    for (const call of findMock.mock.calls) {
      const filter = call[0] as Record<string, unknown>;
      // Only NULL-tenant rows, never tenant-scoped rows
      expect(filter.tenantId).toBeNull();
      expect(filter.legalHold).toBe(false);
      expect(filter.createdAt).toMatchObject({ $lt: expect.any(Date) });
    }
    for (const call of deleteManyMock.mock.calls) {
      const filter = call[0] as Record<string, unknown>;
      expect(filter.tenantId).toBeNull();
      expect(filter._id).toMatchObject({ $in: expect.any(Array) });
    }
  });

  it('stops when a batch comes back short', async () => {
    const findMock = vi.fn().mockReturnValueOnce(mockBatch([{ _id: 'a1' }, { _id: 'a2' }]));
    const deleteManyMock = vi.fn().mockResolvedValueOnce({ deletedCount: 2 });
    getDbMock.mockResolvedValue({
      collection: vi.fn().mockReturnValue({ find: findMock, deleteMany: deleteManyMock }),
    });

    const total = await purgeGlobalAuditEvents(30, 1000);
    expect(total).toBe(2);
    expect(findMock).toHaveBeenCalledTimes(1);
    expect(deleteManyMock).toHaveBeenCalledTimes(1);
  });

  it('stops when a batch comes back empty', async () => {
    const findMock = vi.fn().mockReturnValueOnce(mockBatch([]));
    const deleteManyMock = vi.fn();
    getDbMock.mockResolvedValue({
      collection: vi.fn().mockReturnValue({ find: findMock, deleteMany: deleteManyMock }),
    });

    const total = await purgeGlobalAuditEvents(30, 1000);
    expect(total).toBe(0);
    expect(findMock).toHaveBeenCalledTimes(1);
    expect(deleteManyMock).not.toHaveBeenCalled();
  });
});
