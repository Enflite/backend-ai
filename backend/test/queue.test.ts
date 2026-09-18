import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { ingestDocument } = vi.hoisted(() => ({ ingestDocument: vi.fn() }));
const { recordAudit, sanitizeReason } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  sanitizeReason: (reason: unknown) => reason,
}));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
// Keep the real IngestionCanceledError (thrown across the worker boundary) while
// stubbing the pipeline itself.
vi.mock('../src/documents/ingestion.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/documents/ingestion.js')>();
  return { ...actual, ingestDocument };
});
vi.mock('../src/audit/audit.js', () => ({ recordAudit, sanitizeReason }));

import { IngestionCanceledError } from '../src/documents/ingestion.js';
import {
  cancelIngestionJob,
  claimNextJob,
  computeRetryDelayMs,
  enqueueIngestion,
  isWorkerPoolRunning,
  recoverIngestionJobs,
  requeueIngestionJob,
  resetIngestionFairnessState,
  selectNextTenant,
  startIngestionWorkers,
  stopIngestionWorkers,
  sweepStaleIngestionWork,
} from '../src/documents/queue.js';

// ---------------------------------------------------------------------------
// In-memory fake for document_ingestion_jobs. Understands just enough of the
// worker's SQL to exercise enqueue/claim/execute/recover paths realistically.
// ---------------------------------------------------------------------------

interface FakeJob {
  id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId: string | null;
  idempotencyKey: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: number;
  cancelRequested: boolean;
  errorCode: string | null;
  createdAt: number;
}

const isActive = (status: string) => status === 'PENDING' || status === 'PROCESSING';

function createFakeDb() {
  const jobs = new Map<string, FakeJob>();
  const documentUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const orphans: Array<{ id: string; owner_id: string }> = [];
  const extraTenants: string[] = [];
  let seq = 0;
  let blindFastPathOnce = false;

  const seedJob = (overrides: Partial<FakeJob> & { id: string }): FakeJob => {
    const job: FakeJob = {
      documentId: `doc-${overrides.id}`,
      tenantId: 't1',
      requestedBy: 'u1',
      requestId: null,
      idempotencyKey: null,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: Date.now(),
      cancelRequested: false,
      errorCode: null,
      createdAt: Date.now() + seq++,
      ...overrides,
    };
    jobs.set(job.id, job);
    return job;
  };

  query.mockImplementation(async (sql?: string) => {
    // Vitest teardown may invoke the implementation with no arguments; ignore.
    const text = typeof sql === 'string' ? sql : '';
    if (text.includes('SELECT id FROM tenants')) {
      const ids = [...new Set([...jobs.values()].map((j) => j.tenantId).concat(extraTenants))];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 0 };
  });

  tenantQuery.mockImplementation(async (tenantId?: string, sql?: string, params?: unknown[]) => {
    const text = typeof sql === 'string' ? sql : '';
    const p = params ?? [];
    if (text.includes('INSERT INTO document_ingestion_jobs')) {
      const [id, documentId, , requestedBy, requestId, idempotencyKey] = p as [
        string, string, string, string, string | null, string | null,
      ];
      if ([...jobs.values()].some((j) => j.documentId === documentId && isActive(j.status))) {
        return { rows: [], rowCount: 0 }; // ON CONFLICT (document_id) DO NOTHING
      }
      if (
        idempotencyKey &&
        [...jobs.values()].some(
          (j) => j.tenantId === tenantId && j.idempotencyKey === idempotencyKey && isActive(j.status)
        )
      ) {
        const err = new Error(
          'duplicate key value violates unique constraint "idx_ingestion_jobs_idempotency"'
        ) as Error & { code: string };
        err.code = '23505';
        throw err;
      }
      const job: FakeJob = {
        id, documentId, tenantId: tenantId!, requestedBy, requestId: requestId ?? null, idempotencyKey,
        status: 'PENDING', attempts: 0, nextAttemptAt: Date.now(), cancelRequested: false,
        errorCode: null, createdAt: Date.now() + seq++,
      };
      jobs.set(id, job);
      return { rows: [{ id }], rowCount: 1 };
    }
    if (text.includes('FOR UPDATE SKIP LOCKED')) {
      const now = Date.now();
      const candidate = [...jobs.values()]
        .filter((j) => j.tenantId === tenantId && j.status === 'PENDING' && j.nextAttemptAt <= now)
        .sort((a, b) => a.createdAt - b.createdAt)[0];
      if (!candidate) return { rows: [], rowCount: 0 };
      candidate.status = 'PROCESSING';
      candidate.attempts += 1;
      return {
        rows: [{
          id: candidate.id, document_id: candidate.documentId, tenant_id: candidate.tenantId,
          requested_by: candidate.requestedBy, request_id: candidate.requestId, attempts: candidate.attempts,
        }],
        rowCount: 1,
      };
    }
    if (text.includes('SELECT cancel_requested')) {
      const job = jobs.get(p[0] as string);
      return job ? { rows: [{ cancel_requested: job.cancelRequested }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes('SELECT requested_by, status, document_id')) {
      const job = jobs.get(p[0] as string);
      return job
        ? { rows: [{ requested_by: job.requestedBy, status: job.status, document_id: job.documentId }], rowCount: 1 }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes('SELECT id FROM document_ingestion_jobs')) {
      if (text.includes('idempotency_key = $2')) {
        if (blindFastPathOnce) {
          blindFastPathOnce = false;
          return { rows: [], rowCount: 0 }; // simulate the race window
        }
        const found = [...jobs.values()]
          .filter((j) => j.tenantId === tenantId && j.idempotencyKey === (p[1] as string) && isActive(j.status))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (text.includes('document_id = $2')) {
        const key = p[2] as string | null;
        const found = [...jobs.values()]
          .filter((j) => j.tenantId === tenantId && isActive(j.status) &&
            (j.documentId === (p[1] as string) || (key != null && j.idempotencyKey === key)))
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return found ? { rows: [{ id: found.id }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      // Recovery seed: tenants with PENDING work.
      const anyPending = [...jobs.values()].some((j) => j.tenantId === tenantId && j.status === 'PENDING');
      return anyPending ? { rows: [{ id: 'seed' }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes("SET status = 'PENDING', locked_at = NULL")) {
      // Recovery: reclaim crashed PROCESSING jobs (lock timeout proves the worker is gone).
      let n = 0;
      for (const j of jobs.values()) {
        if (j.tenantId === tenantId && j.status === 'PROCESSING') {
          j.status = 'PENDING';
          j.nextAttemptAt = Date.now();
          n += 1;
        }
      }
      return { rows: [], rowCount: n };
    }
    if (text.includes('RETURNING id, document_id') && text.includes('attempts >=')) {
      // Recovery: quarantine poison jobs.
      const maxAttempts = p[0] as number;
      const poisoned = [...jobs.values()].filter(
        (j) => j.tenantId === tenantId && j.status === 'PENDING' && j.attempts >= maxAttempts
      );
      for (const j of poisoned) j.status = 'QUARANTINED';
      return {
        rows: poisoned.map((j) => ({
          id: j.id, document_id: j.documentId, requested_by: j.requestedBy,
          request_id: j.requestId, error_code: j.errorCode, attempts: j.attempts,
        })),
        rowCount: poisoned.length,
      };
    }
    if (text.includes('UPDATE document_ingestion_jobs')) {
      const job = jobs.get(p[0] as string);
      if (text.includes("SET status = 'SUCCEEDED'")) {
        if (job) job.status = 'SUCCEEDED';
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      if (text.includes("SET status = 'CANCELED'")) {
        if (text.includes('cancel_requested = FALSE')) {
          // markJobCanceled: unconditional — the worker owns this PROCESSING job.
          if (job) {
            job.status = 'CANCELED';
            job.cancelRequested = false;
            job.errorCode = p[1] as string;
          }
          return { rows: [], rowCount: job ? 1 : 0 };
        }
        // Route cancel: only a PENDING job flips to CANCELED.
        if (job && job.status === 'PENDING') {
          job.status = 'CANCELED';
          job.errorCode = p[1] as string;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("SET status = 'QUARANTINED'")) {
        if (job) {
          job.status = 'QUARANTINED';
          job.errorCode = p[1] as string;
        }
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      if (text.includes('next_attempt_at = $3')) {
        if (job) {
          job.status = 'PENDING';
          job.errorCode = p[1] as string;
          job.nextAttemptAt = Date.parse(p[2] as string);
        }
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      if (text.includes('SET cancel_requested = TRUE')) {
        if (job) job.cancelRequested = true;
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      if (text.includes('attempts = 0')) {
        // Admin requeue.
        if (job && (job.status === 'QUARANTINED' || job.status === 'FAILED')) {
          job.status = 'PENDING';
          job.attempts = 0;
          job.cancelRequested = false;
          job.errorCode = null;
          job.nextAttemptAt = Date.now();
          return { rows: [{ id: job.id, document_id: job.documentId }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (text.includes("error_code = 'POISON_MESSAGE'")) {
        if (job) job.errorCode = 'POISON_MESSAGE';
        return { rows: [], rowCount: job ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('UPDATE documents SET')) {
      documentUpdates.push({ sql: text, params: p });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM documents d')) {
      const batch = orphans.splice(0, p[1] as number);
      return { rows: batch, rowCount: batch.length };
    }
    throw new Error(`fakeDb: unexpected SQL: ${text.slice(0, 160)}`);
  });

  return {
    jobs,
    documentUpdates,
    orphans,
    extraTenants,
    seedJob,
    setCancelRequested: (id: string, value = true) => {
      const job = jobs.get(id);
      if (job) job.cancelRequested = value;
    },
    blindFastPathOnce: () => { blindFastPathOnce = true; },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function failureWithCode(code: string): Error {
  return Object.assign(new Error(`simulated ${code}`), { code });
}

beforeEach(async () => {
  await stopIngestionWorkers();
  query.mockReset();
  tenantQuery.mockReset();
  ingestDocument.mockReset();
  recordAudit.mockReset();
  recordAudit.mockResolvedValue(undefined);
  ingestDocument.mockResolvedValue('READY');
  resetIngestionFairnessState();
});

afterEach(async () => {
  await stopIngestionWorkers();
  resetIngestionFairnessState();
});

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

describe('computeRetryDelayMs', () => {
  it('grows exponentially with ±20% jitter and respects the cap', () => {
    // Deterministic midpoint (random() = 0.5 -> no jitter).
    expect(computeRetryDelayMs(1, () => 0.5)).toBe(30000);
    expect(computeRetryDelayMs(2, () => 0.5)).toBe(60000);
    expect(computeRetryDelayMs(3, () => 0.5)).toBe(120000);
    expect(computeRetryDelayMs(4, () => 0.5)).toBe(240000);
    // Jitter bounds: ±20% of the base delay.
    expect(computeRetryDelayMs(1, () => 0)).toBe(24000);
    expect(computeRetryDelayMs(1, () => 1)).toBe(36000);
    expect(computeRetryDelayMs(2, () => 0)).toBe(48000);
    // Cap at INGEST_RETRY_MAX_DELAY_MS (15min default).
    expect(computeRetryDelayMs(10, () => 1)).toBe(900000);
    expect(computeRetryDelayMs(100, () => 0.5)).toBe(900000);
  });

  it('never returns a negative delay', () => {
    expect(computeRetryDelayMs(0, () => 0)).toBeGreaterThanOrEqual(0);
  });
});

// ---------------------------------------------------------------------------
// Tenant fairness (pure selector)
// ---------------------------------------------------------------------------

describe('selectNextTenant', () => {
  it('returns null with no candidates and breaks ties deterministically', () => {
    expect(selectNextTenant([])).toBeNull();
    expect(selectNextTenant(['tenant-b', 'tenant-a'])).toBe('tenant-a');
  });
});

describe('claimNextJob', () => {
  it('returns null when no tenant has due work', async () => {
    createFakeDb();
    expect(await claimNextJob()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Enqueue: success path, idempotency, dedupe
// ---------------------------------------------------------------------------

describe('enqueueIngestion', () => {
  it('marks jobs SUCCEEDED and audits completion on the happy path', async () => {
    const db = createFakeDb();
    const jobId = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', requestId: 'r1' });
    await waitFor(() => db.jobs.get(jobId)?.status === 'SUCCEEDED');
    expect(ingestDocument).toHaveBeenCalledWith(
      'doc-1', 't1', undefined, expect.objectContaining({ shouldCancel: expect.any(Function) })
    );
    const started = recordAudit.mock.calls.find((call) => call[0].action === 'DOCUMENT_INGESTION_STARTED');
    expect(started?.[0]).toMatchObject({ tenantId: 't1', userId: 'u1', requestId: 'r1', resourceId: 'doc-1' });
    const completed = recordAudit.mock.calls.find((call) => call[0].action === 'DOCUMENT_INGESTION_COMPLETED');
    expect(completed?.[0]).toMatchObject({ resourceId: 'doc-1', success: true });
  });

  it('dedupes on (tenant_id, idempotency_key): same key returns the in-flight job', async () => {
    const db = createFakeDb();
    let release!: (value: 'READY') => void;
    ingestDocument.mockImplementation(() => new Promise<'READY'>((resolve) => { release = resolve; }));
    const first = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'key-1' });
    await waitFor(() => db.jobs.get(first)?.status === 'PROCESSING');
    const second = await enqueueIngestion({ documentId: 'doc-2', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'key-1' });
    expect(second).toBe(first);
    const inserts = tenantQuery.mock.calls.filter(([, sql]) =>
      (sql as string).includes('INSERT INTO document_ingestion_jobs')
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0]![2]).toContain('key-1');
    release('READY');
    await waitFor(() => db.jobs.get(first)?.status === 'SUCCEEDED');
  });

  it('returns the winning job when concurrent enqueues race on the idempotency key', async () => {
    const db = createFakeDb();
    let release!: (value: 'READY') => void;
    ingestDocument.mockImplementation(() => new Promise<'READY'>((resolve) => { release = resolve; }));
    const winner = await enqueueIngestion({ documentId: 'doc-w', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'k' });
    await waitFor(() => db.jobs.get(winner)?.status === 'PROCESSING');
    // Simulate the race window: the fast-path lookup misses, then the INSERT
    // hits the partial unique index (23505) because the winner committed first.
    db.blindFastPathOnce();
    const racer = await enqueueIngestion({ documentId: 'doc-r', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'k' });
    expect(racer).toBe(winner);
    expect(db.jobs.size).toBe(1);
    release('READY');
    await waitFor(() => db.jobs.get(winner)?.status === 'SUCCEEDED');
  });

  it('returns the active job for a document instead of duplicating it', async () => {
    const db = createFakeDb();
    let release!: (value: 'READY') => void;
    ingestDocument.mockImplementation(() => new Promise<'READY'>((resolve) => { release = resolve; }));
    const first = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    await waitFor(() => db.jobs.get(first)?.status === 'PROCESSING');
    const second = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    expect(second).toBe(first);
    expect(db.jobs.size).toBe(1);
    release('READY');
    await waitFor(() => db.jobs.get(first)?.status === 'SUCCEEDED');
  });

  it('scopes idempotency keys per tenant', async () => {
    const db = createFakeDb();
    const a = await enqueueIngestion({ documentId: 'doc-a', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'k' });
    const b = await enqueueIngestion({ documentId: 'doc-b', tenantId: 't2', requestedBy: 'u2', idempotencyKey: 'k' });
    expect(a).not.toBe(b);
    expect(db.jobs.size).toBe(2);
    await waitFor(() => [...db.jobs.values()].every((j) => j.status === 'SUCCEEDED'));
  });
});

// ---------------------------------------------------------------------------
// Retries and poison-job quarantine
// ---------------------------------------------------------------------------

describe('job failure handling', () => {
  it('requeues failed jobs to PENDING with backoff instead of failing immediately', async () => {
    const db = createFakeDb();
    ingestDocument.mockRejectedValue(failureWithCode('EMBEDDING_TIMEOUT'));
    const jobId = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    await waitFor(() => {
      const job = db.jobs.get(jobId);
      return job?.status === 'PENDING' && job.attempts === 1;
    });
    const job = db.jobs.get(jobId)!;
    expect(job.errorCode).toBe('EMBEDDING_TIMEOUT');
    expect(job.nextAttemptAt).toBeGreaterThan(Date.now());
    expect(job.nextAttemptAt).toBeLessThanOrEqual(Date.now() + 900000);
    const failed = recordAudit.mock.calls.find((call) => call[0].action === 'DOCUMENT_INGESTION_FAILED');
    expect(failed?.[0]).toMatchObject({ reason: 'EMBEDDING_TIMEOUT', success: false });
    expect(failed?.[0].metadata).toMatchObject({ attempts: 1, maxAttempts: 5 });
  });

  it('quarantines jobs that exhaust INGEST_MAX_ATTEMPTS, preserving the error code', async () => {
    const db = createFakeDb();
    ingestDocument.mockRejectedValue(failureWithCode('MALWARE_DETECTED'));
    const jobId = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    // The standalone dispatch runs on setImmediate (after microtasks), so this
    // bump deterministically lands before the claim increments attempts.
    db.jobs.get(jobId)!.attempts = 4;
    await waitFor(() => db.jobs.get(jobId)?.status === 'QUARANTINED');
    const job = db.jobs.get(jobId)!;
    expect(job.attempts).toBe(5);
    expect(job.errorCode).toBe('MALWARE_DETECTED');
    const quarantined = recordAudit.mock.calls.find(
      (call) => call[0].action === 'DOCUMENT_INGESTION_QUARANTINED'
    );
    expect(quarantined?.[0]).toMatchObject({
      reason: 'MALWARE_DETECTED', success: false, resourceId: 'doc-1',
    });
    expect(quarantined?.[0].metadata).toMatchObject({ attempts: 5, maxAttempts: 5 });
    expect(
      db.documentUpdates.some((u) => u.sql.includes("status = 'QUARANTINED'"))
    ).toBe(true);
  });

  it('does not start a job whose cancel was requested before execution', async () => {
    const db = createFakeDb();
    const jobId = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    db.setCancelRequested(jobId, true);
    await waitFor(() => db.jobs.get(jobId)?.status === 'CANCELED');
    expect(ingestDocument).not.toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_CANCELED', resourceId: 'doc-1' })
    );
  });
});

// ---------------------------------------------------------------------------
// Cancellation
// ---------------------------------------------------------------------------

describe('cancelIngestionJob', () => {
  it('cancels a PENDING job immediately with audit and document update', async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'u1', isAdmin: false });
    expect(result).toEqual({ status: 'canceled' });
    expect(db.jobs.get('job-1')!.status).toBe('CANCELED');
    expect(
      db.documentUpdates.some(
        (u) => u.sql.includes("status = 'FAILED'") && u.sql.includes("error_code = 'INGESTION_CANCELED'")
      )
    ).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_CANCELED', resourceId: 'doc-1', success: false })
    );
  });

  it('rejects cancel from a non-owner non-admin', async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    await expect(
      cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'intruder', isAdmin: false })
    ).rejects.toMatchObject({ code: 'JOB_CANCEL_FORBIDDEN' });
    expect(db.jobs.get('job-1')!.status).toBe('PENDING');
  });

  it("lets an admin cancel another user's job", async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'admin', isAdmin: true });
    expect(result).toEqual({ status: 'canceled' });
  });

  it('marks cancel-requested on a PROCESSING job for the worker to pick up', async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PROCESSING' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'u1', isAdmin: false });
    expect(result).toEqual({ status: 'cancel-requested' });
    expect(db.jobs.get('job-1')!.cancelRequested).toBe(true);
    expect(db.jobs.get('job-1')!.status).toBe('PROCESSING');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_CANCEL_REQUESTED', resourceId: 'doc-1' })
    );
  });

  it('reports already-terminal jobs without error', async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'SUCCEEDED' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'u1', isAdmin: false });
    expect(result).toEqual({ status: 'already-terminal', jobStatus: 'SUCCEEDED' });
  });

  it('404s on unknown jobs', async () => {
    createFakeDb();
    await expect(
      cancelIngestionJob({ jobId: 'nope', tenantId: 't1', userId: 'u1', isAdmin: false })
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });

  it('aborts a PROCESSING job at the next stage boundary when cancel is requested', async () => {
    const db = createFakeDb();
    let proceed!: () => void;
    let stageCheck: (() => Promise<boolean>) | undefined;
    ingestDocument.mockImplementation(async (_documentId: string, _tenantId: string, _deps: unknown, hooks: unknown) => {
      stageCheck = (hooks as { shouldCancel?: () => Promise<boolean> }).shouldCancel;
      // Block inside the fake pipeline until the test drives the next stage.
      await new Promise<void>((resolve) => { proceed = resolve; });
      // Emulate the worker polling between pipeline stages after a cancel lands.
      if (await stageCheck!()) throw new IngestionCanceledError();
      return 'READY';
    });
    const jobId = await enqueueIngestion({ documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1' });
    await waitFor(() => stageCheck !== undefined);
    // The cancel route flips the flag while the job is mid-pipeline.
    db.setCancelRequested(jobId, true);
    proceed();
    await waitFor(() => db.jobs.get(jobId)?.status === 'CANCELED');
    expect(db.jobs.get(jobId)!.errorCode).toBe('INGESTION_CANCELED');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_CANCELED', resourceId: 'doc-1' })
    );
  });
});

// ---------------------------------------------------------------------------
// Admin requeue
// ---------------------------------------------------------------------------

describe('requeueIngestionJob', () => {
  it('requeues a QUARANTINED job with attempts and backoff reset', async () => {
    const db = createFakeDb();
    db.seedJob({
      id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'QUARANTINED', attempts: 5, errorCode: 'EMBEDDING_TIMEOUT',
    });
    const result = await requeueIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'admin-1' });
    expect(result).toEqual({ jobId: 'job-1', status: 'PENDING' });
    const job = db.jobs.get('job-1')!;
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
    expect(job.errorCode).toBeNull();
    expect(job.nextAttemptAt).toBeLessThanOrEqual(Date.now());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_REQUEUED', userId: 'admin-1', resourceId: 'doc-1' })
    );
  });

  it('404s when the job is not quarantined or failed', async () => {
    const db = createFakeDb();
    db.seedJob({ id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    await expect(
      requeueIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'admin-1' })
    ).rejects.toMatchObject({ code: 'JOB_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------
// Pool lifecycle, tenant fairness, startup recovery
// ---------------------------------------------------------------------------

describe('worker pool lifecycle', () => {
  it('starts idempotently and drains in-flight jobs on stop', async () => {
    const db = createFakeDb();
    const resolvers: Array<(value: 'READY') => void> = [];
    ingestDocument.mockImplementation(() => new Promise<'READY'>((resolve) => { resolvers.push(resolve); }));
    await startIngestionWorkers({ concurrency: 2 });
    await startIngestionWorkers({ concurrency: 2 });
    expect(isWorkerPoolRunning()).toBe(true);
    await enqueueIngestion({ documentId: 'd1', tenantId: 't1', requestedBy: 'u1' });
    await enqueueIngestion({ documentId: 'd2', tenantId: 't1', requestedBy: 'u1' });
    await waitFor(() => resolvers.length === 2);
    const stopping = stopIngestionWorkers();
    resolvers.splice(0).forEach((resolve) => resolve('READY'));
    await stopping;
    expect(isWorkerPoolRunning()).toBe(false);
    await waitFor(() => [...db.jobs.values()].every((j) => j.status === 'SUCCEEDED'));
  });

  it('claims round-robin across tenants so one tenant cannot starve another', async () => {
    const db = createFakeDb();
    const resolvers: Array<(value: 'READY') => void> = [];
    const started: string[] = [];
    ingestDocument.mockImplementation(async (documentId: string, tenantId: string) => {
      started.push(tenantId);
      await new Promise<'READY'>((resolve) => { resolvers.push(resolve); });
      return 'READY';
    });
    const wallStart = Date.now();
    await startIngestionWorkers({ concurrency: 1 });
    // Tenant A floods the queue; tenant B has a single job.
    for (let i = 0; i < 5; i++) {
      await enqueueIngestion({ documentId: `doc-a-${i}`, tenantId: 'tenant-a', requestedBy: 'u1' });
    }
    await enqueueIngestion({ documentId: 'doc-b-0', tenantId: 'tenant-b', requestedBy: 'u2' });
    // Drive the pool one job at a time: each iteration waits for the next
    // claim, then releases it.
    for (let n = 1; n <= 6; n++) {
      await waitFor(() => started.length === n);
      resolvers.shift()!('READY');
    }
    await waitFor(() => [...db.jobs.values()].every((j) => j.status === 'SUCCEEDED'));
    // Tenant B's lone job ran second — ahead of tenant A's backlog — instead
    // of waiting behind all five of A's jobs.
    expect(started).toEqual(['tenant-a', 'tenant-b', 'tenant-a', 'tenant-a', 'tenant-a', 'tenant-a']);
    // Prompt pickup: no 5s idle sleeps between jobs.
    expect(Date.now() - wallStart).toBeLessThan(10000);
    await stopIngestionWorkers();
  });
});

describe('recoverIngestionJobs', () => {
  it('reclaims crashed PROCESSING jobs to PENDING, preserving a cancel request', async () => {
    const db = createFakeDb();
    db.seedJob({
      id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'PROCESSING', attempts: 1, cancelRequested: true,
    });
    await recoverIngestionJobs({ startWorkers: false });
    const job = db.jobs.get('job-1')!;
    expect(job.status).toBe('PENDING');
    expect(job.cancelRequested).toBe(true);
  });

  it('quarantines poison jobs that exhausted attempts, preserving the error code', async () => {
    const db = createFakeDb();
    db.seedJob({
      id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'PENDING', attempts: 5, errorCode: 'EMBEDDING_TIMEOUT',
    });
    db.seedJob({
      id: 'job-2', documentId: 'doc-2', tenantId: 't1', requestedBy: 'u1',
      status: 'PENDING', attempts: 2, errorCode: 'EMBEDDING_TIMEOUT',
    });
    await recoverIngestionJobs({ startWorkers: false });
    expect(db.jobs.get('job-1')!.status).toBe('QUARANTINED');
    expect(db.jobs.get('job-1')!.errorCode).toBe('EMBEDDING_TIMEOUT');
    expect(db.jobs.get('job-2')!.status).toBe('PENDING');
    const quarantined = recordAudit.mock.calls.find(
      (call) => call[0].action === 'DOCUMENT_INGESTION_QUARANTINED'
    );
    expect(quarantined?.[0]).toMatchObject({ reason: 'EMBEDDING_TIMEOUT', resourceId: 'doc-1' });
    expect(quarantined?.[0].metadata).toMatchObject({ recoveredAtStartup: true });
    expect(db.documentUpdates.some((u) => u.sql.includes("status = 'QUARANTINED'"))).toBe(true);
  });

  it('heals orphaned documents across batches', async () => {
    const db = createFakeDb();
    db.extraTenants.push('t1');
    for (let i = 0; i < 20; i++) db.orphans.push({ id: `d${i}`, owner_id: 'u1' });
    await recoverIngestionJobs({ startWorkers: false });
    // First batch is full (20 = batch size, so a second SELECT runs), the
    // second comes back empty and the loop stops.
    expect(db.orphans).toHaveLength(0);
    const enqueues = tenantQuery.mock.calls.filter(([, sql]) =>
      (sql as string).includes('INSERT INTO document_ingestion_jobs')
    );
    expect(enqueues).toHaveLength(20);
    await waitFor(() => db.jobs.size === 20);
  });

  it('starts the worker pool by default', async () => {
    createFakeDb();
    expect(isWorkerPoolRunning()).toBe(false);
    await recoverIngestionJobs();
    expect(isWorkerPoolRunning()).toBe(true);
    await stopIngestionWorkers();
  });

  it('does not start the worker pool when startWorkers is false', async () => {
    createFakeDb();
    await recoverIngestionJobs({ startWorkers: false });
    expect(isWorkerPoolRunning()).toBe(false);
  });
});

describe('sweepStaleIngestionWork', () => {
  it('reclaims a stranded PROCESSING job and reseeds the fairness set', async () => {
    const db = createFakeDb();
    db.seedJob({
      id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PROCESSING',
    });
    await sweepStaleIngestionWork({ force: true });
    expect(db.jobs.get('job-1')!.status).toBe('PENDING');
    // The reseed worked: the pump can claim the reclaimed job even though no
    // enqueue notify ever fired for it.
    const claimed = await claimNextJob();
    expect(claimed?.id).toBe('job-1');
  });

  it('is throttled to once per minute unless forced', async () => {
    createFakeDb();
    const callsBefore = query.mock.calls.length;
    await sweepStaleIngestionWork({ force: true });
    const afterFirst = query.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(callsBefore);
    await sweepStaleIngestionWork();
    expect(query.mock.calls.length).toBe(afterFirst);
  });

  it('never throws on a database blip', async () => {
    createFakeDb();
    query.mockRejectedValueOnce(new Error('connection reset'));
    await expect(sweepStaleIngestionWork({ force: true })).resolves.toBeUndefined();
  });
});
