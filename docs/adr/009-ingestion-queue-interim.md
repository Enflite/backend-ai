# ADR-009: In-process durable ingestion queue (interim)

**Status:** Accepted (interim — dedicated workers planned, TODO.md P2-a)

## Context

Document ingestion (malware scan → extraction → chunking → embedding →
indexing) is long-running and must not block API requests. The durable
solution is dedicated worker processes, but the platform needs a working
pipeline now.

## Decision

- Ingestion jobs are durable rows in `document_ingestion_jobs`
  (`PENDING` → `PROCESSING` → `SUCCEEDED` / `FAILED` / `QUARANTINED`), claimed
  atomically (`UPDATE … WHERE status='PENDING' … RETURNING`) so two
  claimants can never take the same job.
- The queue executor currently runs **in-process** in the API
  (`backend/src/documents/queue.ts`), with crash recovery on boot
  (`recoverIngestionJobs`, called from `backend/src/server.ts`) and a small
  concurrency cap.
- The job table is the contract: the API owns upload/authorization/enqueue;
  the (future) dedicated worker owns long-running processing. Extracting the
  worker later must not change the table contract.

## Consequences

- Single-process throughput limits and no multi-replica safety today; one
  tenant's large document can still pressure the API process.
- The P2-a roadmap item (dedicated ingestion workers with retries,
  backoff, idempotency, poison-job handling, tenant fairness) is a planned,
  non-optional step before production scale — not a nice-to-have.
