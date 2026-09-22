import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
const { ingestDocument } = vi.hoisted(() => ({ ingestDocument: vi.fn() }));
const { recordAudit, sanitizeReason } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  sanitizeReason: (reason: unknown) => reason,
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));
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
// worker's MongoDB operations to exercise enqueue/claim/execute/recover paths
// realistically.
// ---------------------------------------------------------------------------

interface FakeJob {
  _id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId: string | null;
  idempotencyKey: string | null;
  status: string;
  attempts: number;
  nextAttemptAt: Date;
  lockedAt?: Date;
  cancelRequested: boolean;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const ACTIVE_STATUSES = ['PENDING', 'PROCESSING'];
const isActive = (status: string) => status === 'PENDING' || status === 'PROCESSING';

// Simple MongoDB filter matcher for the operators used in queue.ts
function matchesFilter(doc: Record<string, any>, filter: Record<string, any>): boolean {
  for (const [key, condition] of Object.entries(filter)) {
    if (key === '$or') {
      if (!Array.isArray(condition) || !condition.some((c) => matchesFilter(doc, c))) return false;
      continue;
    }
    const value = doc[key];
    if (condition !== null && typeof condition === 'object' && !Array.isArray(condition) && !(condition instanceof Date)) {
      // Operator object
      for (const [op, opValue] of Object.entries(condition)) {
        if (op === '$in') {
          if (!Array.isArray(opValue) || !opValue.includes(value)) return false;
        } else if (op === '$nin') {
          if (Array.isArray(opValue) && opValue.includes(value)) return false;
        } else if (op === '$lte') {
          if (!(value <= (opValue as any))) return false;
        } else if (op === '$lt') {
          if (!(value < (opValue as any))) return false;
        } else if (op === '$gte') {
          if (!(value >= (opValue as any))) return false;
        } else if (op === '$gt') {
          if (!(value > (opValue as any))) return false;
        } else if (op === '$ne') {
          if (value === opValue) return false;
        } else {
          // Unknown operator: treat as equality (should not happen)
          if (value !== condition) return false;
        }
      }
    } else {
      // Direct equality (handles Date, string, null, etc.)
      if (condition instanceof Date && value instanceof Date) {
        if (condition.getTime() !== value.getTime()) return false;
      } else if (value !== condition) {
        return false;
      }
    }
  }
  return true;
}

function applyUpdate(doc: Record<string, any>, update: Record<string, any>): void {
  if (update.$set) {
    for (const [key, value] of Object.entries(update.$set)) {
      doc[key] = value;
    }
  }
  if (update.$inc) {
    for (const [key, value] of Object.entries(update.$inc)) {
      doc[key] = (doc[key] ?? 0) + (value as number);
    }
  }
  if (update.$unset) {
    for (const key of Object.keys(update.$unset)) {
      delete doc[key];
    }
  }
  // $setOnInsert is handled by the upsert logic, not here
}

function createFakeDb() {
  const jobs = new Map<string, FakeJob>();
  const documentUpdates: Array<{ filter: unknown; update: unknown }> = [];
  const orphans: Array<{ _id: string; ownerId: string }> = [];
  const extraTenants: string[] = [];
  let seq = 0;
  let blindFastPathOnce = false;
  let duplicateKeyOnce = false;

  const jobCollectionCalls: Array<{ op: string; filter: unknown; update?: unknown; options?: unknown }> = [];

  const seedJob = (overrides: Partial<FakeJob> & { _id: string }): FakeJob => {
    const job: FakeJob = {
      documentId: `doc-${overrides._id}`,
      tenantId: 't1',
      requestedBy: 'u1',
      requestId: null,
      idempotencyKey: null,
      status: 'PENDING',
      attempts: 0,
      nextAttemptAt: new Date(),
      cancelRequested: false,
      errorCode: null,
      createdAt: new Date(Date.now() + seq++),
      updatedAt: new Date(),
      ...overrides,
    };
    jobs.set(job._id, job);
    return job;
  };

  const jobsCollection = {
    findOne: vi.fn(async (filter: any, options?: any) => {
      jobCollectionCalls.push({ op: 'findOne', filter, options });
      let candidates = [...jobs.values()].filter((j) => matchesFilter(j as any, filter));
      if (options?.sort) {
        const [sortKey, sortDir] = Object.entries(options.sort)[0] as [string, number];
        candidates.sort((a, b) => {
          const av = (a as any)[sortKey];
          const bv = (b as any)[sortKey];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortDir === -1 ? -cmp : cmp;
        });
      }
      const found = candidates[0];
      if (!found) return null;
      // Apply projection if specified
      if (options?.projection) {
        const projected: any = { _id: found._id };
        for (const key of Object.keys(options.projection)) {
          if (options.projection[key] && key in found) {
            projected[key] = (found as any)[key];
          }
        }
        return projected;
      }
      return { ...found };
    }),
    find: vi.fn((filter: any, options?: any) => {
      jobCollectionCalls.push({ op: 'find', filter, options });
      const candidates = [...jobs.values()].filter((j) => matchesFilter(j as any, filter));
      return {
        toArray: vi.fn(async () => {
          if (options?.projection) {
            return candidates.map((j) => {
              const projected: any = { _id: j._id };
              for (const key of Object.keys(options.projection)) {
                if (options.projection[key] && key in j) {
                  projected[key] = (j as any)[key];
                }
              }
              return projected;
            });
          }
          return candidates.map((j) => ({ ...j }));
        }),
        limit: vi.fn().mockReturnThis(),
        sort: vi.fn().mockReturnThis(),
      };
    }),
    updateOne: vi.fn(async (filter: any, update: any, options?: any) => {
      jobCollectionCalls.push({ op: 'updateOne', filter, update, options });
      const found = [...jobs.values()].find((j) => matchesFilter(j as any, filter));
      if (found) {
        applyUpdate(found as any, update);
        (found as any).updatedAt = new Date();
        return { acknowledged: true, matchedCount: 1, modifiedCount: 1, upsertedCount: 0 };
      }
      if (options?.upsert && update.$setOnInsert) {
        // Check for duplicate key on idempotency (simulates partial unique index)
        if (duplicateKeyOnce) {
          duplicateKeyOnce = false;
          const err = new Error('duplicate key error') as Error & { code: number };
          err.code = 11000;
          throw err;
        }
        const newDoc = { ...update.$setOnInsert } as FakeJob;
        jobs.set(newDoc._id, newDoc);
        return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 1, upsertedId: newDoc._id };
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0, upsertedCount: 0 };
    }),
    updateMany: vi.fn(async (filter: any, update: any, _options?: any) => {
      jobCollectionCalls.push({ op: 'updateMany', filter, update });
      let count = 0;
      for (const job of jobs.values()) {
        if (matchesFilter(job as any, filter)) {
          applyUpdate(job as any, update);
          (job as any).updatedAt = new Date();
          count += 1;
        }
      }
      return { acknowledged: true, matchedCount: count, modifiedCount: count };
    }),
    findOneAndUpdate: vi.fn(async (filter: any, update: any, options?: any) => {
      jobCollectionCalls.push({ op: 'findOneAndUpdate', filter, update, options });
      let candidates = [...jobs.values()].filter((j) => matchesFilter(j as any, filter));
      if (options?.sort) {
        const [sortKey, sortDir] = Object.entries(options.sort)[0] as [string, number];
        candidates.sort((a, b) => {
          const av = (a as any)[sortKey];
          const bv = (b as any)[sortKey];
          const cmp = av < bv ? -1 : av > bv ? 1 : 0;
          return sortDir === -1 ? -cmp : cmp;
        });
      }
      const found = candidates[0];
      if (!found) return null;
      applyUpdate(found as any, update);
      (found as any).updatedAt = new Date();
      if (options?.returnDocument === 'after') {
        return { ...found };
      }
      return { ...found }; // Simplified: always return after
    }),
  };

  const documentsCollection = {
    updateOne: vi.fn(async (filter: any, update: any, _options?: any) => {
      documentUpdates.push({ filter, update });
      return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
    }),
    find: vi.fn((filter: any, _options?: any) => {
      // Orphan healing: return orphans matching the filter
      const batch = orphans.splice(0, 20);
      return {
        toArray: vi.fn(async () => batch),
        limit: vi.fn().mockReturnThis(),
      };
    }),
  };

  const tenantsCollection = {
    find: vi.fn((_filter: any, _options?: any) => {
      const ids = [...new Set([...jobs.values()].map((j) => j.tenantId).concat(extraTenants))];
      return {
        toArray: vi.fn(async () => ids.map((id) => ({ _id: id }))),
      };
    }),
  };

  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => {
      if (name === 'document_ingestion_jobs') return jobsCollection;
      if (name === 'documents') return documentsCollection;
      if (name === 'tenants') return tenantsCollection;
      throw new Error(`unexpected collection: ${name}`);
    },
  }));

  // For the blind fast-path test: simulate the race where findOne misses
  // but the upsert hits a duplicate key
  const simulateIdempotencyRace = () => {
    blindFastPathOnce = true;
    // Override findOne to miss once for idempotency lookups
    const originalFindOne = jobsCollection.findOne.getMockImplementation();
    jobsCollection.findOne.mockImplementationOnce(async (filter: any, options?: any) => {
      if (filter.idempotencyKey && blindFastPathOnce) {
        blindFastPathOnce = false;
        duplicateKeyOnce = true; // Next upsert will hit duplicate key
        return null;
      }
      return originalFindOne!(filter, options);
    });
  };

  return {
    jobs,
    documentUpdates,
    orphans,
    extraTenants,
    seedJob,
    jobCollectionCalls,
    setCancelRequested: (id: string, value = true) => {
      const job = jobs.get(id);
      if (job) job.cancelRequested = value;
    },
    blindFastPathOnce: simulateIdempotencyRace,
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
  getDbMock.mockReset();
  tenantOpMock.mockClear();
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
    const upserts = db.jobCollectionCalls.filter((c) => c.op === 'updateOne' && (c.options as any)?.upsert);
    expect(upserts).toHaveLength(1);
    expect((upserts[0]!.update as any).$setOnInsert.idempotencyKey).toBe('key-1');
    release('READY');
    await waitFor(() => db.jobs.get(first)?.status === 'SUCCEEDED');
  });

  it('returns the winning job when concurrent enqueues race on the idempotency key', async () => {
    const db = createFakeDb();
    let release!: (value: 'READY') => void;
    ingestDocument.mockImplementation(() => new Promise<'READY'>((resolve) => { release = resolve; }));
    const winner = await enqueueIngestion({ documentId: 'doc-w', tenantId: 't1', requestedBy: 'u1', idempotencyKey: 'k' });
    await waitFor(() => db.jobs.get(winner)?.status === 'PROCESSING');
    // Simulate the race window: the fast-path lookup misses, then the upsert
    // hits a duplicate key (11000) because the winner committed first.
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
    expect(job.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
    expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now() + 900000);
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
      db.documentUpdates.some((u) => (u.update as any).$set?.status === 'QUARANTINED')
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
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'u1', isAdmin: false });
    expect(result).toEqual({ status: 'canceled' });
    expect(db.jobs.get('job-1')!.status).toBe('CANCELED');
    expect(
      db.documentUpdates.some(
        (u) => (u.update as any).$set?.status === 'FAILED' && (u.update as any).$set?.errorCode === 'INGESTION_CANCELED'
      )
    ).toBe(true);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_CANCELED', resourceId: 'doc-1', success: false })
    );
  });

  it('rejects cancel from a non-owner non-admin', async () => {
    const db = createFakeDb();
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    await expect(
      cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'intruder', isAdmin: false })
    ).rejects.toMatchObject({ code: 'JOB_CANCEL_FORBIDDEN' });
    expect(db.jobs.get('job-1')!.status).toBe('PENDING');
  });

  it("lets an admin cancel another user's job", async () => {
    const db = createFakeDb();
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
    const result = await cancelIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'admin', isAdmin: true });
    expect(result).toEqual({ status: 'canceled' });
  });

  it('marks cancel-requested on a PROCESSING job for the worker to pick up', async () => {
    const db = createFakeDb();
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PROCESSING' });
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
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'SUCCEEDED' });
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
      _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'QUARANTINED', attempts: 5, errorCode: 'EMBEDDING_TIMEOUT',
    });
    const result = await requeueIngestionJob({ jobId: 'job-1', tenantId: 't1', userId: 'admin-1' });
    expect(result).toEqual({ jobId: 'job-1', status: 'PENDING' });
    const job = db.jobs.get('job-1')!;
    expect(job.status).toBe('PENDING');
    expect(job.attempts).toBe(0);
    expect(job.errorCode).toBeNull();
    expect(job.nextAttemptAt.getTime()).toBeLessThanOrEqual(Date.now());
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'DOCUMENT_INGESTION_REQUEUED', userId: 'admin-1', resourceId: 'doc-1' })
    );
  });

  it('404s when the job is not quarantined or failed', async () => {
    const db = createFakeDb();
    db.seedJob({ _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PENDING' });
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
      _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'PROCESSING', attempts: 1, cancelRequested: true,
      lockedAt: new Date(Date.now() - 10 * 60 * 1000), // stale lock proves the worker is gone
    });
    await recoverIngestionJobs({ startWorkers: false });
    const job = db.jobs.get('job-1')!;
    expect(job.status).toBe('PENDING');
    expect(job.cancelRequested).toBe(true);
  });

  it('quarantines poison jobs that exhausted attempts, preserving the error code', async () => {
    const db = createFakeDb();
    db.seedJob({
      _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1',
      status: 'PENDING', attempts: 5, errorCode: 'EMBEDDING_TIMEOUT',
    });
    db.seedJob({
      _id: 'job-2', documentId: 'doc-2', tenantId: 't1', requestedBy: 'u1',
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
    expect(db.documentUpdates.some((u) => (u.update as any).$set?.status === 'QUARANTINED')).toBe(true);
  });

  it('heals orphaned documents across batches', async () => {
    const db = createFakeDb();
    db.extraTenants.push('t1');
    for (let i = 0; i < 20; i++) db.orphans.push({ _id: `d${i}`, ownerId: 'u1' });
    await recoverIngestionJobs({ startWorkers: false });
    // First batch is full (20 = batch size, so a second find runs), the
    // second comes back empty and the loop stops.
    expect(db.orphans).toHaveLength(0);
    const enqueues = db.jobCollectionCalls.filter((c) => c.op === 'updateOne' && (c.options as any)?.upsert);
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
      _id: 'job-1', documentId: 'doc-1', tenantId: 't1', requestedBy: 'u1', status: 'PROCESSING',
      lockedAt: new Date(Date.now() - 10 * 60 * 1000), // stale lock proves the worker is gone
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
    const callsBefore = getDbMock.mock.calls.length;
    await sweepStaleIngestionWork({ force: true });
    const afterFirst = getDbMock.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(callsBefore);
    await sweepStaleIngestionWork();
    expect(getDbMock.mock.calls.length).toBe(afterFirst);
  });

  it('never throws on a database blip', async () => {
    createFakeDb();
    getDbMock.mockRejectedValueOnce(new Error('connection reset'));
    await expect(sweepStaleIngestionWork({ force: true })).resolves.toBeUndefined();
  });
});
