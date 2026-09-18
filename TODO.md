# TODO — Full Roadmap

Actionable task list for the private AI platform. Status baseline: `main` after PR #4
(production-readiness hardening). This file tracks **work remaining**; for what is
already built see [docs/roadmap.md](docs/roadmap.md) (do not contradict it — this
file extends it). Check items off as they land.

Legend: `[ ]` open · `[~]` in progress · `[x]` done.

---

## P0 — Code defects (no new infra needed)

- [x] **[P0-a] Move the stream-interrupted marker into `messages.metadata`**
  Move the `[incomplete: stream ended before the model finished]` trailing-text marker
  (`STREAM_INTERRUPTED_MARKER`, `markStreamInterrupted` in
  `backend/src/ai/gateway/gateway.ts:62`) out of message bodies and into a new
  `messages.metadata JSONB` column added by migration `015_message_metadata.sql`.
  Backfill: strip the marker from existing message content into metadata on migrate.
  Keep the SSE `error` event for the live client; history readers use metadata.
  *Acceptance:* `markStreamInterrupted` no longer mutates content; interrupted streams
  are queryable via `messages.metadata`; new + updated tests in
  `backend/test/streamInterruptedMarker.test.ts` pass.

- [x] **[P0-b] SSE backpressure on `reply.raw.write()`**
  In `backend/src/chat/routes.ts` the `send()` helper (and the `: ping` heartbeat)
  ignore the boolean return of `reply.raw.write(...)`. A slow/disconnected client can
  grow the kernel + Node buffer unboundedly.
  *Acceptance:* writes respect backpressure (pause on `false`, resume on `drain`,
  with a bounded buffer cap that aborts the stream past the cap); a regression test
  simulates a slow consumer.

- [x] **[P0-c] Wrap document reclassification in a transaction**
  The relabel route in `backend/src/documents/routes.ts` runs SELECT (status guard) →
  UPDATE → DELETE chunks → `enqueueIngestion` as separate statements. Two concurrent
  relabels can interleave (double chunk delete / double enqueue).
  *Acceptance:* the status check + UPDATE + chunk DELETE run in one DB transaction
  (`SELECT … FOR UPDATE` on the document row); concurrent relabel attempts serialize
  safely; existing `documentsUpload`/`documents` tests still pass.

- [x] **[P0-d] Decide the fate of the `model:manage` permission**
  Verified via `git grep`: `model:manage` is declared in
  `backend/src/authz/permissions.ts` and seeded in `002_seed.sql` (granted to the
  AI Admin role), but no `requirePermission('model:manage')` reference exists —
  no route checks it today. (For contrast: migration `011` already removed the
  dead `tool:admin` and `user:manage`; `tenant:manage` is legitimately used at
  `backend/src/documents/routes.ts:197` for non-owner reclassification.)
  Determine whether model-registry management routes are intended to exist.
  If yes, implement those routes and gate them with `model:manage`.
  If no, remove the permission and its seeded grants via a new migration
  following the pattern of `011_remove_dead_permissions.sql`.
  *Acceptance:* no seeded permission gates zero routes; the intended model-admin
  API surface is documented in `docs/architecture-security.md`.

---

## P1 — Production readiness gates (need a real environment)

These are not optional validation work. For an internally-controlled /
CMMC-oriented deployment they are **prerequisites to making meaningful
production claims** — the gate between "hardened code" and "production-ready
platform". They were explicitly unverifiable during the hardening passes: the
code is real, but it has never run against live dependencies.

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

- [ ] **[P1-e] Backup/restore and disaster recovery validation**
  "We have backups" is not enough — the platform needs a documented and tested
  restore path. At minimum: PostgreSQL backups; restore into a clean
  environment; S3/object-storage backup strategy; database + object-store
  consistency (a restored DB must agree with the object store about which
  documents exist); documented recovery procedure; RPO/RTO targets; restore
  test; credential/secret recovery procedure (how secrets are re-issued if the
  secret manager is lost).
  *Acceptance:* a full restore drill into a clean environment succeeds and is
  documented; RPO/RTO targets recorded in `docs/deployment.md`; the date and
  result of the last successful drill are tracked going forward.

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

- [ ] **[P2-h] Model lifecycle and registry security controls**
  The model registry (`backend/src/ai/gateway/modelRegistry.ts`, the `models`
  and `model_access` tables) is already a security boundary in practice —
  approval status, `allowed_classifications`, fallback configuration. Make the
  lifecycle explicit: model approval workflow, versioning, checksum/provenance,
  source tracking, classification-based authorization, model retirement,
  model change audit trail, fallback-model approval, model configuration
  history.
  *Acceptance:* every registry mutation is audited and permission-gated
  (ties to P0-d); an unapproved or retired model can never be selected by the
  gateway; provenance is queryable per model.

- [ ] **[P2-i] Explicit egress control plane**
  Codify the security property that the platform has **no arbitrary internet
  access** (see diagram (i) in `docs/architecture.mmd`): AI Gateway →
  approved model endpoints only (`AI_PROVIDER_ALLOWED_ORIGINS`); approved
  embedding endpoints; approved tool adapters; approved malware scanner;
  everything else denied.
  *Acceptance:* deny-by-default egress tests prove no AI/tool code path can
  reach an unlisted origin; violations are blocked and audited.

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
