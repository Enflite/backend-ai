# API Reference

Base path: `/api/v1`. All endpoints return JSON unless noted. Every route
except `GET /health` and `GET /ready` requires a Bearer access token
(`Authorization: Bearer <jwt>`) plus the listed permission. Errors use the
shape `{ error: { code, message, requestId, details? } }`, except the
capacity `429` documented below, which intentionally uses the flat
`{ error: 'busy', message, retryAfterSeconds }` body so clients can branch
on `error === 'busy'` without knowing the rest of the error taxonomy.

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
classification?, documentIds?[], capability?, codeFiles?[] }`. If `classification` is omitted, new
conversations default to `PUBLIC` for `PUBLIC`-cleared callers, otherwise
`INTERNAL`; `UNKNOWN` is rejected. `capability` is one of `chat | syteline |
coding | embeddings | vision` and selects the capability slot for model routing
(an explicit `modelId` always wins — except on image turns, where a selected
text-only model is replaced by the vision model with a `MODEL_VISION_SWITCH`
notice); when omitted the route detects intent conservatively and defaults to
`chat`. Attaching image documents (PNG/JPEG/WebP/GIF) to `documentIds` forces
the `vision` capability for the turn: images bypass RAG (no text chunks) and
are served to the vision model as image inputs. `codeFiles` is `[{ path, content }]`
— caller-supplied repo-relative files (≤ 20 files, ≤ 200 KB each) assembled
into labeled context for coding turns; see `docs/capabilities.md` §4.

The response is `text/event-stream`, parsed client-side with `fetch()` +
manual SSE frame parsing (see ADR-003 — this is **not** `EventSource`).
Events:

- `meta` — `{ conversationId, model: { id, name }, citations, contextDropped, capability: { requested, resolved, fallbackUsed, strategy }, codeFiles: { requested, included, dropped, truncated } }`
- `delta` — `{ content }` (token chunks)
- `notice` — `{ code, message, … }` (e.g. `MODEL_FAILOVER`, `TOOL_PLAN`, `TOOL_CALLS`)
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

## Memory

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/memory` | auth + `memory:read` | List the caller's facts (most-recent first; optional `category`, `limit`, `offset`) |
| POST | `/memory` | auth + `memory:write` | Store a fact (`fact` 1–2000 chars, `category` ∈ `preference`/`fact`/`project`, optional `classification`/`source`; audited as `MEMORY_CREATE`) |
| GET | `/memory/:id` | auth + `memory:read` | One fact (audited as `MEMORY_ACCESS`) |
| PATCH | `/memory/:id` | auth + `memory:write` | Update fact text / category / classification (audited as `MEMORY_UPDATE`) |
| DELETE | `/memory/:id` | auth + `memory:write` | Delete a fact (audited as `MEMORY_DELETE`) |

Memories are strictly user-private: every query binds the caller's
`tenant_id` **and** `user_id`, so a user can only ever see or touch their own
facts — never another user's, even in the same tenant. Facts classified above
the caller's clearance are rejected (`CLASSIFICATION_DENIED`); omitted
classification defaults to the caller's clearance floor. Stored facts are
injected into the assistant's system prompt as a delimited, untrusted-data
`USER MEMORY` section (classification-filtered against the turn, secret
spans redacted, token-budgeted); see `docs/assistant.md` § User memory and
ADR-013.

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

### SyteLine read-only tools (Phase 5)

The flagship agentic surface (see `docs/syteline-vision.md`): typed,
parameterized, bounded ERP reads. Every call is authorized in application
code against the caller's permissions (each tool requires `syteline:read`
in addition to `tool:use`), audited with tenant/user/tool/args/result
size, timeout-bounded (`SYTELINE_TIMEOUT_MS`), and result-size-capped
(`SYTELINE_MAX_ROWS`; truncated lists carry `truncated: true`). No
free-form SQL; the model never touches SyteLine directly. Dependent
chaining (output of one call feeding the next) runs inside the generalized
agentic loop (`backend/src/chat/agenticLoop.ts`; see `docs/capabilities.md`
§3), which any tool family can use, under its iteration budget
(`AI_MAX_TOOL_ITERATIONS`).

| Tool | Purpose |
|---|---|
| `syteline.getItem` | Item record by item + site |
| `syteline.getSalesOrder` | Sales order header + lines by order number, or open orders by customer |
| `syteline.getItemAvailability` | On-hand / allocated / available-to-promise + recent inventory transactions |
| `syteline.getOpenPurchaseOrders` | Open POs for an item, with promised dates, receipt status, supplier |
| `syteline.getWorkOrders` | Work orders by number or by built item, with status and schedule dates |
| `syteline.getBom` | BOM explosion for a manufactured item (components, qty-per, lead time) |
| `syteline.getCustomer` | Customer record by customer number |

### SyteLine form-project tools

Form-customization automation (port of `Enflite/Form-Project-Templates`):
the AI scaffolds a form project, builds `<Form>.xml` from the original
export (text-level, byte-for-byte: UTF-8 with BOM, CRLF), generates the
docs and implementation-plan deck, and opens the review PR. Each tool
requires `syteline:forms` in addition to `tool:use`. The AI works
Git/project files only — SyteLine, UET, and FormSync steps are numbered
human runbook steps in the generated docs. Form-project PRs are never
merged by automation.

| Tool | Purpose |
|---|---|
| `syteline.form_start_project` | Scaffold a new form project (port of `new-project.sh`) |
| `syteline.form_add_field` | Build `<Form>.xml` from the TRN original; stops when TRN/production originals differ; `checkOnly` verifies deterministic rebuild |
| `syteline.form_write_docs` | Write README, seven-phase Implementation-Plan, troubleshooting, original/README |
| `syteline.form_build_deck` | Generate `plan/deck.config.js` and build the implementation-plan PPTX |
| `syteline.form_open_pr` | Create the repo, push, and open the review PR (never merges) |

### SyteLine UI automation tools

Agentic browser driving of the SyteLine web client (see ADR-019 and
`docs/syteline-ui.md`): the assistant logs in as the user, navigates to
forms, fills fields, clicks buttons, and reads results back. Every tool
requires `syteline:ui` (Admin / AI Admin only — never the User role) in
addition to `tool:use`, and the whole family is behind the
`SYTELINE_UI_ENABLED` kill switch (default `false`): tools fail fast
when the feature is off. Privacy routing treats the family as
`syteline.*` — never offered on cloud turns when customer or finance
categories are enforced (see `docs/privacy-routing.md`).

`destructive:true` tools never auto-execute: the agentic loop's
explicit-confirmation gate applies, with no bypass for UI writes.
Real Playwright behavior is **REQUIRES REAL SYTELINE**; FakeDriver
behavior is **VALIDATED IN CI**.

| Tool | Destructive | Purpose |
|---|---|---|
| `syteline.ui.startSession` | no | Acquire the user's browser session (≤1 per user) and log in to `SYTELINE_UI_URL`; explicit user request only |
| `syteline.ui.gotoForm` | no | Navigate to a form via the SyteLine form URL convention; `formName` must match `^[A-Za-z0-9_]+$` |
| `syteline.ui.readScreen` | no | Return the ARIA/accessible snapshot text of the current screen |
| `syteline.ui.screenshot` | no | Store evidence server-side (tenant-scoped); returns `{ evidenceId, capturedAt }` — raw pixels never reach the model |
| `syteline.ui.fillField` | **yes** | Fill a field by accessible label: `{ label, value }` |
| `syteline.ui.clickButton` | **yes** | Click a button by accessible label (may submit/save): `{ label }` |
| `syteline.ui.runTaskPlan` | **yes** | Execute a bounded (max 25 steps), zod-validated task-plan DSL: ordered steps of `{ action: 'gotoForm', form }`, `{ action: 'fillField', label, value }`, `{ action: 'clickButton', label }`, `{ action: 'readScreen' }`, `{ action: 'assertText', text }` — sequential, stops at first failure, per-step outcomes; each step audit-logged with argument keys only |
| `syteline.ui.endSession` | no | Close the browser and write the session-summary audit |
| `syteline.ui.listSessions` | no | List the tenant's active UI sessions (`sessionId`, `userId`, `startedAt`, `idleMs`, `state`) — metadata only, never secret material |
| `syteline.ui.saveCredentials` | **yes** | Save/rotate the caller's own SyteLine credentials (`userId` from auth context, never arguments); `secretParams: ['password']` |
| `syteline.ui.deleteCredentials` | **yes** | Revoke the caller's stored credentials |
| `syteline.ui.listCredentials` | no | `username` / `label` / `updatedAt` only — never secret material |

`SYTELINE_CREDENTIAL_SAVED` / `SYTELINE_CREDENTIAL_DELETED` /
`SYTELINE_UI_LOGIN` audit events carry the username only, never the
secret.

#### `secretParams` redaction

`ToolDefinition` supports an optional `secretParams?: string[]`. When
set, those parameter keys are persisted as `"[REDACTED]"` in
`tool_executions` **and** in audit metadata — secrets in tool arguments
never reach any store in clear. `syteline.ui.saveCredentials` declares
`secretParams: ['password']`. The redaction happens in
`runToolCall` (`backend/src/tools/gateway.ts`); callers and the model
see the normal arguments, only the persisted copies are redacted.

### SyteLine task-agent tools

AI agents that complete SyteLine tasks for the requester (see ADR-020
and `docs/syteline-ui.md` "Task agents"): plain-language intake —
"create this PO", "check why this order is late and update it", "run
the morning buyer routine" — into the tenant-scoped `syteline_tasks`
queue, executed by a server-side runner that plans (model-generated,
zod-validated `runTaskPlan` DSL), drives the SyteLine web client as
the requester through the `syteline.ui.*` engine, and reports back with
evidence. Statuses (`assigned` / `in_progress` / `completed` /
`blocked` / `cancelled`) are the kanban board's data model —
`syteline.task.list` is the board's API.

Every tool requires `syteline:ui` (Admin / AI Admin only — never the
User role) in addition to `tool:use`; the whole family rides the
`SYTELINE_UI_ENABLED` kill switch (default `false`), and the runner
itself additionally requires `SYTELINE_TASK_RUNNER_ENABLED=true`
(default `false` — tasks stay `assigned` and nothing runs when off).
Privacy routing treats the family as `syteline.*` — never offered on
cloud turns when customer or finance categories are enforced (see
`docs/privacy-routing.md`).

`autoApproveWrites: true` on `syteline.task.create` is the human's
explicit, task-scoped write confirmation: the task's write steps
execute without further per-step prompts. The default `false` runs
read-only reconnaissance (`gotoForm` / `readScreen`), then reports a
proposed write plan and marks the task `blocked` with
`blockedReason: 'awaiting-write-approval'`. An agent always executes
as the task's requester (their own saved credentials) — never as
someone else. Real browser behavior is **REQUIRES REAL SYTELINE**;
task lifecycle, atomic claim, planning, and the approval gate are
**VALIDATED IN CI**.

| Tool | Destructive | Purpose |
|---|---|---|
| `syteline.task.create` | no | Create an `assigned` task: `{ title, goal, autoApproveWrites? }` (default `false`); ownership (`requesterUserId`) from the auth context, never from arguments |
| `syteline.task.list` | no | List the requester's tasks (or, for admins, the tenant's); optional `status` filter |
| `syteline.task.get` | no | Full task record: status, zod-validated plan, per-step log with `{ action, status, evidenceIds[] }`, `resultSummary` / `blockedReason` |
| `syteline.task.cancel` | **yes** | Cancel a task (ends work in flight); requester or admin only |
| `syteline.task.requeue` | no | Re-queue a `blocked` task to `assigned` (clears `blockedReason`); `{ taskId, approveWrites? }` — `approveWrites: true` is the task-bounded write approval for a parked write plan; requester or admin only |

Per-step screenshot evidence is captured server-side (tenant-scoped) and
referenced by id in the step log — the model only ever sees ids. The
frontend renders the actual pixels through a dedicated REST endpoint:

`GET /api/v1/syteline-tasks/:id/evidence/:evidenceId` → `200` with
`content-type: image/png` (or `404`). Same access posture as the tools:
auth + `syteline:ui`, fail-fast `403 FEATURE_DISABLED` while
`SYTELINE_UI_ENABLED=false`, requester-or-admin visibility — anything else
is `404`, never `403`, so task existence never leaks. The evidence id must
belong to the task's steps (strict UUID shape); the access audit carries
identifiers only — evidence bytes are never logged.

Task audit events: `SYTELINE_TASK_CREATED` / `SYTELINE_TASK_STARTED`
/ `SYTELINE_TASK_STEP` (argument keys only, never values) /
`SYTELINE_TASK_COMPLETED` / `SYTELINE_TASK_BLOCKED` (reason) /
`SYTELINE_TASK_CANCELLED`. Same secret hygiene as the UI family:
usernames and task ids in clear are fine; passwords and field values
never.

### APS exception-resolution tools

Deterministic tool substrate for the APS exception-resolution flows
(see `docs/aps-exception-flows.md` and `flows/aps-exception-analysis.flow.json`
/ `flows/aps-exception-verify.flow.json`): the exception report is
parsed from an uploaded xlsx, rows are normalized to canonical
planning issues, SyteLine evidence is collected per issue, a
deterministic rules engine computes findings, and issue snapshots are
recorded for before/after verification. `aps.parseExceptionReport`
requires `document:read` (and fails closed when the document's
classification exceeds the caller's clearance); everything else
requires `syteline:read` in addition to `tool:use`. All tools are
read-only and non-destructive — the planner executes all SyteLine
writes by hand. Real SyteLine/document behavior is
**REQUIRES REAL INFRASTRUCTURE**; the rules engine, normalization,
and snapshot/compare/close lifecycle are **VALIDATED IN CI**.

| Tool | Purpose |
|---|---|
| `aps.parseExceptionReport` | Parse an uploaded exception-report xlsx (tenant-scoped document) into `{ sheetName, columns, rows, rowCount }` |
| `aps.normalizeExceptionRows` | Map report headers to canonical planning issues `{ rowIndex, item?, orderNumber?, customerNumber?, workOrderNumber?, dueDate?, quantity?, exceptionText? }` (200-issue cap, `truncated` flag) |
| `aps.collectSupplyFacts` | Per-issue supply evidence via the SyteLine adapter (availability + open POs); per-row errors never fail the batch |
| `aps.collectDemandFacts` | Per-issue demand evidence (open sales orders by order or customer number) |
| `aps.evaluateDueDates` | Per-issue schedule evidence (work orders by number or built item) |
| `aps.applyRules` | Deterministic APS rules engine: `PAST_DUE_OPEN_ORDER`, `LATE_INBOUND_SUPPLY`, `MATERIAL_SHORTAGE`, `UNCOVERED_DEMAND`, `EXCESS_SUPPLY` → severity-tagged findings |
| `aps.recordSnapshot` | Record an issue snapshot (issues + classifications + findings + root cause + recommendation + SyteLine steps); `""` issue id creates a new issue |
| `aps.compareSnapshots` | Compare the latest snapshot against a new report → `{ resolved, resolvedCount, unresolvedCount, details }` |
| `aps.closeIssue` | Close a resolved issue; called with `resolved=false` it performs no state change (fall-through-safe by flow design) |
| `aps.getIssue` | Fetch an issue with its latest snapshot (planner handoff) |

## SyteLine Form AI Agent

The **SyteLine Form AI Agent** is Runtype-style dispatch over the
Form-Project-Templates workflow (see ADR-021 and
`docs/form-customizations.md`): a person or system POSTs a request —
five inputs (current form `.xml`, IDO-properties CSV, SQL-columns CSV,
instruction list, optional attachments) — and the backend AI runs the
whole template workflow server-side — scaffold the
form project, record the TRN/production FormSync rollback copies,
build `<Form>.xml` from the TRN original (UET-only `Uf_ENF_*` fields,
purple highlighting, byte-preserved UTF-8/BOM/CRLF), write the
implementation plan and deck, and open a **review PR**. Form-project
PRs are **never** auto-merged — the merge is always a human decision.

All endpoints require auth + `syteline:forms` (Admin / AI Admin only —
never the User role). The whole family is behind the
`FORM_CUSTOMIZATION_API_ENABLED` kill switch (default `false` —
`403 FEATURE_DISABLED` when off), and the runner additionally requires
`FORM_CUSTOMIZATION_RUNNER_ENABLED=true` (default `false` — requests
stay `requested` and nothing runs when off). Privacy routing treats
the family as `syteline.*` — never offered on cloud turns when customer
or finance categories are enforced (see `docs/privacy-routing.md`).

Request lifecycle (the kanban data model for the SyteLine Form AI
Agent):
`requested → in_progress → awaiting_review → completed`, with
`requested → in_progress → blocked` and `(any non-terminal) →
cancelled`. `awaiting_review` is the agent's terminal state (work done,
PR open, completion report attached); `completed` is reached only when
a human merges the PR. The request carries Jake's five-input contract
(current form `.xml`, IDO-properties CSV, SQL-columns CSV, instruction
list, optional attachments — multipart or JSON-inline); the SOP
knowledge is baked into the agent, not re-explained per request.
Backup-first is enforced by the agent's baked-in SOP: input 1 is the
TRN original, and the production FormSync export arrives as an
attachment (`*.production.original.xml`) or the request blocks with
`missing-production-original`; TRN/PRD drift blocks with
`trn-prd-drift`. TRN import, UET setup, staging checks,
launch-to-production, and rollback stay numbered human runbook steps
in the generated implementation plan — the API automates the build,
not the go-live.

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/form-customizations` | auth + `syteline:forms` (10/min) | Create a request from the five-input contract: multipart file parts (`formXml`, `idoPropertiesCsv`, `sqlColumnsCsv`, `attachments[]`) or JSON-inline equivalents, plus `formName`, `title`, `instructions[]`; `202 { id, status: 'requested' }` — per-part validation (`400 VALIDATION_ERROR` names the failing part) |
| GET | `/form-customizations/:id` | auth + `syteline:forms` | Full request record: status, step log, `resultSummary` / `blockedReason` + `blockedDetail`, and on `awaiting_review` the `evidence` completion report (`repoUrl`, `prUrl`, `<Form>.xml` and deck artifacts, recorded originals with SHA-256 prefix, `openItems`, `assumptions`) |
| GET | `/form-customizations` | auth + `syteline:forms` | List the requester's (or, for admins, the tenant's) requests; optional `status` filter — the kanban-board query for the SyteLine Form AI Agent |
| POST | `/form-customizations/:id/cancel` | auth + `syteline:forms` | Cancel a request (ends work in flight); requester or admin only; terminal states return `409 REQUEST_ALREADY_TERMINAL` |

Request audit events: `FORM_CUSTOMIZATION_REQUESTED` /
`FORM_CUSTOMIZATION_STARTED` / `FORM_CUSTOMIZATION_STEP` (step names
only) / `FORM_CUSTOMIZATION_BLOCKED` (reason) /
`FORM_CUSTOMIZATION_AWAITING_REVIEW` (repo + PR urls) /
`FORM_CUSTOMIZATION_MERGED` (human actor) /
`FORM_CUSTOMIZATION_CANCELLED`.

## APS Planning Agent

The **APS Planning Agent** is "your AI planner for SyteLine APS":
a planner uploads an APS exception-report workbook and the backend
drives the sibling-owned `aps-exception-analysis` /
`aps-exception-verify` flows through the Flows platform (see
`docs/aps-planning-agent/contracts.md` for the seam), reporting
analyses, issue snapshots, and per-row compare verdicts. **V1 is
read-only vs SyteLine** — the planner executes SyteLine steps by hand;
nothing here writes to SyteLine, uses UI automation, or stores SyteLine
logins. V1 covers one export type (Exception Report) and five exception
types (Move In Rcpt, Move Out Rcpt, Rcpt Not Needed, Rcpt Projected
Late, Expedited N Days).

All endpoints require auth + `aps:plan` (granted to every role under the
all-permissions posture; seeded by migration 037). The whole family is
behind `APS_PLANNING_ENABLED` (default `true` — V1 is read-only;
`403 FEATURE_DISABLED` when off). Privacy routing treats uploaded
exports as proprietary/finance: the agent-judgment seam carries
aggregates only, never full report rows, to cloud models (see
`docs/privacy-routing.md`).

Intake reuses the documents pipeline (malware scan, classification, S3)
via the shared `documents/intake.ts` path — the workbook is tagged
`exportType: EXCEPTION_REPORT` on the analysis record, never by a second
uploader. Because SyteLine export layouts vary by version/site, the
column mapping is confirmed per upload (`POST
/aps/analyses/:id/column-map`); only `item` and `exceptionText` are
required.

Analysis lifecycle:
`intake → analyzing → awaiting-planner → verifying → resolved |
still-open`, with `analyzing/verifying → blocked` when the pipeline run
fails. `intake → pending-substrate` is the honest waiting state while
the `aps-exception-analysis` flow is not yet published on the tenant
(the .flow.json ships in the repo; the live alias is per-tenant) — the
analysis is recorded and runs once the pipeline is published. `POST
/aps/analyses/:id/retry` re-attempts the substrate start idempotently
after the tenant publishes the flows (see
`docs/aps-planning-agent/enablement.md`).
`(any non-terminal) → cancelled`.

Snapshot compare (`GET /aps/snapshots/compare`) emits per-row verdicts
`resolved | still-open | worsened | new` using the stable identity key
`type|item|supplyId|demandId` (lowercased) with a documented fallback
chain (sibling composite key `item|orderNumber|workOrderNumber|dueDate`,
then `rowIndex`); `worsened` fires on a severity-rank rise or a growing
`daysLate` evidence field. This is the row-level view; the sibling's
`aps.compareSnapshots` tool answers the issue-level verify-loop
question ("is every baseline row gone?") — see
`docs/aps-planning-agent/contracts.md` for the mapping. Snapshots live
inside the sibling's issue documents, so the snapshot endpoints take
`issueId`.

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/aps/analyses` | auth + `aps:plan` + `document:upload` (10/min) | Intake: multipart workbook (`report` file part, ≤10 MB, `.xlsx`/`.xls`/`.csv`) or JSON `{ documentId, site?, issueId? }`; `202 { id, status }` — runs the workbook through the documents pipeline and invokes `aps-exception-analysis` by name (`pending-substrate` while the flow is unpublished on the tenant) |
| GET | `/aps/analyses` | auth + `aps:plan` | List the requester's (or, for `tenant:manage`, the tenant's) analyses; optional `status` filter |
| GET | `/aps/analyses/:id` | auth + `aps:plan` | Analysis detail (requester or admin); status refreshed from the pipeline run when mid-flight |
| POST | `/aps/analyses/:id/column-map` | auth + `aps:plan` | Confirm/override the workbook column mapping (`{ columns: { canonical: header }, confirmed }`); requires `item` + `exceptionText` |
| POST | `/aps/analyses/:id/verify` | auth + `aps:plan` + `document:upload` (10/min) | Trigger verification against a newer report (multipart or `documentId`); invokes `aps-exception-verify`; requires a recorded `issueId`; `202 { id, status: 'verifying' }` |
| POST | `/aps/analyses/:id/cancel` | auth + `aps:plan` | Cancel an analysis (ends work in flight); terminal states return `409 ANALYSIS_TERMINAL` |
| POST | `/aps/analyses/:id/retry` | auth + `aps:plan` (10/min) | Re-attempt the substrate start for an analysis waiting in `pending-substrate` (e.g. after the tenant publishes `aps-exception-analysis`); re-uses the stored intake inputs. Idempotent: the status moves out of `pending-substrate` only via an atomic claim, so a repeated or concurrent retry never starts a second flow run. `202 { id, status: 'analyzing', retried: true, flowRunId }` on start; `202 { id, status: 'pending-substrate', retried: false }` while the pipeline is still unpublished; `200 { retried: false }` when the start already happened; `409 ANALYSIS_TERMINAL` / `ANALYSIS_NOT_RETRYABLE` otherwise |
| POST | `/aps/issues/:issueId/judgment` | auth + `aps:plan` (10/min) | Standalone agent judgment (the REST trigger for `agentJudgment.ts`): `{ kind: 'explain' \| 'prioritize' \| 'recommend', summaries?: [...] }`. When `summaries` is omitted they are derived server-side from the issue's latest recorded snapshot as aggregates only (id, type, severity, item, daysLate — never full report rows). The model's decision is schema-validated before it is returned. `200 { issueId, kind, judgmentRef, decision }`; `502 JUDGE_FAILED` when no judge is servable. This is the chat-context seam — it does not duplicate the flow's pipeline agent steps (classify, root-cause, recommendation, syteline-steps) |
| GET | `/aps/snapshots?issueId=` | auth + `aps:plan` | The issue's snapshots, newest first (row counts, no row payloads) |
| GET | `/aps/snapshots/:snapshotId?issueId=` | auth + `aps:plan` | One snapshot with its normalized rows |
| GET | `/aps/snapshots/compare?base=&other=&issueId=` | auth + `aps:plan` | Per-row `resolved \| still-open \| worsened \| new` verdicts with evidence-carrying rows and a summary |

SyteLine procedure guidance (`procedures.ts`) ships `verified: false`
with `needsConfirmation` text until validated against documentation —
the module never invents a form, tab, field, button, or workflow.

Request audit events: `APS_ANALYSIS_REQUESTED` /
`APS_COLUMN_MAP_CONFIRMED` / `APS_ANALYSIS_VERIFY_REQUESTED` /
`APS_SNAPSHOTS_COMPARED` / `APS_ANALYSIS_CANCELLED` /
`APS_ANALYSIS_RETRY_STARTED` / `APS_ANALYSIS_RETRY_SKIPPED` /
`APS_JUDGMENT_REQUESTED`.

## Flows

Deterministic, versioned pipelines — versioned runbooks as
config-as-code (see ADR-022 and `docs/flows.md`). A flow is a named
step graph stored as `flows/<name>.flow.json` in the repo
(PR-reviewed), published as an immutable version, and executed by a
server-side runner. Step kinds: `tool` (registered platform tool via
the tool gateway, with the run requester's auth — each tool's own
permission check applies; destructive tools need `confirmWrites:
true` on the run request), `subflow` (another flow, by `version` or
`alias`), `agent` (bounded LLM escalation; output must validate
against `outputSchema`), `condition` (deterministic branch, no LLM).
Templates (`{{inputs.x}}`, `{{steps.<id>.output.<path>}}`) resolve
strictly — an unknown path fails the step with
`TEMPLATE_RESOLUTION_ERROR`; no arbitrary code in templates.

Definition management requires `flows:manage` (Admin / AI Admin
only); runs require `flows:run` (run, poll, stream, cancel). The whole
family is behind the `FLOWS_ENABLED` kill switch (default `false` —
`403 FEATURE_DISABLED` when off), and the runner additionally requires
`FLOW_RUNNER_ENABLED=true` (default `false` — runs stay `queued` and
nothing executes when off).

Run lifecycle (the kanban data model for flows):
`queued → running → completed | blocked | cancelled`.
Stop-on-first-failure (`onError: "stop"`, the default) marks the run
`blocked` with a reason, unless the failed step set
`continueOnError: true`.

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/flows` | auth + `flows:manage` | Create or update a flow definition (`name` must match `^[a-z0-9-]+$`); the definition is validated against the flow schema |
| GET | `/flows` | auth + `flows:manage` | List flow definitions with their versions and alias pointers |
| GET | `/flows/:name` | auth + `flows:manage` | One definition: current draft, published versions, and the alias → version → hash chain |
| DELETE | `/flows/:name` | auth + `flows:manage` | Delete a definition (only when no alias points at any of its versions) |
| POST | `/flows/:name/versions` | auth + `flows:manage` | Publish the current definition as an immutable version: `{ number, definitionHash, publishedBy, publishedAt }` |
| GET | `/flows/:name/versions` | auth + `flows:manage` | List published versions (newest first) |
| POST | `/flows/:name/alias` | auth + `flows:manage` | Move an alias (default `live`) to a version: `{ alias?, version }`; requires `If-Match: <revision>` (compare-and-swap) — stale revision returns `412` |
| POST | `/flows/ensure` | auth + `flows:manage` | Converge `flows/*.flow.json` from the repo into the tenant's `flows` registry (the config-as-code deploy path) |
| GET | `/flows/:name/pull` | auth + `flows:manage` | Export a definition out of the registry (diff registry state against the repo) |
| POST | `/flows/:name/runs` | auth + `flows:run` | Start a run: `{ inputs, version? \| alias? ("live" default), confirmWrites? (default false), sync? (default false) }`; async `202 { runId }` by default — `sync: true` waits up to a server-side cap, then falls back to `202`. `Idempotency-Key` header: a repeated request returns the existing run; same key with a different body returns `409` |
| GET | `/flows/runs` | auth + `flows:run` | List runs; optional `status` filter (`queued` / `running` / `completed` / `blocked` / `cancelled`) — the kanban-board query for flows |
| GET | `/flows/runs/:runId` | auth + `flows:run` | Run detail: status, version + definition hash, step log with per-step status/timestamps/evidence, `outputs` or `blockedReason` |
| GET | `/flows/runs/:runId/events` | auth + `flows:run` | SSE stream of run events (`text/event-stream`; not `EventSource`) |
| POST | `/flows/runs/:runId/cancel` | auth + `flows:run` | Cancel a run (ends work in flight); terminal states return `409 RUN_ALREADY_TERMINAL` |

Every step is audit-logged with evidence (same discipline as the
ADR-020 task runner). Privacy routing treats flows like the other
SyteLine-adjacent surfaces: a flow driving `syteline.*` tools is never
offered on cloud turns when customer or finance categories are
enforced (see `docs/privacy-routing.md`) — the tool-level checks
inherit automatically through the gateway.

## Schedules

Cron-triggered flow runs — the daily-SOP engine (see ADR-023 and
`docs/schedules.md`). A schedule fires a named flow on a timetable:
`{ name, title, target: { flow, version? | alias? }, trigger: {
cron, timezone }, inputs?, confirmWrites? (default false), enabled?
(default true), runAsUserId }`. A schedule never runs tools directly —
it creates a **flow run** with the schedule's inputs, the schedule's
write approval, and a `scheduleRef: { scheduleName, tickISO }` tying
the run back to the tick that fired it, so scheduled runs appear in
`GET /flows/runs` and the kanban "what did the AI do today" view.

Target resolution happens **at fire time** (`alias: "live"` default,
or a pinned `version`). `runAsUserId` is re-resolved live at every
tick: a demoted or deactivated owner means the tick is **skipped**
(fail closed) and audited — a run never fires with stale powers.
`confirmWrites: true` on the schedule **is** the scoped human approval
covering writes in its fired runs (recorded in
`SCHEDULE_CREATED`/`SCHEDULE_UPDATED` with the acting admin's
identity); default `false` keeps scheduled runs read-only/recon, and
a destructive step blocks per tool policy. Ticks are claimed atomically
(compare-and-swap on `nextRunAt`, one claimer wins), fire at most once
(idempotency key `sched:<id>:<tickISO>`), and are never caught up: a
missed tick is skipped, `nextRunAt` always advances past now.

Management requires `schedules:manage` (create/update/delete/pause/
resume); list/view/`run-now`/runs/stats require `schedules:run`.
(Current posture, Jake 2026-10-02: every role holds every permission;
checks stay enforced.) The whole family is behind
the `SCHEDULES_ENABLED` kill switch (default `false` — `403
FEATURE_DISABLED` when off, and the sweeper claims no ticks). Stats
are derived from `flow_runs` (no separate ledger), so they always
reflect the run history they summarize.

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| POST | `/schedules` | auth + `schedules:manage` | Create a schedule: `name` (`^[a-z0-9-]+$`), `title`, `target` (`{ flow, version? \| alias? }`), `trigger` (`{ cron, timezone }` — 5-field cron, Vixie semantics, IANA timezone), `inputs` (must satisfy the target flow's required inputs), `confirmWrites?` (default `false`), `enabled?` (default `true`), `runAsUserId` (same-tenant active user); `201` with the schedule incl. `nextRunAt` (ISO) |
| GET | `/schedules` | auth + `schedules:run` | List schedules: name, title, enabled, `nextRunAt`, target flow, last tick state |
| GET | `/schedules/:name` | auth + `schedules:run` | Full schedule: definition, trigger, `inputs`, `nextRunAt`, last tick state |
| PUT | `/schedules/:name` | auth + `schedules:manage` | Update title/target/trigger/inputs/`confirmWrites`/`enabled`/`runAsUserId`; changing the cron or timezone recomputes `nextRunAt` |
| DELETE | `/schedules/:name` | auth + `schedules:manage` | Delete the schedule (fired runs stay in `flow_runs`; derived stats freeze at last values) |
| POST | `/schedules/:name/pause` | auth + `schedules:manage` | Pause: `enabled=false`, no ticks claimed while paused |
| POST | `/schedules/:name/resume` | auth + `schedules:manage` | Resume: `enabled=true`, `nextRunAt` recomputed from now — no catch-up backlog |
| POST | `/schedules/:name/run-now` | auth + `schedules:run` | Fire immediately outside the timetable with the schedule's target/inputs/`confirmWrites`/`runAs`; the run carries a `scheduleRef`; does **not** move `nextRunAt` |
| GET | `/schedules/:name/runs` | auth + `schedules:run` | Runs this schedule fired (the `scheduleRef` filter over flow runs), newest first; optional `status` filter — the overnight-failure triage view |
| GET | `/schedules/:name/stats` | auth + `schedules:run` | Derived from `flow_runs`: counts by status (all-time + trailing 30 days), `totalRuns`, `lastRunAt`, `lastRunId`, `lastTickStatus`, `nextRunAt`, `enabled` |

Schedule audit events: `SCHEDULE_CREATED` / `SCHEDULE_UPDATED`
(`confirmWrites` changes named with the acting admin) /
`SCHEDULE_DELETED` / `SCHEDULE_PAUSED` / `SCHEDULE_RESUMED` /
`SCHEDULE_TICK_SKIPPED` (reason: `runas-invalid`,
`no-live-version`, `disabled`, `dst-gap`) / `SCHEDULE_RUN_FIRED`
(`runId`, `tickISO`). Every fired run is audit-logged with the same
per-step discipline as flow runs. Privacy routing treats schedules
like flows: a schedule firing a `syteline.*` flow is never offered
on cloud turns when customer or finance categories are enforced
(see `docs/privacy-routing.md`) — the tool-level checks inherit
through the gateway.

## Repositories & code search

Multi-repo code indexing for coding turns (see `docs/repo-indexing.md`).
Admins register git repositories per tenant; the backend clones, chunks,
embeds, and indexes them. Chat models then use `repo.search` /
`repo.readFile` (each requires `repo:read` in addition to `tool:use`) to
find and read code with repo/path/commit provenance. Registration, sync,
and deletion require `repo:manage`.

| Method | Path | Purpose |
|---|---|---|
| GET | `/repos` | List the tenant's registered repos with sync state |
| POST | `/repos` | Register a repo: `{ name, gitUrl }` or `{ name, localPath }` (exactly one) |
| GET | `/repos/discover` | List the `GITHUB_ORG` repos visible to `GITHUB_TOKEN`, flagged `registered` |
| POST | `/repos/import` | Register every not-yet-registered org repo at once (does not sync) |
| GET | `/repos/:id` | One repo's sync state |
| POST | `/repos/:id/sync` | Clone/fetch + reindex one repo (202; poll GET for completion) |
| POST | `/repos/sync` | Sync all registered repos, or one by `{ repo: name }` (202) |
| DELETE | `/repos/:id` | Delete a repo and its index |

| Tool | Purpose |
|---|---|
| `repo.search` | Semantic code search: `{ query, repo?, topK? }`; hits carry repo, path, commit SHA, snippet |
| `repo.readFile` | Exact indexed file content: `{ repo, path }`; path is confined to the repo |

## Retention & legal hold (Phase 5c)

All endpoints require the `retention:manage` permission (Admin, Security Admin).

| Method | Path | Purpose |
|---|---|---|
| GET | `/retention/policy` | Per-tenant overrides + effective retention policy |
| PUT | `/retention/policy` | Upsert overrides (`conversationsDays`, `messagesDays`, `auditEventsDays`; nullable) |
| POST | `/retention/conversations/:id/legal-hold` | `{ hold: boolean }` — exempt a conversation (+ its messages) from purging |
| POST | `/retention/audit-events/:id/legal-hold` | `{ hold: boolean }` — exempt an audit row from purging |

The purge runs in-process every `RETENTION_PURGE_INTERVAL_HOURS` (see
`docs/enterprise.md`); every purge and hold change is audited.

## Models & admin

| Method | Path | Auth / Permission | Purpose |
|---|---|---|---|
| GET | `/models` | auth + `model:use` | Models approved and permitted for the caller (already filtered by tenant, role, clearance); always includes the tenant default model (default-open serving) |
| GET | `/providers` | auth + `model:use` | Provider availability for the one-tap switcher: always lists all three groups — `enflite` (always configured), `claude`, `openai` — with `label`, `tagline`, `dataResidency`, `residencyNote`, `configured`, `enabled`, and an admin `hint` for unconfigured providers (marked `configured: false`, never hidden) — never includes keys or key material |
| GET | `/admin/models` | auth + `model:manage` | Full registry listing (admin fields) |
| POST | `/admin/models` | auth + `model:manage` | Register a model (enters lifecycle at `REGISTERED`) |
| PATCH | `/admin/models/:id` | auth + `model:manage` | Edit registry metadata |
| POST | `/admin/models/:id/transition` | auth + `model:manage` | Lifecycle transition `{ status }`; `PENDING_APPROVAL → APPROVED` requires the eval promotion gate to pass and records `approved_by`/`approved_at` |
| POST | `/admin/models/:id/access` | auth + `model:manage` | Set explicit per-principal access `{ userId \| roleId, revoked }` (audited; `revoked: true` is the only way to deny the default model) |
| DELETE | `/admin/models/:id/access` | auth + `model:manage` | Clear the explicit access row for a principal (audited; returns to the default-open default) |
| GET | `/admin/serving-defaults` | auth + `model:manage` | Per-tenant+capability serving defaults |
| PUT | `/admin/serving-defaults/:capability` | auth + `model:manage` | Set the serving model for a capability `{ modelId }` |
| GET | `/admin/routing-policies` | auth + `model:manage` | List routing policies (strategy + fallback) per capability |
| GET | `/admin/routing-policies/:capability` | auth + `model:manage` | One policy, or the platform default when unconfigured |
| PUT | `/admin/routing-policies/:capability` | auth + `model:manage` | Set `{ strategy: quality\|latency\|cost, fallbackToChat }`, audited |
| GET | `/admin/privacy-routing` | auth + `model:manage` | Privacy-routing settings (auto-routing default ON, all three categories enforced, code carve-out ON) |
| PUT | `/admin/privacy-routing` | auth + `model:manage` | Set any subset of `{ autoRouteToCloud, sensitiveCategories, codeRoutableToCloud }`, audited |
| GET | `/admin/models/artifacts/local` | auth + `model:manage` | Local Ollama artifacts (pulls gated by `ALLOW_DEV_PROVIDERS`) |
| POST | `/admin/models/artifacts/pull` | auth + `model:manage` | Pull a model artifact via Ollama (allowlisted names, audited) |

The model registry is tenant-agnostic; per-tenant serving is resolved at
request time (see ADR-006). Lifecycle states: `REGISTERED → DOWNLOADING →
VALIDATING → EVALUATING → PENDING_APPROVAL → APPROVED → CANARY → ACTIVE →
DEPRECATED → RETIRED` (plus `DISABLED`); see ADR-008.

`GET /models` items carry user-facing provider fields (ADR-018):
`displayName` (friendly name, never a raw registry ID), `providerGroup`
(`enflite` | `claude` | `openai`), `providerLabel` (`Enflite` | `Claude` |
`OpenAI`), and `isProviderDefault` (the provider's preferred chat model,
auto-selected on provider switch). Cloud provider models are default-open
within the tenant but capped at the INTERNAL classification — prompts leave
the operator's infrastructure, so CONFIDENTIAL and above require an explicit
admin widening of the model's `allowedClassifications`.

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
