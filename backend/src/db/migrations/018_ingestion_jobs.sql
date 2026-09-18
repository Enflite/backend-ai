-- 018_ingestion_jobs.sql: dedicated ingestion worker pool support.
--
-- Adds the columns the worker pool in backend/src/documents/queue.ts needs:
--   idempotency_key  - client-supplied dedupe key; unique per tenant while a
--                      job carrying that key is in flight (PENDING/PROCESSING).
--   next_attempt_at  - earliest time a PENDING job may be claimed. Failed jobs
--                      are requeued with exponential backoff + jitter instead
--                      of being retried immediately.
--   cancel_requested - set by POST /documents/jobs/:id/cancel for a PROCESSING
--                      job; the worker polls it between pipeline stages and
--                      aborts cleanly (job -> CANCELED).
--
-- New job statuses:
--   QUARANTINED - attempts exhausted (INGEST_MAX_ATTEMPTS); terminal, never
--                 auto-retried, admin requeue only. Distinct from FAILED so
--                 operators can tell "gave up after N attempts" apart from
--                 "this attempt failed".
--   CANCELED    - canceled by the requesting user (PENDING job) or aborted
--                 mid-pipeline via cancel_requested (PROCESSING job).
--
-- The attempts window widens from 0..10 to 0..100 so INGEST_MAX_ATTEMPTS can
-- be raised without tripping the check constraint.

ALTER TABLE document_ingestion_jobs
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;
ALTER TABLE document_ingestion_jobs
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE document_ingestion_jobs
  ADD COLUMN IF NOT EXISTS cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;

-- Widen the status set for the worker-pool lifecycle. NOT VALID keeps this
-- instant on large tables; new/updated rows are still checked.
ALTER TABLE document_ingestion_jobs DROP CONSTRAINT IF EXISTS document_ingestion_jobs_status_check;
ALTER TABLE document_ingestion_jobs ADD CONSTRAINT document_ingestion_jobs_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED', 'QUARANTINED', 'CANCELED'))
  NOT VALID;

-- Widen the attempts window for a configurable INGEST_MAX_ATTEMPTS.
ALTER TABLE document_ingestion_jobs DROP CONSTRAINT IF EXISTS document_ingestion_jobs_attempts_check;
ALTER TABLE document_ingestion_jobs ADD CONSTRAINT document_ingestion_jobs_attempts_check
  CHECK (attempts BETWEEN 0 AND 100)
  NOT VALID;

-- Idempotency dedupe: at most one in-flight job per (tenant, key). The
-- partial predicate keeps terminal jobs from blocking later reuse of a key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingestion_jobs_idempotency
  ON document_ingestion_jobs (tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND status IN ('PENDING', 'PROCESSING');

-- Worker claim path: oldest-due PENDING job per tenant (FOR UPDATE SKIP
-- LOCKED), which the pool walks round-robin across tenants for fairness.
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_claim
  ON document_ingestion_jobs (tenant_id, next_attempt_at, created_at)
  WHERE status = 'PENDING';
