# API Reference

Base path: `/api/v1`. All endpoints return JSON unless noted. Every route
except `GET /health` and `GET /ready` requires a Bearer access token
(`Authorization: Bearer <jwt>`) plus the listed permission. Errors use the
shape `{ error: { code, message, requestId, details? } }`.

Auth model: short-lived JWT access tokens (15m) + rotating opaque refresh
tokens in the `session` cookie. See `docs/adr/010-server-side-sessions.md`.

## Health

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/health` (also at `/api/v1/health`) | none | Liveness probe |
| GET | `/ready` (also at `/api/v1/ready`) | none | Readiness: database (critical) + object storage (critical when configured) + embeddings (non-critical); `503` with per-dependency detail when a critical check fails |
| GET | `/metrics` | none in dev; 404 in production unless `METRICS_PUBLIC=true` | Prometheus-compatible RED metrics (chat, retrieval, ingestion, eval, HTTP) |

## Auth

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/auth/login` | none (10/min rate limit) | Email + password login; sets refresh cookie, returns access token |
| POST | `/auth/dev-login` | none — **only registered when `DEV_AUTH_ENABLED`** (10/min) | Passwordless dev login by email |
| POST | `/auth/refresh` | refresh cookie (20/min) | Rotate refresh token, issue new access token |
| POST | `/auth/logout` | auth | Revoke the current session |
| POST | `/auth/logout/all` | auth | Revoke all of the user's sessions |
| GET | `/auth/sessions` | auth | List the user's active sessions |
| DELETE | `/auth/sessions/:id` | auth | Revoke one session |
| GET | `/me` | auth | Current auth context (user, tenant, role, clearance) |

## Chat (streaming)

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/chat` | auth + `chat:create` (30/min) | Start a chat turn; returns a **streaming SSE** response |

At capacity, `POST /chat` (and tool execution) returns `429` with a flat
`{ error: 'busy', message, retryAfterSeconds }` body and a `Retry-After`
header — an honest "retry shortly", never a silent drop. Per-tenant (20) and
per-user (5) concurrency caps apply; see `docs/scale.md` for tuning.

Request body: `{ conversationId?, content (1–32000 chars), modelId?,
classification?, documentIds?[] }`. If `classification` is omitted, new
conversations default to `PUBLIC` for `PUBLIC`-cleared callers, otherwise
`INTERNAL`; `UNKNOWN` is rejected.

The response is `text/event-stream`, parsed client-side with `fetch()` +
manual SSE frame parsing (see ADR-003 — this is **not** `EventSource`).
Events:

- `meta` — `{ conversationId, model: { id, name }, citations, contextDropped }`
- `delta` — `{ content }` (token chunks)
- `notice` — `{ code, message, … }` (e.g. `MODEL_FAILOVER`, `TOOL_CALLS`)
- `done` — final message record
- `error` — `{ code, message, requestId }`
- `: ping` heartbeats keep the stream alive

On 401 the client performs one token-refresh retry before failing.

## Conversations

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/conversations` | auth + `conversation:read` | List the caller's conversations |
| POST | `/conversations` | auth + `chat:create` | Create a conversation |
| GET | `/conversations/:id` | auth + `conversation:read` | Conversation detail (tenant-scoped) |
| GET | `/conversations/:id/messages` | auth + `conversation:read` | Message history |
| PATCH | `/conversations/:id` | auth + `conversation:update` | Rename / update metadata |
| DELETE | `/conversations/:id` | auth + `conversation:delete` | Delete a conversation |

## Documents & ingestion

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/documents` | auth + `document:upload` (10/min, multipart) | Upload a file; validated, stored in object storage, enqueued for ingestion |
| GET | `/documents` | auth + `document:read` | List documents visible to the caller (permission-filtered) |
| GET | `/documents/:id` | auth + `document:read` | Document metadata (permission + clearance checked; audited as `DOCUMENT_ACCESS`) |
| POST | `/documents/:id/retry` | auth + `document:upload` (10/min) | Re-enqueue a `FAILED`/`QUARANTINED` document owned by the caller; `202 { status: 'PENDING', jobId }` |
| POST | `/documents/jobs/:id/cancel` | auth + `document:upload` (30/min) | Cancel a job: requester or `tenant:manage`; `PENDING` → `CANCELED` immediately, `PROCESSING` → `202` cancel-requested (worker aborts at next stage boundary) |
| POST | `/documents/jobs/:id/requeue` | auth + `tenant:manage` (30/min) | Admin requeue of a `QUARANTINED`/`FAILED` job (audited; the only way back for quarantined jobs) |
| PATCH | `/documents/:id/classification` | auth + `document:classify` (10/min) | Reclassify (destroys chunks, triggers full re-ingestion; audited) |
| DELETE | `/documents/:id` | auth + `document:delete` | Soft-delete document and its object |

Ingestion is asynchronous: jobs move `PENDING → PROCESSING → SUCCEEDED /
FAILED / QUARANTINED / CANCELED` in `document_ingestion_jobs`. Failed jobs
retry with exponential backoff + jitter up to `INGEST_MAX_ATTEMPTS`, then are
quarantined (never auto-retried). Claims are round-robin across tenants so no
tenant starves another (see `docs/scale.md`). There is no
download endpoint in this phase — document content reaches users through RAG
answers with citations.

## RAG

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/rag/search` | auth + `document:read` (30/min) | Authorized hybrid retrieval over the caller's permitted documents |

Request body: `{ query, documentIds?[], topK? }`. Authorization is applied
**inside** the retrieval query (tenant, classification allowlist from caller
clearance, `document_permissions`); see ADR-005. Returns
`{ results: [{ chunkId, documentId, documentName, content, score, page?,
section? }] }`. A query scoped to `documentIds` with zero authorized hits is
audited as `RAG_ACCESS_DENIED`.

## Tools

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/tools` | auth + `tool:use` | List tools available to the caller (with JSON schemas) |
| POST | `/tools/:name/execute` | auth + `tool:use` (30/min, 64KB body cap) | Execute a tool directly; authorized, timed-out, audited via `runToolCall` |

Direct execution is primarily for admin/debug use — the chat loop calls the
same `runToolCall` path internally.

## Models & admin

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/models` | auth + `model:use` | Models approved and permitted for the caller (already filtered by tenant, role, clearance) |
| GET | `/admin/models` | auth + `model:manage` | Full registry listing (admin fields) |
| POST | `/admin/models` | auth + `model:manage` | Register a model (enters lifecycle at `REGISTERED`) |
| PATCH | `/admin/models/:id` | auth + `model:manage` | Edit registry metadata |
| POST | `/admin/models/:id/transition` | auth + `model:manage` | Lifecycle transition `{ status }`; `PENDING_APPROVAL → APPROVED` requires the eval promotion gate to pass and records `approved_by`/`approved_at` |
| GET | `/admin/serving-defaults` | auth + `model:manage` | Per-tenant+capability serving defaults |
| PUT | `/admin/serving-defaults/:capability` | auth + `model:manage` | Set the serving model for a capability `{ modelId }` |
| GET | `/admin/models/artifacts/local` | auth + `model:manage` | **Dev only** — local Ollama artifacts |
| POST | `/admin/models/artifacts/pull` | auth + `model:manage` | **Dev only** — pull a model artifact via Ollama |

The model registry is tenant-agnostic; per-tenant serving is resolved at
request time (see ADR-006). Lifecycle states: `REGISTERED → DOWNLOADING →
VALIDATING → EVALUATING → PENDING_APPROVAL → APPROVED → CANARY → ACTIVE →
DEPRECATED → RETIRED` (plus `DISABLED`); see ADR-008.

## Eval (admin)

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/admin/eval/runs` | auth + `model:manage` | Start an eval run against a model |
| GET | `/admin/eval/runs` | auth + `model:manage` | List eval runs |
| GET | `/admin/eval/runs/:id` | auth + `model:manage` | Eval run detail + per-case results |
| GET | `/admin/eval/compare` | auth + `model:manage` | Compare two runs case-by-case |
| GET | `/admin/eval/promotion-gate` | auth + `model:manage` | Promotion gate state for `?modelId=` — why a model is blocked or cleared |

## Audit

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/audit` | auth + `audit:read` | Query audit events (`?action=`, `?limit=` ≤ 200, `?offset=`), tenant-scoped |

---

Related: `docs/adr/` (design decisions behind these endpoints),
`docs/architecture.mmd` (request flow), `docs/eval.md` (eval CLI + corpus),
`docs/inference.md` (provider topology).
