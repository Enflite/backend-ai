import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { ingestDocument } = vi.hoisted(() => ({ ingestDocument: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
vi.mock('../src/documents/ingestion.js', () => ({ ingestDocument }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));

import { recoverIngestionJobs } from '../src/documents/queue.js';

describe('ingestion job recovery', () => {
  beforeEach(() => {
    query.mockReset();
    tenantQuery.mockReset();
    ingestDocument.mockReset();
    recordAudit.mockResolvedValue(undefined);
  });

  it('heals documents stuck in PENDING without an active job row', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT id FROM tenants')) return { rows: [{ id: 't1' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    tenantQuery.mockImplementation(async (_tenant: string, sql?: string) => {
      // Vitest teardown may invoke the implementation with no arguments; ignore.
      const text = sql ?? '';
      if (text.includes('WHERE status = \'PROCESSING\' AND locked_at')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM documents d')) {
        // One orphaned document stuck in PENDING with no active job.
        return { rows: [{ id: 'd1', owner_id: 'u1' }], rowCount: 1 };
      }
      if (text.includes('INSERT INTO document_ingestion_jobs')) return { rows: [{ id: 'job-1' }], rowCount: 1 };
      if (text.includes('FROM document_ingestion_jobs WHERE status = \'PENDING\'')) return { rows: [], rowCount: 0 };
      if (text.includes('SET status = \'PROCESSING\'')) return { rows: [{ id: 'job-1' }], rowCount: 1 };
      if (text.includes('SET status = \'SUCCEEDED\'')) return { rows: [], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    ingestDocument.mockResolvedValue('READY');

    await recoverIngestionJobs();
    // processJob is dispatched via setImmediate; let it run.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(ingestDocument.mock.calls[0]?.[0]).toBe('d1');
    expect(ingestDocument.mock.calls[0]?.[1]).toBe('t1');
    const completedAudit = recordAudit.mock.calls.find((call) => call[0].action === 'DOCUMENT_INGESTION_COMPLETED');
    expect(completedAudit).toBeTruthy();
  });

  it('reclaims crashed PROCESSING jobs back to PENDING', async () => {
    query.mockResolvedValue({ rows: [{ id: 't1' }], rowCount: 1 });
    tenantQuery.mockImplementation(async (_tenant: string, sql?: string) => {
      // Vitest teardown may invoke the implementation with no arguments; ignore.
      const text = sql ?? '';
      if (text.includes('WHERE status = \'PROCESSING\' AND locked_at')) return { rows: [], rowCount: 1 };
      if (text.includes('FROM documents d')) return { rows: [], rowCount: 0 };
      if (text.includes('FROM document_ingestion_jobs WHERE status = \'PENDING\'')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });

    await recoverIngestionJobs();
    const reclaim = tenantQuery.mock.calls.find(([, sql]: any[]) =>
      (sql as string).includes('WHERE status = \'PROCESSING\' AND locked_at')
    );
    expect(reclaim).toBeTruthy();
  });
});
