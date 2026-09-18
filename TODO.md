# TODO — Full Roadmap

Actionable task list for the private AI platform. Status baseline: `main` after
PR #16 (all six build phases complete — see "Completed phases" below). This file
tracks **work remaining**; for what is already built see
[docs/roadmap.md](docs/roadmap.md) (do not contradict it — this file extends it).
Check items off as they land.

Legend: `[ ]` open · `[~]` in progress · `[x]` done.

---

## Completed phases (historical record — do not remove)

- **[x] Phase 1 — security/correctness** (PR #6): fixed the P0 code defects below,
  hardened auth/authorization boundaries.
- **[x] Phase 2 — eval framework + assistant-quality foundation** (PR #9):
  deterministic eval corpus, five-zone system prompting, promotion gate.
- **[x] Phase 3 — private inference** (PR #11): provider abstraction, vLLM
  production path, dev-only Ollama, eval-gated model lifecycle
  (REGISTERED → … → APPROVED → CANARY → ACTIVE), per-request latency telemetry.
- **[x] Phase 4 — scale and reliability** (PR #13): in-process ingestion worker
  pool with retries/backoff/idempotency/poison-job quarantine, gateway
  concurrency fairness with honest 429s, RED metrics + trace IDs,
  dependency-aware `/ready`, `docs/recovery.md`, `scripts/verify-restore.sh`,
  `npm run loadtest:smoke` harness with documented SLOs.
- **[x] Phase 5 — enterprise** (PR #14): agentic read-only SyteLine tools
  (items, sales orders, availability, POs, work orders, BOM, customers), OIDC
  SSO, DLP scanning/redaction, retention enforcement + legal hold.
- **[x] Phase 6 — advanced AI** (PR #16): per-turn capability routing
  (`chat`/`syteline`/`coding`/`embeddings`) with audited fallback, generalized
  agentic tool loop with approval gate for destructive tools, repo-aware coding.

---

## P0 — Code defects (no new infra needed)

All resolved in Phase 1; kept here as the defect record.

- [x] **[P0-a] Move the stream-interrupted marker into `messages.metadata`**
  (migration `015_message_metadata.sql`, `backend/test/streamInterruptedMarker.test.ts`)
- [x] **[P0-b] SSE backpressure on `reply.raw.write()`**
  Writes respect backpressure (pause on `false`, resume on `drain`, bounded
  buffer cap); regression test with a slow consumer.
- [x] **[P0-c] Wrap document reclassification in a transaction**
  Status check + UPDATE + chunk DELETE run in one DB transaction
  (`SELECT … FOR UPDATE`); concurrent relabels serialize safely.
- [x] **[P0-d] Decide the fate of the `model:manage` permission**
  Resolved: model-registry management routes were implemented and are gated
  with `model:manage`; the admin API surface is documented in
  `docs/architecture-security.md`.

---

## P1 — Production readiness gates (need a real environment)

These remain **prerequisites to making meaningful production claims** — the gate
between "hardened code" and "production-ready platform". Phase 4 shipped the
harnesses and runbooks; the live runs below are still unverifiable without real
infrastructure.

- [ ] **[P1-a] Live migration run + query-plan validation**
  Run migrations `001`–`025` in order against a real PostgreSQL 16 + pgvector
  ≥ 0.7.0 instance. (PR #13 reported a clean 001→018 apply on real PG 16; that
  run predates migrations 019–025 and its evidence is not in the tree, so it
  does not count as the documented run.) Verify: clean apply from scratch,
  `ALTER EXTENSION vector UPDATE` path, HNSW index usage on `document_chunks`
  (`EXPLAIN` the tenant-scoped filtered vector query), `ef_search=200` behaves
  as documented.
  *Acceptance:* documented `EXPLAIN ANALYZE` output for the retrieval query
  committed to the repo; any missing index → new migration.

- [ ] **[P1-b] Dependency vulnerability scan**
  `npm audit --omit=dev --audit-level=high` now runs in CI (`.github/workflows/ci.yml`)
  but is intentionally non-blocking (managed registry). It has never produced a
  recorded clean-or-triaged result on this tree.
  *Acceptance:* one recorded audit run (backend + frontend) clean at
  moderate-or-higher, or triaged exceptions documented; then decide whether to
  make it blocking.

- [ ] **[P1-c] Live end-to-end integration tests**
  Exercise each real boundary with the actual service: vLLM (`/chat/completions`
  streaming), the embedding provider, MinIO/S3-compatible storage, the malware
  scanner (`MALWARE_SCAN_MODE=http`), and the SyteLine adapter
  (`getItem`, `getSalesOrder`, `getItemAvailability`, `getOpenPurchaseOrders`,
  `getWorkOrders`, `getBom`, `getCustomer`). Cover failure modes: timeout,
  malformed response, 5xx.
  *Acceptance:* a documented runbook + (where feasible) integration tests gated
  behind env flags so CI stays hermetic.

- [ ] **[P1-d] Real-provider load test**
  Harness exists: `npm run loadtest:smoke` (`backend/scripts/load-test.mjs`).
  PR #13 reported all SLOs passing against a real server + real PG; evidence is
  not in the tree and predates Phases 5–6. Re-run against staging with the real
  model provider: concurrent SSE chat streams, concurrent uploads, ingestion
  throughput. Watch for: DB pool exhaustion, SSE backpressure, queue
  head-of-line blocking on poison jobs.
  *Acceptance:* recorded p50/p95 latencies and breaking points; pool sizing
  guidance added to `docs/deployment.md`.

- [ ] **[P1-e] Backup/restore and disaster recovery validation**
  Runbook exists: `docs/recovery.md`, `scripts/verify-restore.sh`
  (`npm run verify:restore`). The restore path has never been drilled against a
  real environment.
  *Acceptance:* a full restore drill into a clean environment succeeds and is
  documented (date + result committed); RPO/RTO targets recorded in
  `docs/deployment.md`; the date and result of the last successful drill are
  tracked going forward; credential/secret recovery procedure documented.

---

## P2 — Feature phases (status after PR #16)

- [ ] **[P2-a] Dedicated ingestion worker process**
  Phase 4 shipped a durable queue with an in-process semaphore pool
  (`INGEST_WORKERS`, `FOR UPDATE SKIP LOCKED` claiming, backoff ±20% jitter,
  tenant idempotency keys, `QUARANTINED`/`CANCELED`, cancel/requeue routes).
  The queue still executes inside the single API process.
  *Remaining:* extract into a standalone worker (same codebase, separate
  entrypoint) so API replicas scale independently.
  *Acceptance:* `docker-compose.yml` (and deployment docs) run N API + M worker
  replicas; job claiming stays race-free across workers; graceful shutdown drains
  in-flight jobs.

- [ ] **[P2-b] OpenTelemetry exporter**
  Observability today is request/trace IDs, an in-memory metrics registry with
  Prometheus exposition (`GET /metrics`), TTFT/tokens-sec telemetry, and
  structured latency logs. No OTel exporter.
  *Acceptance:* traces visible in the configured collector for chat, ingestion,
  and tool calls; sampling configurable.

- [~] **[P2-c] Production tool-gateway adapters**
  The tool registry (`backend/src/tools/gateway.ts`) is real. The SyteLine
  adapter is production-grade (Phase 5: schema validation, timeouts, row caps,
  per-step audit, tests in `backend/test/sytelineTools.test.ts`, eval cases).
  No other adapters exist yet.
  *Remaining:* add further production adapters behind config, each held to the
  same bar as the SyteLine adapter.

- [x] **[P2-d] Read-only SyteLine operations** — shipped Phase 5 (PR #14):
  `getItem`, `getSalesOrder`, `getItemAvailability`, `getOpenPurchaseOrders`,
  `getWorkOrders`, `getBom`, `getCustomer` in `backend/src/tools/syteline.ts`
  with a fixture backend (`sytelineFixture.ts`) for CI, typed parameterized
  tools, bounded dependent chaining in the agentic loop, per-step audits, and
  evidence-cited diagnoses. Destructive operations remain out (see P3-b).

- [x] **[P2-e] External IdP wiring** — shipped Phase 5 (PR #14):
  OIDC login path (`backend/src/auth/oidc.ts`, `oidcRoutes.ts`; migrations
  `020_oidc_auth_requests.sql`, `023_oidc_nonce_identity.sql`), group→role
  mapping, local auth path kept; tested with a mock issuer
  (`oidc.test.ts`, `oidcRoutes.test.ts`); documented in `docs/enterprise.md`.
  Live-IdP end-to-end belongs to P1-c.

- [x] **[P2-f] DLP (data loss prevention)** — shipped Phase 5 (PR #14):
  `backend/src/dlp/` (`detectors.ts`, `hook.ts`, `streamGuard.ts`) —
  configurable patterns (cards, SSN, API keys), block/redact/audit actions,
  masking in logs and stored messages; tested (`dlp.test.ts`, `chatDlp.test.ts`).

- [x] **[P2-g] Retention enforcement + legal hold** — shipped Phase 5 (PR #14):
  `backend/src/retention/` (`purge.ts`, `routes.ts`, `scheduler.ts`;
  migrations `021_retention.sql`, `022_retention_permission.sql`) —
  per-tenant retention policies, legal-hold flags suspending deletion, audited
  purge jobs; documented in `docs/retention.md`.

- [x] **[P2-h] Model lifecycle and registry security controls** — shipped
  Phase 3 (PR #11): explicit lifecycle
  (REGISTERED → DOWNLOADING → VALIDATING → EVALUATING → PENDING_APPROVAL →
  APPROVED → CANARY → ACTIVE → DEPRECATED → RETIRED, plus DISABLED kill-switch)
  in `backend/src/ai/gateway/modelLifecycle.ts` (migration
  `017_model_lifecycle.sql`); eval-gated promotion with no bypass; every
  mutation audited and permission-gated; gateway serves only enabled CANARY /
  ACTIVE models. Phase 6 added per-tenant/per-capability serving defaults and
  routing policies (migrations 024/025).

- [~] **[P2-i] Explicit egress control plane**
  The gateway enforces `AI_PROVIDER_ALLOWED_ORIGINS` via `assertEndpointAllowed`
  (also applied at model registration), with `MODEL_ENDPOINT_DENIED` tests in
  `backend/test/gateway.test.ts` and `modelAdmin.test.ts`. Tool-adapter egress
  (e.g. SyteLine URL scheme enforcement) is being hardened in the
  post-phase review cleanup.
  *Remaining:* deny-by-default egress tests proving no AI/tool code path can
  reach an unlisted origin; violations blocked and audited.

---

## P3 — Future / out of current scope

- [ ] **[P3-a] Fine-tuning support** — dataset curation from tenant corpora,
  training-job orchestration, model versioning in the registry.
- [ ] **[P3-b] Destructive tool approvals** — Phase 6 shipped the approval
  plumbing (`approvalFor` contract + `approvedCallIds` in
  `backend/src/chat/agenticLoop.ts`): write-capable tools are never
  auto-executed. Still missing: the human-in-the-loop workflow (UI/API to
  review and approve pending calls) and any actual write-capable tools.
  (Ties to completing P2-c first.)
- [ ] **[P3-c] Multi-region deployment** — read replicas, region-pinned tenants,
  cross-region backup/restore drills.
- [ ] **[P3-d] Independent security assessment** — no document asserts
  CMMC/NIST/FedRAMP certification; infrastructure, organizational procedures,
  and third-party assessment remain required before any compliance claim.

---

## Architecture reference

End-to-end diagrams (system context, middleware pipeline, auth, chat SSE + agentic
loop, ingestion, RAG retrieval, data model, deployment topology):
[docs/architecture.mmd](docs/architecture.mmd). An AI engineer should be able to
build or extend any subsystem from those diagrams plus the referenced source files
with minimal unknowns.
