import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import { config } from '../config.js';
import { getDb, tenantOp } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { IngestionCanceledError, ingestDocument } from './ingestion.js';
import { recordIngestionJob } from '../observability/metrics.js';

/**
 * queue.ts — dedicated ingestion worker pool.
 *
 * Production topology: server boot calls recoverIngestionJobs(), which heals
 * crashed/poison jobs and then starts the pool (startIngestionWorkers). The
 * pump loop claims due PENDING jobs round-robin across tenants (tenant
 * fairness: one tenant's backlog cannot starve the others) and executes them
 * behind a counting semaphore sized by INGEST_WORKERS.
 *
 * Job lifecycle:
 *   PENDING --claim--> PROCESSING --ok--> SUCCEEDED
 *      |                    |
 *      |                    +--retryable failure--> PENDING (next_attempt_at =
 *      |                    |                       now + exponential backoff ±20% jitter)
 *      |                    +--attempts exhausted--> QUARANTINED (terminal, admin
 *      |                    |                       requeue only)
 *      |                    +--cancel requested----> CANCELED
 *      +--cancel by owner--> CANCELED
 *
 * A crashed server leaves PROCESSING jobs behind; startup recovery reclaims
 * them to PENDING (the lock timeout proves the worker is gone) and quarantines
 * jobs that have exhausted INGEST_MAX_ATTEMPTS.
 */

export interface QueueRequest {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId?: string;
  /** Optional client-supplied idempotency key; dedupes on (tenant_id, key). */
  idempotencyKey?: string;
}

interface ClaimedJob {
  id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId: string | null;
  attempts: number;
}

type IngestionJobStatus =
  | 'PENDING'
  | 'PROCESSING'
  | 'SUCCEEDED'
  | 'CANCELED'
  | 'QUARANTINED'
  | 'FAILED';

/** Shape of the `document_ingestion_jobs` MongoDB documents (ADR-014). */
interface IngestionJobDoc {
  _id: string;
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId: string | null;
  idempotencyKey: string | null;
  status: IngestionJobStatus;
  attempts: number;
  cancelRequested: boolean;
  errorCode: string | null;
  lockedAt?: Date | null;
  nextAttemptAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Job statuses considered "in flight" for enqueue dedupe and orphan healing. */
const ACTIVE_JOB_STATUSES: IngestionJobStatus[] = ['PENDING', 'PROCESSING'];

/** Minimal tenant reference for tenant discovery scans. */
interface TenantRef {
  _id: string;
}

/** Minimal document shape for ingestion status transitions. */
interface IngestionDocumentRef {
  _id: string;
  tenantId: string;
  status: string;
  errorCode: string | null;
  updatedAt: Date;
}

// ---------------------------------------------------------------------------
// Counting semaphore: the single gate for concurrent job executions, shared by
// the pool pump and the standalone (pre-boot/test) dispatch path.
// ---------------------------------------------------------------------------

class Semaphore {
  private capacity: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Semaphore requires a positive integer capacity');
    }
    this.capacity = capacity;
    this.available = capacity;
  }

  /** Resize the pool; growth takes effect immediately, shrink drains naturally. */
  resize(capacity: number): void {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error('Semaphore requires a positive integer capacity');
    }
    this.available += capacity - this.capacity;
    this.capacity = capacity;
    this.pumpWaiters();
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this.available -= 1;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.available += 1;
    this.pumpWaiters();
  }

  private pumpWaiters(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      this.waiters.shift()!();
    }
  }
}

const semaphore = new Semaphore(config.INGEST_WORKERS);

// ---------------------------------------------------------------------------
// Tenant fairness: round-robin claim order across tenants with pending work.
// ---------------------------------------------------------------------------

/** tenantId -> last time (ms) this process claimed a job for the tenant. */
const lastServedAt = new Map<string, number>();
/** Tenants believed to have due PENDING work; pruned by empty claims. */
const pendingTenants = new Set<string>();

/**
 * Pick the least-recently-served tenant; ties break on tenant id so the order
 * is deterministic. Exported for tests.
 */
export function selectNextTenant(tenantIds: string[]): string | null {
  let best: string | null = null;
  let bestScore = Infinity;
  for (const tenantId of tenantIds) {
    const score = lastServedAt.get(tenantId) ?? -1;
    if (score < bestScore || (score === bestScore && (best === null || tenantId < best))) {
      best = tenantId;
      bestScore = score;
    }
  }
  return best;
}

/** Test-only: reset fairness bookkeeping between tests. */
export function resetIngestionFairnessState(): void {
  lastServedAt.clear();
  pendingTenants.clear();
}

// ---------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------

const RETRY_JITTER_RATIO = 0.2; // ±20%

/**
 * Exponential backoff for a failed attempt: base * 2^(attempts-1) with ±20%
 * jitter, capped at INGEST_RETRY_MAX_DELAY_MS. `random` is injectable for
 * deterministic tests. Exported for tests.
 */
export function computeRetryDelayMs(attempts: number, random: () => number = Math.random): number {
  const base = config.INGEST_RETRY_BASE_DELAY_MS;
  const cap = config.INGEST_RETRY_MAX_DELAY_MS;
  const exponential = base * 2 ** Math.max(0, attempts - 1);
  const jitterFactor = 1 + (random() * 2 - 1) * RETRY_JITTER_RATIO;
  return Math.min(cap, Math.max(0, Math.floor(exponential * jitterFactor)));
}

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

type PoolState = 'stopped' | 'running' | 'stopping';
let poolState: PoolState = 'stopped';
let pumpDone: Promise<void> | null = null;
let wakeResolve: (() => void) | null = null;
let inFlight = 0;
const drainWaiters: Array<() => void> = [];

/**
 * Job ids currently held by this process's workers. The reclaim sweep must
 * never reset these: a long-running job's lease can legitimately expire
 * mid-execution, and only this process knows the job is still alive.
 */
const activeJobIds = new Set<string>();

/** Minimum gap between periodic reclaim-and-reseed sweeps (also the PROCESSING lease). */
const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

/** Idle poll interval when no job is due; enqueue/retry notify wakes earlier. */
const IDLE_POLL_MS = 5000;

/** Wake the pump loop (no-op when it isn't parked). Exported for tests. */
export function notifyIngestionWorkers(): void {
  const wake = wakeResolve;
  wakeResolve = null;
  wake?.();
}

export function isWorkerPoolRunning(): boolean {
  return poolState === 'running';
}

function trackJobStart(): void {
  inFlight += 1;
}

function trackJobEnd(): void {
  inFlight -= 1;
  if (inFlight === 0) {
    for (const waiter of drainWaiters.splice(0)) waiter();
  }
}

async function idleWait(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      wakeResolve = null;
      resolve();
    }, ms);
    // Never hold the process open for an idle worker.
    timer.unref?.();
    wakeResolve = () => {
      clearTimeout(timer);
      wakeResolve = null;
      resolve();
    };
  });
}

export interface StartWorkersOptions {
  /** Override INGEST_WORKERS (tests). */
  concurrency?: number;
}

/** Start the dedicated worker pool. Idempotent. */
export async function startIngestionWorkers(options: StartWorkersOptions = {}): Promise<void> {
  if (poolState !== 'stopped') return;
  semaphore.resize(options.concurrency ?? config.INGEST_WORKERS);
  poolState = 'running';
  pumpDone = pumpLoop().catch((error) => {
    // The pump only throws on programmer error; log loudly and park the pool
    // in a stopped state rather than hot-looping.
    console.error('Ingestion worker pump crashed:', error);
    poolState = 'stopped';
  });
}

/**
 * Drain/shutdown for tests and graceful shutdown: stops the pump, then waits
 * for in-flight jobs to settle. Claimed jobs finish; unclaimed PENDING work
 * (including backoff retries) is picked up on the next boot by recovery.
 */
export async function stopIngestionWorkers(): Promise<void> {
  if (poolState === 'stopped') return;
  poolState = 'stopping';
  notifyIngestionWorkers();
  // The pump may be parked in semaphore.acquire() behind in-flight jobs; each
  // release wakes it, it observes 'stopping', and exits.
  await pumpDone;
  poolState = 'stopped';
  if (inFlight > 0) {
    await new Promise<void>((resolve) => {
      drainWaiters.push(resolve);
    });
  }
}

async function pumpLoop(): Promise<void> {
  while (poolState === 'running') {
    // Periodic healing, throttled internally: reclaim PROCESSING leases whose
    // worker died after boot (a fast restart can strand a job with a fresh
    // lease) and reseed tenants whose PENDING work never entered the
    // process-local fairness set. Best-effort: a database blip is logged,
    // never thrown — the sweep must not crash the pump.
    await sweepStaleIngestionWork();
    const release = await semaphore.acquire();
    if (poolState !== 'running') {
      release();
      break;
    }
    let job: ClaimedJob | null = null;
    try {
      job = await claimNextJob();
    } catch (error) {
      console.error('Ingestion worker claim failed:', error);
    }
    if (!job) {
      release();
      // Re-check before sleeping: an enqueue that landed after the claim
      // attempt adds its tenant to pendingTenants first, so a notify can
      // never be missed here.
      if (poolState === 'running' && pendingTenants.size === 0) {
        await idleWait(IDLE_POLL_MS);
      }
      continue;
    }
    // Fire-and-forget: the permit is held until the job settles, which bounds
    // concurrency; the pump loops immediately to fill the next permit.
    void (async () => {
      activeJobIds.add(job.id);
      try {
        await executeJob(job);
      } catch (error) {
        // executeJob handles job-level failures itself; this is the last-
        // resort net for status-update/audit outages. The job stays
        // PROCESSING and the periodic sweep reclaims it via the lock timeout.
        console.error(`Ingestion job ${job.id} errored outside its handler:`, error);
      } finally {
        activeJobIds.delete(job.id);
        release();
        notifyIngestionWorkers();
      }
    })();
  }
}

// ---------------------------------------------------------------------------
// Periodic reclaim-and-reseed sweep
// ---------------------------------------------------------------------------

export interface SweepOptions {
  /** Bypass the throttle (used by startup recovery). */
  force?: boolean;
  /** Restrict the sweep to these tenants; default: every tenant in the database. */
  tenantIds?: string[];
}

/**
 * Reclaim stranded PROCESSING leases and reseed the fairness set. Exported
 * for tests and for startup recovery (which delegates its reclaim-and-seed
 * halves here so boot and runtime cannot drift apart).
 *
 * Startup recovery alone is not enough: a fast restart can strand a
 * PROCESSING job whose lease is still fresh, and PENDING jobs created by
 * other means may never enter the process-local pendingTenants set — both
 * would sit unclaimed until the next restart. The pump runs this sweep
 * periodically instead.
 *
 * - A crashed PROCESSING job is safe to retry: chunks are replaced before
 *   READY, and the lock timeout proves the worker is gone. A pending cancel
 *   request survives the reclaim: the next claim observes cancel_requested
 *   and marks the job CANCELED instead of running it.
 * - Jobs this process is actively executing are never reclaimed: a
 *   long-running job's lease can legitimately expire mid-execution.
 * - Poison handling stays with the failure path (handleJobFailure
 *   quarantines at runtime; startup recovery quarantines once at boot) so a
 *   reclaimed job that fails again is still bounded by INGEST_MAX_ATTEMPTS.
 * - Tenants with nothing claimable are pruned by claimNextJob, so reseeding
 *   on mere PENDING presence is self-correcting.
 *
 * Best-effort: a database blip is logged, never thrown.
 */
export async function sweepStaleIngestionWork(options: SweepOptions = {}): Promise<void> {
  const now = Date.now();
  if (!options.force && now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  try {
    const db = await getDb();
    const tenantIds = options.tenantIds
      ?? (await db.collection<TenantRef>('tenants').find<{ _id: string }>({}, { projection: { _id: 1 } }).toArray()).map((row) => row._id);
    let reseeded = false;
    const nowDate = new Date(now);
    for (const tenantId of tenantIds) {
      // Reclaim stranded PROCESSING leases: the lock timeout proves the
      // worker is gone. Jobs held by this process are never reclaimed.
      await db.collection<IngestionJobDoc>('document_ingestion_jobs').updateMany(
        {
          tenantId,
          status: 'PROCESSING',
          lockedAt: { $lt: new Date(now - 5 * 60 * 1000) },
          _id: { $nin: [...activeJobIds] },
        },
        {
          $set: { status: 'PENDING', nextAttemptAt: nowDate, updatedAt: nowDate },
          $unset: { lockedAt: '' },
        }
      );
      // Seed the fairness set: tenants with PENDING work are claim candidates.
      if (!pendingTenants.has(tenantId)) {
        const pending = await db.collection<IngestionJobDoc>('document_ingestion_jobs').findOne(
          { tenantId, status: 'PENDING' },
          { projection: { _id: 1 } }
        );
        if (pending) {
          pendingTenants.add(tenantId);
          reseeded = true;
        }
      }
    }
    if (reseeded) notifyIngestionWorkers();
  } catch (error) {
    console.error('Ingestion sweep failed:', error);
  }
}

// ---------------------------------------------------------------------------
// Claiming (tenant-fair, SKIP LOCKED so multiple workers never double-claim)
// ---------------------------------------------------------------------------

/**
 * Claim the oldest due PENDING job, round-robin across tenants with pending
 * work. Tenants with nothing due are pruned from pendingTenants; enqueue and
 * retry re-arming re-add them. Exported for tests.
 */
export async function claimNextJob(): Promise<ClaimedJob | null> {
  const candidates = [...pendingTenants].sort((a, b) => {
    const scoreA = lastServedAt.get(a) ?? -1;
    const scoreB = lastServedAt.get(b) ?? -1;
    return scoreA - scoreB || (a < b ? -1 : a > b ? 1 : 0);
  });
  for (const tenantId of candidates) {
    const job = await tryClaimForTenant(tenantId);
    if (job) {
      lastServedAt.set(tenantId, Date.now());
      return job;
    }
    pendingTenants.delete(tenantId);
  }
  return null;
}

async function tryClaimForTenant(tenantId: string): Promise<ClaimedJob | null> {
  // Atomic claim: the single findOneAndUpdate replaces
  // SELECT ... FOR UPDATE SKIP LOCKED — only one worker can transition a
  // given PENDING job to PROCESSING.
  const now = new Date();
  const job = await tenantOp(tenantId, (db) =>
    db.collection<IngestionJobDoc>('document_ingestion_jobs').findOneAndUpdate(
      { tenantId, status: 'PENDING', nextAttemptAt: { $lte: now } },
      {
        $set: { status: 'PROCESSING', lockedAt: now, updatedAt: now },
        $inc: { attempts: 1 },
      },
      { sort: { createdAt: 1 }, returnDocument: 'after' }
    )
  );
  if (!job) return null;
  return {
    id: job._id,
    documentId: job.documentId,
    tenantId: job.tenantId,
    requestedBy: job.requestedBy,
    requestId: job.requestId,
    attempts: job.attempts,
  };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function safeCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code).slice(0, 100)
    : 'INGESTION_FAILED';
}

function isDuplicateKey(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === 11000;
}

async function isCancelRequested(job: ClaimedJob): Promise<boolean> {
  try {
    const doc = await tenantOp(job.tenantId, (db) =>
      db.collection<IngestionJobDoc>('document_ingestion_jobs').findOne(
        { _id: job.id, tenantId: job.tenantId },
        { projection: { cancelRequested: 1 } }
      )
    );
    return doc?.cancelRequested === true;
  } catch {
    // A transient DB error must not cancel a healthy job; the next
    // stage-boundary check retries the read.
    return false;
  }
}

interface JobAuditBase {
  tenantId: string;
  userId: string;
  requestId?: string;
}

function auditBase(job: ClaimedJob): JobAuditBase {
  return {
    tenantId: job.tenantId,
    userId: job.requestedBy,
    ...(job.requestId ? { requestId: job.requestId } : {}),
  };
}

async function markJobCanceled(job: ClaimedJob, code: string): Promise<void> {
  const now = new Date();
  await tenantOp(job.tenantId, async (db) => {
    await db.collection<IngestionJobDoc>('document_ingestion_jobs').updateOne(
      { _id: job.id, tenantId: job.tenantId },
      { $set: { status: 'CANCELED', cancelRequested: false, errorCode: code, updatedAt: now } }
    );
    await db.collection<IngestionDocumentRef>('documents').updateOne(
      { _id: job.documentId, tenantId: job.tenantId, status: { $in: ['PENDING', 'PROCESSING'] } },
      { $set: { status: 'FAILED', errorCode: code, updatedAt: now } }
    );
  });
  await recordAudit({
    ...auditBase(job),
    action: 'DOCUMENT_INGESTION_CANCELED',
    resource: 'document',
    resourceId: job.documentId,
    success: false,
    reason: code,
  });
}

async function handleJobFailure(job: ClaimedJob, error: unknown): Promise<'quarantined' | 'failed'> {
  const code = safeCode(error);
  const maxAttempts = config.INGEST_MAX_ATTEMPTS;
  if (job.attempts >= maxAttempts) {
    // Poison-job quarantine: terminal, never auto-retried. error_code is
    // preserved so operators can see why the job kept failing; an admin can
    // requeue it via POST /documents/jobs/:id/requeue.
    const now = new Date();
    await tenantOp(job.tenantId, async (db) => {
      await db.collection<IngestionJobDoc>('document_ingestion_jobs').updateOne(
        { _id: job.id, tenantId: job.tenantId },
        { $set: { status: 'QUARANTINED', errorCode: code, updatedAt: now } }
      );
      await db.collection<IngestionDocumentRef>('documents').updateOne(
        { _id: job.documentId, tenantId: job.tenantId, status: { $in: ['PENDING', 'PROCESSING', 'FAILED'] } },
        { $set: { status: 'QUARANTINED', errorCode: code, updatedAt: now } }
      );
    });
    await recordAudit({
      ...auditBase(job),
      action: 'DOCUMENT_INGESTION_QUARANTINED',
      resource: 'document',
      resourceId: job.documentId,
      success: false,
      reason: code,
      metadata: { attempts: job.attempts, maxAttempts },
    });
    return 'quarantined';
  }
  // Retryable failure: back to PENDING with exponential backoff + jitter.
  // The backoff deadline is computed in JS (no NOW() + INTERVAL arithmetic).
  const delayMs = computeRetryDelayMs(job.attempts);
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await tenantOp(job.tenantId, (db) =>
    db.collection<IngestionJobDoc>('document_ingestion_jobs').updateOne(
      { _id: job.id, tenantId: job.tenantId },
      {
        $set: { status: 'PENDING', errorCode: code, nextAttemptAt, updatedAt: new Date() },
        $unset: { lockedAt: '' },
      }
    )
  );
  await recordAudit({
    ...auditBase(job),
    action: 'DOCUMENT_INGESTION_FAILED',
    resource: 'document',
    resourceId: job.documentId,
    success: false,
    reason: code,
    metadata: { attempts: job.attempts, maxAttempts, nextAttemptAt: nextAttemptAt.toISOString() },
  });
  // Re-arm the tenant so the retry is picked up when the backoff elapses,
  // even though the claim loop prunes tenants with nothing currently due.
  pendingTenants.add(job.tenantId);
  const timer = setTimeout(() => {
    pendingTenants.add(job.tenantId);
    notifyIngestionWorkers();
  }, delayMs);
  // A scheduled retry must never hold the process open on its own.
  timer.unref?.();
  return 'failed';
}

async function executeJob(job: ClaimedJob): Promise<void> {
  trackJobStart();
  const jobStart = Date.now();
  try {
    // Honor a cancel that landed between claim and execution.
    if (await isCancelRequested(job)) {
      await markJobCanceled(job, 'INGESTION_CANCELED');
      return;
    }
    await recordAudit({
      ...auditBase(job),
      action: 'DOCUMENT_INGESTION_STARTED',
      resource: 'document',
      resourceId: job.documentId,
    });
    try {
      const status = await ingestDocument(job.documentId, job.tenantId, undefined, {
        shouldCancel: () => isCancelRequested(job),
      });
      await tenantOp(job.tenantId, (db) =>
        db.collection<IngestionJobDoc>('document_ingestion_jobs').updateOne(
          { _id: job.id, tenantId: job.tenantId },
          { $set: { status: 'SUCCEEDED', updatedAt: new Date() } }
        )
      );
      recordIngestionJob('processed', (Date.now() - jobStart) / 1000);
      await recordAudit({
        ...auditBase(job),
        action: status === 'QUARANTINED' ? 'DOCUMENT_QUARANTINED' : 'DOCUMENT_INGESTION_COMPLETED',
        resource: 'document',
        resourceId: job.documentId,
        success: status === 'READY',
      });
    } catch (error) {
      if (error instanceof IngestionCanceledError) {
        await markJobCanceled(job, 'INGESTION_CANCELED');
        return;
      }
      const outcome = await handleJobFailure(job, error);
      recordIngestionJob(outcome, (Date.now() - jobStart) / 1000);
    }
  } finally {
    trackJobEnd();
  }
}

// ---------------------------------------------------------------------------
// Enqueue (with idempotency keys)
// ---------------------------------------------------------------------------

/** Dispatch a newly inserted job: pool notify, or standalone run pre-boot. */
function dispatchJob(request: QueueRequest): void {
  pendingTenants.add(request.tenantId);
  if (isWorkerPoolRunning()) {
    notifyIngestionWorkers();
    return;
  }
  // No pool yet (tests, scripts, or the pre-boot window): run through the
  // shared semaphore so concurrency stays bounded without a pool.
  setImmediate(() => {
    void (async () => {
      const release = await semaphore.acquire();
      try {
        const job = await tryClaimForTenant(request.tenantId);
        if (job) await executeJob(job);
      } catch (error) {
        console.error('Standalone ingestion dispatch failed:', error);
      } finally {
        release();
      }
    })();
  });
}

export async function enqueueIngestion(request: QueueRequest): Promise<string> {
  const tenantId = request.tenantId;
  const idempotencyKey = request.idempotencyKey?.trim() ? request.idempotencyKey.trim() : null;
  const db = await getDb();
  const jobs = db.collection<IngestionJobDoc>('document_ingestion_jobs');

  if (idempotencyKey) {
    // Fast path: a previous enqueue with the same key already has a job in
    // flight — return it instead of duplicating work.
    const existing = await jobs.findOne(
      { tenantId, idempotencyKey, status: { $in: ACTIVE_JOB_STATUSES } },
      { sort: { createdAt: -1 }, projection: { _id: 1 } }
    );
    if (existing) return existing._id;
  }

  const id = randomUUID();
  const now = new Date();
  try {
    // The partial unique index idx_ingestion_jobs_active_document
    // ({ documentId }, active statuses only) makes this upsert the atomic
    // equivalent of ON CONFLICT (document_id) WHERE status IN (...) DO
    // NOTHING: when an active job already exists for the document the filter
    // matches and $setOnInsert is a no-op; otherwise the job is inserted.
    const inserted = await jobs.updateOne(
      { tenantId, documentId: request.documentId, status: { $in: ACTIVE_JOB_STATUSES } },
      {
        $setOnInsert: {
          _id: id,
          documentId: request.documentId,
          tenantId,
          requestedBy: request.requestedBy,
          requestId: request.requestId ?? null,
          idempotencyKey,
          status: 'PENDING',
          attempts: 0,
          cancelRequested: false,
          errorCode: null,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        } satisfies Omit<IngestionJobDoc, 'lockedAt'>,
      },
      { upsert: true }
    );
    if (inserted.upsertedCount === 1) {
      recordIngestionJob('enqueued');
      dispatchJob(request);
      return id;
    }
  } catch (error) {
    if (!isDuplicateKey(error)) throw error;
    // Lost a race with a concurrent enqueue (duplicate key on the active-
    // document or idempotency partial unique index); fall through to the
    // lookup below and return the winner's job.
  }
  // Either the upsert matched an existing active job for this document or we
  // lost an idempotency race: return the in-flight job instead of
  // duplicating it.
  const or: Record<string, unknown>[] = [{ documentId: request.documentId }];
  if (idempotencyKey) or.push({ idempotencyKey });
  const existing = await jobs.findOne(
    { tenantId, status: { $in: ACTIVE_JOB_STATUSES }, $or: or },
    { sort: { createdAt: -1 }, projection: { _id: 1 } }
  );
  const jobId = existing?._id;
  if (!jobId) {
    // Cannot happen: we either hit a conflict or lost a race, both of which
    // imply a job exists. Fail loudly rather than returning a bogus id.
    throw Errors.internal('Ingestion enqueue conflict resolved to no job', undefined, 'ENQUEUE_CONFLICT');
  }
  return jobId;
}

// ---------------------------------------------------------------------------
// Cancellation + admin requeue (route handlers live in routes.ts)
// ---------------------------------------------------------------------------

export interface CancelJobRequest {
  jobId: string;
  tenantId: string;
  userId: string;
  /** True for platform admins (e.g. tenant:manage); otherwise must be the requester. */
  isAdmin: boolean;
  requestId?: string;
}

export type CancelJobResult =
  | { status: 'canceled' }
  | { status: 'cancel-requested' }
  | { status: 'already-terminal'; jobStatus: string };

/**
 * Cancel an ingestion job. A PENDING job flips to CANCELED immediately; a
 * PROCESSING job is marked cancel-requested and the worker aborts it at the
 * next pipeline stage boundary. Only the requesting user or an admin may
 * cancel. Terminal jobs report their state instead of erroring.
 */
export async function cancelIngestionJob(request: CancelJobRequest): Promise<CancelJobResult> {
  const db = await getDb();
  const jobs = db.collection<IngestionJobDoc>('document_ingestion_jobs');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const job = await jobs.findOne(
      { _id: request.jobId, tenantId: request.tenantId },
      { projection: { requestedBy: 1, status: 1, documentId: 1 } }
    );
    if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Ingestion job not found');
    if (job.requestedBy !== request.userId && !request.isAdmin) {
      throw Errors.forbidden('JOB_CANCEL_FORBIDDEN', 'Only the requesting user or an admin can cancel this job');
    }
    if (job.status === 'PENDING') {
      // Conditional update: a worker claiming the job concurrently wins the
      // race, modifiedCount comes back 0, and we re-read.
      const updated = await jobs.updateOne(
        { _id: request.jobId, tenantId: request.tenantId, status: 'PENDING' },
        { $set: { status: 'CANCELED', errorCode: 'INGESTION_CANCELED', updatedAt: new Date() } }
      );
      if (updated.modifiedCount !== 1) continue; // Lost a race with the worker; re-read.
      await db.collection<IngestionDocumentRef>('documents').updateOne(
        { _id: job.documentId, tenantId: request.tenantId, status: { $in: ['PENDING', 'PROCESSING'] } },
        { $set: { status: 'FAILED', errorCode: 'INGESTION_CANCELED', updatedAt: new Date() } }
      );
      await recordAudit({
        tenantId: request.tenantId,
        userId: request.userId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        action: 'DOCUMENT_INGESTION_CANCELED',
        resource: 'document',
        resourceId: job.documentId,
        success: false,
        reason: 'INGESTION_CANCELED',
      });
      return { status: 'canceled' };
    }
    if (job.status === 'PROCESSING') {
      await jobs.updateOne(
        { _id: request.jobId, tenantId: request.tenantId },
        { $set: { cancelRequested: true, updatedAt: new Date() } }
      );
      await recordAudit({
        tenantId: request.tenantId,
        userId: request.userId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        action: 'DOCUMENT_INGESTION_CANCEL_REQUESTED',
        resource: 'document',
        resourceId: job.documentId,
      });
      return { status: 'cancel-requested' };
    }
    return { status: 'already-terminal', jobStatus: job.status };
  }
  throw Errors.conflict('JOB_STATE_RACE', 'Job state changed while canceling; retry the request');
}

export interface RequeueJobRequest {
  jobId: string;
  tenantId: string;
  /** The admin performing the requeue (audited). */
  userId: string;
  requestId?: string;
}

/**
 * Admin requeue of a QUARANTINED (or FAILED) job: resets attempts and the
 * backoff clock and puts the job back to PENDING. Quarantined jobs are never
 * auto-retried — this is the only way back.
 */
export async function requeueIngestionJob(request: RequeueJobRequest): Promise<{ jobId: string; status: 'PENDING' }> {
  const db = await getDb();
  const job = await db.collection<IngestionJobDoc>('document_ingestion_jobs').findOneAndUpdate(
    { _id: request.jobId, tenantId: request.tenantId, status: { $in: ['QUARANTINED', 'FAILED'] } },
    {
      $set: {
        status: 'PENDING', attempts: 0, nextAttemptAt: new Date(),
        cancelRequested: false, errorCode: null, updatedAt: new Date(),
      },
      $unset: { lockedAt: '' },
    },
    { returnDocument: 'after', projection: { _id: 1, documentId: 1 } }
  );
  if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Quarantined or failed ingestion job not found');
  await db.collection<IngestionDocumentRef>('documents').updateOne(
    { _id: job.documentId, tenantId: request.tenantId, status: { $in: ['QUARANTINED', 'FAILED'] } },
    { $set: { status: 'PENDING', errorCode: null, updatedAt: new Date() } }
  );
  await recordAudit({
    tenantId: request.tenantId,
    userId: request.userId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    action: 'DOCUMENT_INGESTION_REQUEUED',
    resource: 'document',
    resourceId: job.documentId,
    metadata: { jobId: job._id },
  });
  pendingTenants.add(request.tenantId);
  notifyIngestionWorkers();
  return { jobId: job._id, status: 'PENDING' };
}

// ---------------------------------------------------------------------------
// Startup recovery
// ---------------------------------------------------------------------------

export interface RecoverOptions {
  /** Start the worker pool after healing (default true; disable in tests). */
  startWorkers?: boolean;
}

export async function recoverIngestionJobs(options: RecoverOptions = {}): Promise<void> {
  const maxAttempts = config.INGEST_MAX_ATTEMPTS;
  const db = await getDb();
  const tenants = await db.collection<TenantRef>('tenants').find<{ _id: string }>({}, { projection: { _id: 1 } }).toArray();
  for (const tenant of tenants) {
    const tenantId = tenant._id;
    // Reclaim-and-reseed is shared with the periodic pump sweep (forced here,
    // not throttled) so boot and runtime healing cannot drift apart.
    await sweepStaleIngestionWork({ force: true, tenantIds: [tenantId] });
    // Poison handling runs BEFORE orphan healing: a job that crashed
    // maxAttempts+ times without ever succeeding is QUARANTINED (terminal,
    // never auto-retried) instead of being retried forever. The crash counter
    // lives in `attempts`, incremented on every claim. errorCode is preserved
    // so operators can see the last failure; jobs with no recorded error get
    // POISON_MESSAGE.
    const candidates = await db.collection<IngestionJobDoc>('document_ingestion_jobs').find(
      { tenantId, status: 'PENDING', attempts: { $gte: maxAttempts } },
      { projection: { _id: 1 } }
    ).toArray();
    const jobs = db.collection<IngestionJobDoc>('document_ingestion_jobs');
    for (const candidate of candidates) {
      // Atomic per-job transition: a worker claiming the job concurrently
      // flips it to PROCESSING first, the filter misses, and we skip it.
      const poison = await jobs.findOneAndUpdate(
        { _id: candidate._id, tenantId, status: 'PENDING' },
        { $set: { status: 'QUARANTINED', updatedAt: new Date() } },
        { returnDocument: 'after' }
      );
      if (!poison) continue;
      const code = poison.errorCode ?? 'POISON_MESSAGE';
      if (!poison.errorCode) {
        await jobs.updateOne(
          { _id: poison._id, tenantId },
          { $set: { errorCode: 'POISON_MESSAGE' } }
        );
      }
      await db.collection<IngestionDocumentRef>('documents').updateOne(
        { _id: poison.documentId, tenantId, status: { $in: ['PENDING', 'PROCESSING', 'FAILED'] } },
        { $set: { status: 'QUARANTINED', errorCode: code, updatedAt: new Date() } }
      );
      await recordAudit({
        tenantId,
        userId: poison.requestedBy,
        ...(poison.requestId ? { requestId: poison.requestId } : {}),
        action: 'DOCUMENT_INGESTION_QUARANTINED',
        resource: 'document',
        resourceId: poison.documentId,
        success: false,
        reason: code,
        metadata: { attempts: poison.attempts, maxAttempts, recoveredAtStartup: true },
      });
    }
    // Heal documents stuck in PENDING/PROCESSING without an active job row
    // (e.g. the /retry route reset the status but the enqueue INSERT failed).
    // Quarantined jobs already moved their documents to QUARANTINED above, so
    // healing here cannot resurrect poison. Recovery runs only at startup, so
    // drain in batches until a batch comes back short instead of healing only
    // the first page. The batch cap is a backstop: if enqueueing never clears
    // the orphan rows (e.g. the INSERT keeps failing), recovery must not spin
    // forever.
    const ORPHAN_BATCH_SIZE = 20;
    const ORPHAN_MAX_BATCHES = 500;
    for (let batch = 0; batch < ORPHAN_MAX_BATCHES; batch += 1) {
      // Application-side anti-join: the LEFT JOIN ... IS NULL becomes a
      // $nin over the in-flight job document IDs. Recovery is a rare,
      // startup-only path, so the two-query form is acceptable.
      const activeJobs = await jobs.find(
        { tenantId, status: { $in: ACTIVE_JOB_STATUSES } },
        { projection: { documentId: 1 } }
      ).toArray();
      const activeDocumentIds = activeJobs.map((j) => j.documentId);
      const orphaned = await db.collection<IngestionDocumentRef>('documents').find<{ _id: string; ownerId: string }>(
        {
          tenantId,
          deletedAt: null,
          status: { $in: ['PENDING', 'PROCESSING'] },
          classification: { $ne: 'UNKNOWN' },
          _id: { $nin: activeDocumentIds },
        },
        { projection: { _id: 1, ownerId: 1 } }
      ).limit(ORPHAN_BATCH_SIZE).toArray();
      if (orphaned.length === 0) break;
      for (const document of orphaned) {
        await enqueueIngestion({ documentId: document._id, tenantId, requestedBy: document.ownerId });
      }
      if (orphaned.length < ORPHAN_BATCH_SIZE) break;
      if (batch === ORPHAN_MAX_BATCHES - 1) {
        console.warn(
          `Orphan recovery for tenant ${tenantId} hit the ${ORPHAN_MAX_BATCHES}-batch cap; ` +
            'remaining orphans will be retried on the next restart'
        );
      }
    }
  }
  // Boot is complete: start the dedicated worker pool (idempotent). The pool
  // picks up PENDING work via claimNextJob; nothing is dispatched inline here.
  if (options.startWorkers !== false) {
    await startIngestionWorkers();
  }
}
