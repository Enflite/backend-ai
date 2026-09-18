# TODO — Full Roadmap

Actionable task list for the private AI platform. Status baseline: `main` after PR #4
(production-readiness hardening). This file tracks **work remaining**; for what is
already built see [docs/roadmap.md](docs/roadmap.md) (do not contradict it — this
file extends it). Check items off as they land.

Legend: `[ ]` open · `[~]` in progress · `[x]` done.

---

## P0 — Code defects (no new infra needed)

- [ ] **[P0-a] Move the stream-interrupted marker into `messages.metadata`**
  Move the `[incomplete: stream ended before the model finished]` trailing-text marker
  (`STREAM_INTERRUPTED_MARKER`, `markStreamInterrupted` in
  `backend/src/ai/gateway/gateway.ts:62`) out of message bodies and into a new
  `messages.metadata JSONB` column added by migration `015_message_metadata.sql`.
  Backfill: strip the marker from existing message content into metadata on migrate.
  Keep the SSE `error` event for the live client; history readers use metadata.
  *Acceptance:* `markStreamInterrupted` no longer mutates content; interrupted streams
  are queryable via `messages.metadata`; new + updated tests in
  `backend/test/streamInterruptedMarker.test.ts` pass.

- [ ] **[P0-b] SSE backpressure on `reply.raw.write()`**
  In `backend/src/chat/routes.ts` the `send()` helper (and the `: ping` heartbeat)
  ignore the boolean return of `reply.raw.write(...)`. A slow/disconnected client can
  grow the kernel + Node buffer unboundedly.
  *Acceptance:* writes respect backpressure (pause on `false`, resume on `drain`,
  with a bounded buffer cap that aborts the stream past the cap); a regression test
  simulates a slow consumer.

- [ ] **[P0-c] Wrap document reclassification in a transaction**
  The relabel route in `backend/src/documents/routes.ts` runs SELECT (status guard) →
  UPDATE → DELETE chunks → `enqueueIngestion` as separate statements. Two concurrent
  relabels can interleave (double chunk delete / double enqueue).
  *Acceptance:* the status check + UPDATE + chunk DELETE run in one DB transaction
  (`SELECT … FOR UPDATE` on the document row); concurrent relabel attempts serialize
  safely; existing `documentsUpload`/`documents` tests still pass.

- [ ] **[P0-d] Resolve the orphaned `model:manage` permission**
  Verified via `git grep`: `model:manage` is declared in
  `backend/src/authz/permissions.ts` and seeded in `002_seed.sql`, but **no route
  checks it**. (For contrast: migration `011` already removed the dead `tool:admin`
  and `user:manage`; `tenant:manage` is legitimately used at
  `backend/src/documents/routes.ts:197` for non-owner reclassification.)
  *Acceptance:* either admin model-management routes are implemented and gated on
  `model:manage`, or the permission is removed via a new migration following the
  pattern of `011_remove_dead_permissions.sql`. No seeded permission may gate zero
  routes afterwards.

---

## P1 — Infrastructure validation (blocked in sandbox; needs a real environment)

These were explicitly unverifiable during the hardening passes — the code is real,
but it has never run against live dependencies.

- [ ] **[P1-a] Live migration run + query-plan validation**
  Run migrations `001`–`014` in order against a real PostgreSQL 16 + pgvector
  ≥ 0.7.0 instance. Verify: clean apply from scratch, `ALTER EXTENSION vector
  UPDATE` path, HNSW index usage on `document_chunks` (`EXPLAIN` the tenant-scoped
  filtered vector query), and that `ef_search=200` behaves as documented.
  *Acceptance:* documented `EXPLAIN ANALYZE` output for the retrieval query;
  any missing index → new migration.

- [ ] **[P1-b] Dependency vulnerability scan**
  `npm audit` was blocked by the sandbox registry (HTTP 403 `policy_denied`) and has
  never run on this tree.
  *Acceptance:* `npm audit` (backend + frontend) clean at moderate-or-higher, or
  triaged exceptions recorded; consider adding it to CI.

- [ ] **[P1-c] Live end-to-end integration tests**
  Exercise each real boundary with the actual service: vLLM (`/chat/completions`
  streaming), the embedding provider, MinIO/S3-compatible storage, the malware
  scanner (`MALWARE_SCAN_MODE=http`), and the SyteLine adapter
  (`syteline.getItem`). Cover failure modes: timeout, malformed response, 5xx.
  *Acceptance:* a documented runbook + (where feasible) integration tests gated
  behind env flags so CI stays hermetic.

- [ ] **[P1-d] Basic load tests**
  Concurrent SSE chat streams, concurrent uploads, and ingestion-queue throughput
  with `MAX_CONCURRENT_JOBS=2`. Watch for: DB pool exhaustion, SSE backpressure
  (ties to P0-b), and queue head-of-line blocking on poison jobs.
  *Acceptance:* recorded p50/p95 latencies and breaking points; pool sizing guidance
  added to `docs/deployment.md`.

---

## P2 — From docs/roadmap.md (partially / not implemented)

Quoted from the roadmap's own status section; these are the next feature phases.

- [ ] **[P2-a] Dedicated ingestion worker process**
  The ingestion queue (`backend/src/documents/queue.ts`) is durable across restarts
  but executes inside the single API process. Extract it into a standalone worker
  (same codebase, separate entrypoint) so API replicas scale independently.
  *Acceptance:* `docker-compose.yml` (and deployment docs) run N API + M worker
  replicas; job claiming stays race-free across workers; graceful shutdown drains
  in-flight jobs.

- [ ] **[P2-b] OpenTelemetry exporter**
  Observability today is request/trace IDs + structured latency logs. Add an OTel
  exporter (traces + the AI telemetry: time-to-first-token, token counts, retrieval
  stats) to a configurable backend.
  *Acceptance:* traces visible in the configured collector for chat, ingestion, and
  tool calls; sampling configurable.

- [ ] **[P2-c] Production tool-gateway adapters**
  The tool registry (`backend/src/tools/gateway.ts`) is real but the only adapter
  is the SyteLine read path. Add the planned production adapters behind config.
  *Acceptance:* each adapter has schema validation, timeouts, output caps, audit
  coverage, and tests — same bar as `syteline.getItem`.

- [ ] **[P2-d] Read-only SyteLine operations (phase 1)**
  Extend the SyteLine adapter beyond `getItem` with the read-only operations the
  business needs. Destructive operations stay out (see P3).
  *Acceptance:* operations reviewed against the threat model; no write paths.

- [ ] **[P2-e] External IdP wiring**
  `backend/src/auth/identityProvider.ts` is a boundary. Wire a real external
  identity provider (OIDC/SAML) for organizations that require it, keeping the
  local auth path for the base deployment.
  *Acceptance:* login via IdP works end-to-end; session/refresh semantics unchanged;
  documented in `docs/deployment.md`.

- [ ] **[P2-f] DLP (data loss prevention)**
  Scanning/boundary for sensitive data leaving the platform (chat outputs, document
  exports, tool results).
  *Acceptance:* policy engine integration, configurable actions (block/redact/audit),
  documented behavior — no fake "scanning".

- [ ] **[P2-g] Retention enforcement + legal hold**
  Enterprise retention policies and legal-hold workflows for documents, messages,
  and audit events (append-only audit must be reconciled with retention law).
  *Acceptance:* retention rules configurable per tenant; legal hold suspends
  deletion; covered in `docs/cmmc-nist.md`.

---

## P3 — Future / out of current scope

- [ ] **[P3-a] Fine-tuning support** — dataset curation from tenant corpora,
  training-job orchestration, model versioning in the registry.
- [ ] **[P3-b] Destructive tool approvals** — human-in-the-loop approval workflow
  for write/destructive tool calls (ties to completing P2-c/P2-d first).
- [ ] **[P3-c] Multi-region deployment** — read replicas, region-pinned tenants,
  cross-region backup/restore drills.
- [ ] **[P3-d] Independent security assessment** — per `docs/roadmap.md`, no
  document asserts CMMC/NIST/FedRAMP certification; infrastructure, organizational
  procedures, and third-party assessment remain required before any compliance
  claim.

---

## Architecture reference

End-to-end diagrams (system context, middleware pipeline, auth, chat SSE + agentic
loop, ingestion, RAG retrieval, data model, deployment topology):
[docs/architecture.mmd](docs/architecture.mmd). An AI engineer should be able to
build or extend any subsystem from those diagrams plus the referenced source files
with minimal unknowns.
