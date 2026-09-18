import { randomUUID } from 'node:crypto';
import { recordAudit } from '../audit/audit.js';
import { query, tenantQuery } from '../db/pool.js';
import { ingestDocument } from './ingestion.js';

interface QueueRequest {
  documentId: string;
  tenantId: string;
  requestedBy: string;
  requestId?: string;
}

const running = new Set<string>();
const MAX_CONCURRENT_JOBS = 2;

function safeCode(error: unknown): string {
  return error instanceof Error && 'code' in error
    ? String((error as Error & { code: unknown }).code).slice(0, 100)
    : 'INGESTION_FAILED';
}

async function processJob(jobId: string, request: QueueRequest): Promise<void> {
  if (running.size >= MAX_CONCURRENT_JOBS) {
    setTimeout(() => void processJob(jobId, request), 250).unref();
    return;
  }
  running.add(jobId);
  let claimed;
  try {
    claimed = await tenantQuery(
      request.tenantId,
      `UPDATE document_ingestion_jobs SET status = 'PROCESSING', attempts = attempts + 1,
         locked_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND status = 'PENDING' RETURNING id`,
      [jobId]
    );
  } catch {
    running.delete(jobId);
    return;
  }
  if (claimed.rowCount !== 1) {
    running.delete(jobId);
    return;
  }
  await recordAudit({ tenantId: request.tenantId, userId: request.requestedBy, requestId: request.requestId,
    action: 'DOCUMENT_INGESTION_STARTED', resource: 'document', resourceId: request.documentId });
  try {
    const status = await ingestDocument(request.documentId, request.tenantId);
    await tenantQuery(request.tenantId,
      "UPDATE document_ingestion_jobs SET status = 'SUCCEEDED', updated_at = NOW() WHERE id = $1", [jobId]);
    await recordAudit({ tenantId: request.tenantId, userId: request.requestedBy, requestId: request.requestId,
      action: status === 'QUARANTINED' ? 'DOCUMENT_QUARANTINED' : 'DOCUMENT_INGESTION_COMPLETED',
      resource: 'document', resourceId: request.documentId, success: status === 'READY' });
  } catch (error) {
    const code = safeCode(error);
    await tenantQuery(request.tenantId,
      "UPDATE document_ingestion_jobs SET status = 'FAILED', error_code = $2, updated_at = NOW() WHERE id = $1", [jobId, code]);
    await recordAudit({ tenantId: request.tenantId, userId: request.requestedBy, requestId: request.requestId,
      action: 'DOCUMENT_INGESTION_FAILED', resource: 'document', resourceId: request.documentId,
      success: false, reason: code });
  } finally {
    running.delete(jobId);
  }
}

export async function enqueueIngestion(request: QueueRequest): Promise<string> {
  const id = randomUUID();
  const inserted = await tenantQuery<{ id: string }>(request.tenantId,
    `INSERT INTO document_ingestion_jobs (id, document_id, tenant_id, requested_by, request_id)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (document_id) WHERE status IN ('PENDING', 'PROCESSING') DO NOTHING
     RETURNING id`,
    [id, request.documentId, request.tenantId, request.requestedBy, request.requestId ?? null]);
  const jobId = inserted.rows[0]?.id;
  if (jobId) setImmediate(() => void processJob(jobId, request));
  if (jobId) return jobId;
  const existing = await tenantQuery<{ id: string }>(request.tenantId,
    "SELECT id FROM document_ingestion_jobs WHERE document_id = $1 AND status IN ('PENDING', 'PROCESSING')",
    [request.documentId]);
  return existing.rows[0]!.id;
}

export async function recoverIngestionJobs(): Promise<void> {
  const tenants = await query<{ id: string }>('SELECT id FROM tenants');
  for (const tenant of tenants.rows) {
    // A crashed PROCESSING job is safe to retry: chunks are replaced before READY.
    await tenantQuery(tenant.id,
      "UPDATE document_ingestion_jobs SET status = 'PENDING', locked_at = NULL, updated_at = NOW() WHERE status = 'PROCESSING' AND locked_at < NOW() - INTERVAL '5 minutes'");
    // Poison-message handling runs BEFORE orphan recovery: a job that crashed
    // 3+ times without ever succeeding is marked FAILED instead of being
    // retried forever (the crash counter lives in `attempts`, incremented on
    // every claim in processJob). Running this first prevents the orphan pass
    // from re-enqueueing a document whose job is about to be declared poison.
    await tenantQuery(tenant.id,
      `UPDATE document_ingestion_jobs SET status = 'FAILED', error_code = 'POISON_MESSAGE',
         updated_at = NOW()
       WHERE status = 'PENDING' AND attempts >= 3`);
    // The associated documents must also leave the pipeline: otherwise they
    // stay PENDING/PROCESSING forever and the orphan recovery below would
    // re-enqueue them into an infinite poison loop. Only documents with no
    // remaining active job are failed here.
    await tenantQuery(tenant.id,
      `UPDATE documents d SET status = 'FAILED', error_code = 'POISON_MESSAGE', updated_at = NOW()
       WHERE d.tenant_id = $1 AND d.deleted_at IS NULL
         AND d.status IN ('PENDING', 'PROCESSING')
         AND NOT EXISTS (
           SELECT 1 FROM document_ingestion_jobs j
           WHERE j.document_id = d.id AND j.status IN ('PENDING', 'PROCESSING')
         )`, [tenant.id]);
    // Heal documents stuck in PENDING/PROCESSING without an active job row
    // (e.g. the /retry route reset the status but the enqueue INSERT failed).
    // enqueueIngestion is idempotent per document, so re-enqueueing is safe.
    // Recovery runs only at startup, so drain in batches until a batch comes
    // back short instead of healing only the first page. The batch cap is a
    // backstop: if enqueueing never clears the orphan rows (e.g. the INSERT
    // keeps failing), recovery must not spin forever.
    const ORPHAN_BATCH_SIZE = 20;
    const ORPHAN_MAX_BATCHES = 500;
    for (let batch = 0; batch < ORPHAN_MAX_BATCHES; batch += 1) {
      const orphaned = await tenantQuery<{ id: string; owner_id: string }>(tenant.id,
        `SELECT d.id, d.owner_id FROM documents d
         LEFT JOIN document_ingestion_jobs j
           ON j.document_id = d.id AND j.status IN ('PENDING', 'PROCESSING')
         WHERE d.tenant_id = $1 AND d.deleted_at IS NULL
           AND d.status IN ('PENDING', 'PROCESSING')
           AND d.classification <> 'UNKNOWN'
           AND j.id IS NULL
         LIMIT $2`,
        [tenant.id, ORPHAN_BATCH_SIZE]);
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
    const pending = await tenantQuery<{ id: string; document_id: string; requested_by: string; request_id: string | null }>(tenant.id,
      "SELECT id, document_id, requested_by, request_id FROM document_ingestion_jobs WHERE status = 'PENDING' ORDER BY created_at LIMIT 20");
    for (const job of pending.rows) {
      setImmediate(() => void processJob(job.id, {
        tenantId: tenant.id,
        documentId: job.document_id,
        requestedBy: job.requested_by,
        ...(job.request_id ? { requestId: job.request_id } : {}),
      }));
    }
  }
}
