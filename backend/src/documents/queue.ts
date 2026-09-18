import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import { config } from '../config.js';
import { query, tenantQuery } from '../db/pool.js';
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

const ACTIVE_JOB_STATUSES = "('PENDING', 'PROCESSING')";

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
      try {
        await executeJob(job);
      } catch (error) {
        // executeJob handles job-level failures itself; this is the last-
        // resort net for status-update/audit outages. The job stays
        // PROCESSING and startup recovery reclaims it via the lock timeout.
        console.error(`Ingestion job ${job.id} errored outside its handler:`, error);
      } finally {
        release();
        notifyIngestionWorkers();
      }
    })();
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
  const claimed = await tenantQuery<{
    id: string;
    document_id: string;
    tenant_id: string;
    requested_by: string;
    request_id: string | null;
    attempts: number;
  }>(
    tenantId,
    `UPDATE document_ingestion_jobs
     SET status = 'PROCESSING', attempts = attempts + 1,
         locked_at = NOW(), updated_at = NOW()
     WHERE id = (
       SELECT id FROM document_ingestion_jobs
       WHERE tenant_id = $1 AND status = 'PENDING' AND next_attempt_at <= NOW()
       ORDER BY created_at
       LIMIT 1
       FOR UPDATE SKIP LOCKED
     )
     RETURNING id, document_id, tenant_id, requested_by, request_id, attempts`,
    [tenantId]
  );
  const row = claimed.rows[0];
  if (!row) return null;
  return {
    id: row.id,
    documentId: row.document_id,
    tenantId: row.tenant_id,
    requestedBy: row.requested_by,
    requestId: row.request_id,
    attempts: row.attempts,
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

function isUniqueViolation(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { code?: unknown }).code === '23505';
}

async function isCancelRequested(job: ClaimedJob): Promise<boolean> {
  try {
    const row = (
      await tenantQuery<{ cancel_requested: boolean }>(
        job.tenantId,
        'SELECT cancel_requested FROM document_ingestion_jobs WHERE id = $1',
        [job.id]
      )
    ).rows[0];
    return row?.cancel_requested === true;
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
  await tenantQuery(
    job.tenantId,
    `UPDATE document_ingestion_jobs
     SET status = 'CANCELED', cancel_requested = FALSE, error_code = $2, updated_at = NOW()
     WHERE id = $1`,
    [job.id, code]
  );
  await tenantQuery(
    job.tenantId,
    `UPDATE documents SET status = 'FAILED', error_code = $2, updated_at = NOW()
     WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')`,
    [job.documentId, code]
  );
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
    await tenantQuery(
      job.tenantId,
      `UPDATE document_ingestion_jobs
       SET status = 'QUARANTINED', error_code = $2, updated_at = NOW()
       WHERE id = $1`,
      [job.id, code]
    );
    await tenantQuery(
      job.tenantId,
      `UPDATE documents SET status = 'QUARANTINED', error_code = $2, updated_at = NOW()
       WHERE id = $1 AND status IN ('PENDING', 'PROCESSING', 'FAILED')`,
      [job.documentId, code]
    );
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
  const delayMs = computeRetryDelayMs(job.attempts);
  const nextAttemptAt = new Date(Date.now() + delayMs);
  await tenantQuery(
    job.tenantId,
    `UPDATE document_ingestion_jobs
     SET status = 'PENDING', error_code = $2, next_attempt_at = $3,
         locked_at = NULL, updated_at = NOW()
     WHERE id = $1`,
    [job.id, code, nextAttemptAt.toISOString()]
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
      await tenantQuery(
        job.tenantId,
        "UPDATE document_ingestion_jobs SET status = 'SUCCEEDED', updated_at = NOW() WHERE id = $1",
        [job.id]
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

  if (idempotencyKey) {
    // Fast path: a previous enqueue with the same key already has a job in
    // flight — return it instead of duplicating work.
    const existing = await tenantQuery<{ id: string }>(
      tenantId,
      `SELECT id FROM document_ingestion_jobs
       WHERE tenant_id = $1 AND idempotency_key = $2 AND status IN ${ACTIVE_JOB_STATUSES}
       ORDER BY created_at DESC LIMIT 1`,
      [tenantId, idempotencyKey]
    );
    if (existing.rows[0]) return existing.rows[0].id;
  }

  const id = randomUUID();
  try {
    const inserted = await tenantQuery<{ id: string }>(
      tenantId,
      `INSERT INTO document_ingestion_jobs (id, document_id, tenant_id, requested_by, request_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (document_id) WHERE status IN ${ACTIVE_JOB_STATUSES} DO NOTHING
       RETURNING id`,
      [id, request.documentId, tenantId, request.requestedBy, request.requestId ?? null, idempotencyKey]
    );
    const jobId = inserted.rows[0]?.id;
    if (jobId) {
      recordIngestionJob('enqueued');
      dispatchJob(request);
      return jobId;
    }
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Lost a race with a concurrent enqueue on (tenant_id, idempotency_key);
    // fall through to the lookup below and return the winner's job.
  }
  // Either ON CONFLICT DO NOTHING fired (an active job already exists for this
  // document) or we lost an idempotency race: return the in-flight job instead
  // of duplicating it.
  const existing = await tenantQuery<{ id: string }>(
    tenantId,
    `SELECT id FROM document_ingestion_jobs
     WHERE tenant_id = $1 AND status IN ${ACTIVE_JOB_STATUSES}
       AND (document_id = $2 OR ($3::text IS NOT NULL AND idempotency_key = $3))
     ORDER BY created_at DESC LIMIT 1`,
    [tenantId, request.documentId, idempotencyKey]
  );
  const jobId = existing.rows[0]?.id;
  if (!jobId) {
    // Cannot happen: we either hit a conflict or lost a race, both of which
    // imply a row exists. Fail loudly rather than returning a bogus id.
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const job = (
      await tenantQuery<{ requested_by: string; status: string; document_id: string }>(
        request.tenantId,
        'SELECT requested_by, status, document_id FROM document_ingestion_jobs WHERE id = $1',
        [request.jobId]
      )
    ).rows[0];
    if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Ingestion job not found');
    if (job.requested_by !== request.userId && !request.isAdmin) {
      throw Errors.forbidden('JOB_CANCEL_FORBIDDEN', 'Only the requesting user or an admin can cancel this job');
    }
    if (job.status === 'PENDING') {
      const updated = await tenantQuery(
        request.tenantId,
        `UPDATE document_ingestion_jobs
         SET status = 'CANCELED', error_code = 'INGESTION_CANCELED', updated_at = NOW()
         WHERE id = $1 AND status = 'PENDING'`,
        [request.jobId]
      );
      if (updated.rowCount !== 1) continue; // Lost a race with the worker; re-read.
      await tenantQuery(
        request.tenantId,
        `UPDATE documents SET status = 'FAILED', error_code = 'INGESTION_CANCELED', updated_at = NOW()
         WHERE id = $1 AND status IN ('PENDING', 'PROCESSING')`,
        [job.document_id]
      );
      await recordAudit({
        tenantId: request.tenantId,
        userId: request.userId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        action: 'DOCUMENT_INGESTION_CANCELED',
        resource: 'document',
        resourceId: job.document_id,
        success: false,
        reason: 'INGESTION_CANCELED',
      });
      return { status: 'canceled' };
    }
    if (job.status === 'PROCESSING') {
      await tenantQuery(
        request.tenantId,
        'UPDATE document_ingestion_jobs SET cancel_requested = TRUE, updated_at = NOW() WHERE id = $1',
        [request.jobId]
      );
      await recordAudit({
        tenantId: request.tenantId,
        userId: request.userId,
        ...(request.requestId ? { requestId: request.requestId } : {}),
        action: 'DOCUMENT_INGESTION_CANCEL_REQUESTED',
        resource: 'document',
        resourceId: job.document_id,
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
  const updated = await tenantQuery<{ id: string; document_id: string }>(
    request.tenantId,
    `UPDATE document_ingestion_jobs
     SET status = 'PENDING', attempts = 0, next_attempt_at = NOW(),
         cancel_requested = FALSE, locked_at = NULL, error_code = NULL, updated_at = NOW()
     WHERE id = $1 AND status IN ('QUARANTINED', 'FAILED')
     RETURNING id, document_id`,
    [request.jobId]
  );
  const row = updated.rows[0];
  if (!row) throw Errors.notFound('JOB_NOT_FOUND', 'Quarantined or failed ingestion job not found');
  await tenantQuery(
    request.tenantId,
    `UPDATE documents SET status = 'PENDING', error_code = NULL, updated_at = NOW()
     WHERE id = $1 AND status IN ('QUARANTINED', 'FAILED')`,
    [row.document_id]
  );
  await recordAudit({
    tenantId: request.tenantId,
    userId: request.userId,
    ...(request.requestId ? { requestId: request.requestId } : {}),
    action: 'DOCUMENT_INGESTION_REQUEUED',
    resource: 'document',
    resourceId: row.document_id,
    metadata: { jobId: row.id },
  });
  pendingTenants.add(request.tenantId);
  notifyIngestionWorkers();
  return { jobId: row.id, status: 'PENDING' };
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
  const tenants = await query<{ id: string }>('SELECT id FROM tenants');
  for (const tenant of tenants.rows) {
    // A crashed PROCESSING job is safe to retry: chunks are replaced before
    // READY. The lock timeout proves the worker is gone. A pending cancel
    // request survives the crash: the next claim observes cancel_requested
    // and marks the job CANCELED instead of running it.
    await tenantQuery(
      tenant.id,
      `UPDATE document_ingestion_jobs
       SET status = 'PENDING', locked_at = NULL, next_attempt_at = NOW(), updated_at = NOW()
       WHERE status = 'PROCESSING' AND locked_at < NOW() - INTERVAL '5 minutes'`
    );
    // Poison handling runs BEFORE orphan healing: a job that crashed
    // maxAttempts+ times without ever succeeding is QUARANTINED (terminal,
    // never auto-retried) instead of being retried forever. The crash counter
    // lives in `attempts`, incremented on every claim. error_code is preserved
    // so operators can see the last failure; jobs with no recorded error get
    // POISON_MESSAGE.
    const poisoned = await tenantQuery<{
      id: string;
      document_id: string;
      requested_by: string;
      request_id: string | null;
      error_code: string | null;
      attempts: number;
    }>(
      tenant.id,
      `UPDATE document_ingestion_jobs
       SET status = 'QUARANTINED', updated_at = NOW()
       WHERE status = 'PENDING' AND attempts >= $1
       RETURNING id, document_id, requested_by, request_id, error_code, attempts`,
      [maxAttempts]
    );
    for (const poison of poisoned.rows) {
      const code = poison.error_code ?? 'POISON_MESSAGE';
      if (!poison.error_code) {
        await tenantQuery(
          tenant.id,
          "UPDATE document_ingestion_jobs SET error_code = 'POISON_MESSAGE' WHERE id = $1",
          [poison.id]
        );
      }
      await tenantQuery(
        tenant.id,
        `UPDATE documents SET status = 'QUARANTINED', error_code = $2, updated_at = NOW()
         WHERE id = $1 AND status IN ('PENDING', 'PROCESSING', 'FAILED')`,
        [poison.document_id, code]
      );
      await recordAudit({
        tenantId: tenant.id,
        userId: poison.requested_by,
        ...(poison.request_id ? { requestId: poison.request_id } : {}),
        action: 'DOCUMENT_INGESTION_QUARANTINED',
        resource: 'document',
        resourceId: poison.document_id,
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
      const orphaned = await tenantQuery<{ id: string; owner_id: string }>(
        tenant.id,
        `SELECT d.id, d.owner_id FROM documents d
         LEFT JOIN document_ingestion_jobs j
           ON j.document_id = d.id AND j.status IN ${ACTIVE_JOB_STATUSES}
         WHERE d.tenant_id = $1 AND d.deleted_at IS NULL
           AND d.status IN ('PENDING', 'PROCESSING')
           AND d.classification <> 'UNKNOWN'
           AND j.id IS NULL
         LIMIT $2`,
        [tenant.id, ORPHAN_BATCH_SIZE]
      );
      if (orphaned.rows.length === 0) break;
      for (const document of orphaned.rows) {
        await enqueueIngestion({ documentId: document.id, tenantId: tenant.id, requestedBy: document.owner_id });
      }
      if (orphaned.rows.length < ORPHAN_BATCH_SIZE) break;
      if (batch === ORPHAN_MAX_BATCHES - 1) {
        console.warn(
          `Orphan recovery for tenant ${tenant.id} hit the ${ORPHAN_MAX_BATCHES}-batch cap; ` +
            'remaining orphans will be retried on the next restart'
        );
      }
    }
    // Seed the fairness set: tenants with PENDING work are claim candidates
    // from the first pump iteration.
    const pending = await tenantQuery<{ id: string }>(
      tenant.id,
      `SELECT id FROM document_ingestion_jobs WHERE status = 'PENDING' LIMIT 1`
    );
    if (pending.rowCount !== 0) pendingTenants.add(tenant.id);
  }
  // Boot is complete: start the dedicated worker pool (idempotent). The pool
  // picks up PENDING work via claimNextJob; nothing is dispatched inline here.
  if (options.startWorkers !== false) {
    await startIngestionWorkers();
  }
}
