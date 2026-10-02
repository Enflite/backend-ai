# Form Customizations API — Operator Guide

"Customize this SyteLine form for me" as a typed API call. You (or a
system on your behalf) POST a form-customization request — form name
plus requirements — and the backend AI runs the **entire
Form-Project-Templates workflow** for you: it scaffolds the form
project, records the FormSync rollback copies, builds `<Form>.xml`
from the TRN original (UET-only `Uf_ENF_*` fields, purple
highlighting, byte-preserved UTF-8/BOM/CRLF), writes the
implementation plan and the deck, and opens a **review PR** you
merge. Design: ADR-021.

> **Honesty note:** this guide describes the full design. The
> `POST → id → poll status → PR link` dispatch is the design; the
> runner's real GitHub work (creating the repo, opening the PR) and
> real SyteLine imports are **REQUIRES REAL GITHUB / REAL SYTELINE**
> — never exercised in this sandbox. The state machine, intake
> validation, permission gating, kill switches, and blocked
> conditions are **VALIDATED IN CI** in the code PR.

## What it is

The Runtype-style dispatch for form work: typed REST endpoints that
turn five inputs into a tracked unit of work executed by a server-side
agent, reporting back with a completion report and the GitHub PR link.
It drives the same workflow as
[`Enflite/Form-Project-Templates`](https://github.com/Enflite/Form-Project-Templates)
(the template the team already uses with Claude), behind the
`syteline:forms` permission.

### The five inputs (Jake, 2026-10-02)

The requester supplies **exactly** these five inputs — nothing else.
The SOP knowledge lives in the agent (see "What the AI already
knows"), not in the request:

1. **The current form `.xml`** — file upload or inline content.
   This is the TRN export: the before-anything baseline the agent
   builds `<Form>.xml` from.
2. **IDO properties as a CSV** — the IDO's properties (names, types,
   alias prefix), feeding the UET design tables and the build.
3. **SQL columns as a CSV** — the backing SQL Table's columns, so the
   agent knows what exists before designing `Uf_ENF_*` fields.
4. **A list of instructions** — the actual customization
   requirements: add field / relabel / resize. Each item should be
   specific: field type, label, tab, position — the
   mockup-or-spreadsheet rule applies to what goes in these strings.
5. **Other information / attachments** — free-form context files the
   requester wants the AI to have (mockup screenshots, spreadsheets,
   notes). A `*.production.original.xml` attachment here is treated
   as the production FormSync original for the backup-first check.

### What the AI already knows (baked into the agent)

The requester never re-explains the Form-Project-Templates SOP — it
is part of the agent's knowledge/planner prompt. The agent knows:

- **Procedures 01–07**: start a project from the template (01), UET
  setup (02), FormSync backup/import (03), UET field confirmation and
  staging checks (04), launch to production (05), rollback (06), new
  SQL Table + IDO (07) — plus the troubleshooting notes.
- **UET-only `Uf_ENF_*` field naming** on the existing IDO/SQL
  Tables; a new SQL Table + IDO only when the feature needs its own
  record.
- **TRN-first development**: everything is built from the TRN
  original; production is a comparison input and a rollback copy.
- **Backup-first**: the TRN and production FormSync exports are
  recorded unchanged before anything is built — they are the rollback
  copies.
- **Byte preservation**: UTF-8 with BOM, CRLF line endings — never
  open and re-save an export in an editor.
- **Deterministic rebuild**: `<Form>.xml` is always rebuilt from the
  original by the build script (never hand-edited); the rebuild check
  must pass.
- **Purple highlighting** on every change in the built XML.
- **TRN/PRD drift stops the build**: when the two originals differ,
  production has local changes — stop and ask, don't guess.
- **Property patterns**: relabels are label-only; component Type /
  Read-Only / Inline List changes don't survive re-import and become
  manual form-design steps in the implementation plan.

So the five inputs above are the whole request: the agent applies
this knowledge automatically.

What the API automates (the *build* work):

1. Scaffold the form project repo from the template
   (`Enflite/<FormName>`).
2. Record the TRN and production FormSync exports in `original/`
   (the rollback copies) and compare them.
3. Build `<Form>.xml` from the **TRN** original via the build script
   — never by hand, so every change stays traceable; new fields use
   UET-only `Uf_ENF_*` names on the existing IDO/SQL Tables, changes
   highlighted in purple.
4. Write the README, implementation plan (with the UET design tables),
   troubleshooting log, and the implementation-plan deck.
5. Open the review PR — then **stop**. The PR is never auto-merged;
   a human reviews and merges it.

What stays human (the *go-live* work): the TRN UET setup, staging
checks, FormSync import of `<Form>.xml` at Site scope, TRN testing,
launch to production, and rollback — all numbered human runbook
steps in the generated implementation plan.

## Who can use it

Form customization changes what users see and do in the ERP, so the
bar is high: **Admin and AI Admin only** — the `syteline:forms`
permission, never the User role. Requests are owned by the requester
(identity comes from the auth context, never from request arguments)
and are tenant-scoped. Privacy routing treats the family as
`syteline.*` — never offered on cloud turns when customer or finance
categories are enforced (see `docs/privacy-routing.md`).

The feature is also behind two master kill switches, both default
off (fail closed). If `FORM_CUSTOMIZATION_API_ENABLED` is off, the
endpoints fail fast with `FEATURE_DISABLED`. If
`FORM_CUSTOMIZATION_RUNNER_ENABLED` is off, requests stay `requested`
and nothing runs.

## Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `FORM_CUSTOMIZATION_API_ENABLED` | no | `false` | Master kill switch for the endpoints |
| `FORM_CUSTOMIZATION_RUNNER_ENABLED` | no | `false` | Master kill switch for the agent runner |
| `FORM_CUSTOMIZATION_GITHUB_ORG` | no | `Enflite` | GitHub org for new form-project repos and PRs |
| `GITHUB_TOKEN` | yes (to run) | — | Token with repo + PR access in the org. Missing → requests block with `missing-github-token` |
| `FORM_CUSTOMIZATION_RUNNER_INTERVAL_MS` | no | `15000` (15 s) | Poll interval for the runner to pick up `requested` work |

## The dispatch flow

```
POST /api/v1/form-customizations      → 202 { id, status: "requested" }
GET  /api/v1/form-customizations/:id → poll until status is
                                       "awaiting_review" (PR link) or "blocked"
Human: review the PR, import <Form>.xml into TRN, test
Human: merge the PR when it looks right → status "completed"
```

Lifecycle (ADR-021 §2):

| Status | Meaning |
|---|---|
| `requested` | Created, waiting for the runner |
| `in_progress` | Agent executing the template workflow |
| `awaiting_review` | Work finished; review PR open. **This is the agent's terminal state** — the completion report and PR link live here |
| `completed` | A **human** merged the review PR (never the agent) |
| `blocked` | Stopped — see `blockedReason` below |
| `cancelled` | Cancelled by the requester or an admin |

### 1. Create — `POST /api/v1/form-customizations`

Two submission shapes, both accepted. **Multipart** (file parts +
text fields) is preferred for large inputs; **JSON** takes the same
content inline. The backend already registers Fastify multipart in
`server.ts`; this endpoint raises its file limits for the XML/CSV
parts (see the per-part table).

**Multipart example** (`multipart/form-data`):

```bash
curl -X POST https://api.example.com/api/v1/form-customizations \
  -H "Authorization: Bearer $TOKEN" \
  -F "formName=Incidents" \
  -F "title=Date of Manufacture and Product Code" \
  -F 'instructions=["Add a new date field \"Date of Manufacture\" to the General tab, to the right of Item Description","Add a new text field \"Product Code\" to the General tab, under Date of Manufacture","Relabel \"Notes\" to \"Internal Notes\" on the Comments tab (label only)"]' \
  -F "formXml=@Incidents.trn.original.xml" \
  -F "idoPropertiesCsv=@Incidents_IDO_properties.csv" \
  -F "sqlColumnsCsv=@Incidents_sql_columns.csv" \
  -F "attachments[]=@Incidents.production.original.xml" \
  -F "attachments[]=@mockup.png" \
  -F "requestedBy=Jane Smith / Engineering"
```

**JSON example** (`application/json`) — same five inputs inline:

```json
{
  "formName": "Incidents",
  "title": "Date of Manufacture and Product Code",
  "instructions": [
    "Add a new date field \"Date of Manufacture\" to the General tab, to the right of Item Description",
    "Add a new text field \"Product Code\" to the General tab, under Date of Manufacture",
    "Relabel \"Notes\" to \"Internal Notes\" on the Comments tab (label only)"
  ],
  "formXml": "<form>…current form XML content…</form>",
  "idoPropertiesCsv": "Property,Type,Alias\n…",
  "sqlColumnsCsv": "Column,DataType,Nullable\n…",
  "attachments": [
    { "filename": "Incidents.production.original.xml", "content": "<form>…production export…</form>" },
    { "filename": "mockup.png", "contentBase64": "iVBORw0KGgo…" }
  ],
  "requestedBy": "Jane Smith / Engineering"
}
```

Response (`202 Accepted`):

```json
{
  "id": "fc_01J9ABC…",
  "status": "requested",
  "formName": "Incidents",
  "createdAt": "2026-10-02T18:12:00Z"
}
```

#### Per-part validation rules and size limits

Limits mirror existing repo conventions (the documents upload cap,
the `codeFiles` ≤ 20 files / ≤ 200 KB rule); the code PR implements
them. Failed validation → `400 VALIDATION_ERROR` with `details`
naming the failing part.

| Input | Part name | Rules |
|---|---|---|
| Current form `.xml` | `formXml` | Exactly one (required); `.xml` extension; ≤ 10 MB; must parse as XML and contain the form definition; the form name in the XML must match the request's `formName` |
| IDO properties CSV | `idoPropertiesCsv` | Exactly one (required); `.csv`; ≤ 5 MB; UTF-8; must have a header row with a property-name-like first column |
| SQL columns CSV | `sqlColumnsCsv` | Exactly one (required); `.csv`; ≤ 5 MB; UTF-8; must have a header row with a column-name-like first column |
| Instructions | `instructions` | Required; non-empty array (multipart: JSON array or newline-delimited text field); 1–100 items; each 1–500 chars; be specific — field type, label, tab, position |
| Attachments | `attachments[]` | Optional; 0–20 files; ≤ 200 KB each; common formats (images, CSV, spreadsheets, PDFs). A `*.production.original.xml` attachment is treated as the production FormSync original. Multipart file parts pass through the same malware boundary as document uploads — a quarantine marks the request `blocked` with `blockedReason: 'attachment-quarantined'` |
| `formName` | (text field) | Required; SyteLine form name; `^[A-Za-z0-9_]+$` |
| `title` | (text field) | Required; 1–200 chars |
| `requestedBy` | (text field) | Optional; 1–200 chars |

**Backup-first still holds — enforced by the agent's baked-in
knowledge.** The current form `.xml` (input 1) is the TRN original.
The agent also needs the production FormSync export before it builds
anything — the rollback copies. If the requester supplied it as an
attachment (input 5), the agent records it in `original/` unchanged
and compares SHA-256 against TRN per template procedure 3. If it is
absent, the request is created but the runner marks it `blocked` with
`blockedReason: 'missing-production-original'`. The agent never
starts building until both originals are recorded.

### 2. Status — `GET /api/v1/form-customizations/:id`

```bash
curl https://api.example.com/api/v1/form-customizations/fc_01J9ABC… \
  -H "Authorization: Bearer $TOKEN"
```

Response while running (`200`):

```json
{
  "id": "fc_01J9ABC…",
  "status": "in_progress",
  "formName": "Incidents",
  "title": "Date of Manufacture and Product Code",
  "steps": [
    { "name": "scaffold-project",   "status": "done",    "completedAt": "2026-10-02T18:13:02Z" },
    { "name": "record-originals",   "status": "done",    "completedAt": "2026-10-02T18:13:40Z" },
    { "name": "compare-trn-prd",    "status": "done",    "completedAt": "2026-10-02T18:13:41Z" },
    { "name": "build-form-xml",     "status": "running" },
    { "name": "write-docs",         "status": "pending" },
    { "name": "build-deck",         "status": "pending" },
    { "name": "open-pr",            "status": "pending" }
  ],
  "createdAt": "2026-10-02T18:12:00Z",
  "updatedAt": "2026-10-02T18:14:11Z"
}
```

Response at `awaiting_review` (`200`) — the completion report:

```json
{
  "id": "fc_01J9ABC…",
  "status": "awaiting_review",
  "formName": "Incidents",
  "title": "Date of Manufacture and Product Code",
  "steps": [ { "name": "scaffold-project", "status": "done", … }, … ],
  "resultSummary": "Built Incidents.xml from the TRN original with 2 new UET fields (Uf_ENF_DateOfMfg, Uf_ENF_ProductCode) and 1 relabel, highlighted in purple. Implementation plan and deck written; review PR open.",
  "evidence": {
    "repoUrl": "https://github.com/Enflite/Incidents",
    "prUrl": "https://github.com/Enflite/Incidents/pull/3",
    "formXml": "Incidents.xml",
    "deck": "plan/Incidents_Implementation_Plan.pptx",
    "inputs": {
      "formXml": "input/Incidents.trn.original.xml",
      "idoPropertiesCsv": "input/Incidents_IDO_properties.csv",
      "sqlColumnsCsv": "input/Incidents_sql_columns.csv"
    },
    "originals": {
      "trn": "original/Incidents.trn.original.xml",
      "prd": "original/Incidents.production.original.xml",
      "sha256Prefix": "9f2c…"
    },
    "openItems": [
      "IDO table alias assumed as \"inc\" from the TRN export — confirm in staging check A before import"
    ],
    "assumptions": [
      "Both new fields are text/date UET fields on the existing IDO; no new SQL Table needed"
    ]
  },
  "completedAt": "2026-10-02T18:31:55Z"
}
```

### 3. List — `GET /api/v1/form-customizations`

```bash
curl "https://api.example.com/api/v1/form-customizations?status=awaiting_review&limit=20" \
  -H "Authorization: Bearer $TOKEN"
```

Response (`200`): `{ "items": [ { id, status, formName, title, createdAt, updatedAt } … ], "nextCursor": "…" }`.
Admins see the tenant's requests; others see their own. The
kanban-board query for form work: filter by `status`.

### 4. Cancel — `POST /api/v1/form-customizations/:id/cancel`

```bash
curl -X POST https://api.example.com/api/v1/form-customizations/fc_01J9ABC…/cancel \
  -H "Authorization: Bearer $TOKEN"
```

Response (`200`): `{ "id": "fc_01J9ABC…", "status": "cancelled" }`.
Requester or admin only. Ends work in flight; terminal states cannot
be cancelled (`409 REQUEST_ALREADY_TERMINAL`).

## What "blocked" means

`blocked` is the agent asking for a human. The record carries
`blockedReason` (enumerated code) plus human-readable `blockedDetail`:

| `blockedReason` | What happened | What to do |
|---|---|---|
| `missing-current-form-xml` | Input 1 (the current form `.xml`) was not supplied or failed validation | Supply the TRN FormSync export as `formXml` |
| `missing-production-original` | No production FormSync export was supplied, so the agent cannot complete the backup-first check | Export the same form from production FormSync and attach it (`*.production.original.xml`) |
| `trn-prd-drift` | TRN and production originals differ — production has local changes | Resolve the drift: build from the production export per template procedure 3, or confirm TRN is authoritative; create a follow-up request |
| `missing-github-token` | No GitHub token configured; the agent cannot create the repo / open the PR | Set `GITHUB_TOKEN` and retry the request |
| `invalid-requirements` | The instructions could not be turned into a plan (e.g. the form name isn't in the supplied form XML) | Restate the instructions more concretely (field type, label, tab, position) and create a new request |
| `attachment-quarantined` | An uploaded part tripped the malware boundary | Remove or replace the flagged attachment and create a new request |
| `build-check-failed` | The build script's deterministic-rebuild check failed | Read the step log; this indicates the tooling, not the request — file it with the backend team |

When blocked, the record is the report: which template step failed,
what was recorded so far, and the exact missing input. Nothing is
half-built — the agent never imports anything anywhere.

## Completion report and evidence

An `awaiting_review` (or `blocked`) request always carries:

- `status`, `resultSummary` (plain language: what was built) or
  `blockedReason` + `blockedDetail`.
- `evidence`: the form-project repo URL, the review PR URL, the
  `<Form>.xml` artifact, the deck, the recorded originals with their
  SHA-256 prefix, `openItems` (what the agent was unsure about), and
  `assumptions`.
- The step log: every template step, in order, with timestamps.

The TRN UET setup, staging checks, FormSync import, testing, launch,
and rollback are **human runbook steps** in the generated
implementation plan — the API automates the build, not the go-live.
After you import `<Form>.xml` into TRN and it tests clean, merge the
PR; the request flips to `completed`.

## The SOP the API drives

The runner executes the Form-Project-Templates workflow in template
order — it does not approximate it:

1. **Backup first.** Both FormSync originals recorded in `original/`,
   byte-preserved, SHA-256 compared. Identical → the same
   `<Form>.xml` serves both environments; different → drift stops
   the build.
2. **TRN-first.** Everything is built from the TRN original; the
   production export is a comparison input and a rollback copy.
3. **UET-only naming.** New custom fields are `Uf_ENF_*` on the
   existing IDO/SQL Tables; a new SQL Table + IDO only when the
   feature needs its own record (template procedure 7).
4. **No hand edits.** `<Form>.xml` is rebuilt from the original by
   the build script every time; the deterministic-rebuild check must
   pass.
5. **Purple highlighting** on every change in the built XML.
6. **Review PR, never auto-merged.** The agent has no merge
   capability; the merge is a human decision with a human's name on
   it.

## OpenAPI-style reference

Base path: `/api/v1`. All endpoints require auth + `syteline:forms`
except as noted. Error shape:
`{ error: { code, message, requestId, details? } }`.

### `POST /form-customizations`

Creates a form-customization request from Jake's five-input contract.
`202` on acceptance. Two content types accepted.

**`multipart/form-data`** — preferred for large inputs. Text fields:

| Field | Type | Required | Constraints |
|---|---|---|---|
| `formName` | string | yes | SyteLine form name; `^[A-Za-z0-9_]+$` |
| `title` | string | yes | 1–200 chars |
| `instructions` | string | yes | JSON array or newline-delimited; 1–100 items, each 1–500 chars |
| `requestedBy` | string | no | 1–200 chars |

File parts:

| Part | Type | Required | Constraints |
|---|---|---|---|
| `formXml` | file | yes | `.xml`; ≤ 10 MB; parses as XML; form name in XML matches `formName` |
| `idoPropertiesCsv` | file | yes | `.csv`; ≤ 5 MB; UTF-8; header row with property-name-like first column |
| `sqlColumnsCsv` | file | yes | `.csv`; ≤ 5 MB; UTF-8; header row with column-name-like first column |
| `attachments[]` | file[] | no | 0–20 files; ≤ 200 KB each; a `*.production.original.xml` is the production FormSync original |

**`application/json`** — the same contract inline:

| Field | Type | Required | Constraints |
|---|---|---|---|
| `formName` | string | yes | `^[A-Za-z0-9_]+$` |
| `title` | string | yes | 1–200 chars |
| `instructions` | string[] | yes | Non-empty; 1–100 items; each 1–500 chars |
| `formXml` | string | yes | XML content as a string (≤ 10 MB); form name in XML matches `formName` |
| `idoPropertiesCsv` | string | yes | CSV content as a string (≤ 5 MB); header row required |
| `sqlColumnsCsv` | string | yes | CSV content as a string (≤ 5 MB); header row required |
| `attachments` | `{ filename, content }` / `{ filename, contentBase64 }` [] | no | 0–20 items; ≤ 200 KB content each |
| `requestedBy` | string | no | 1–200 chars |

Multipart parts are scanned through the same malware boundary as
document uploads; a quarantine yields `blockedReason:
'attachment-quarantined'`.

Responses:

| Code | Meaning | Body |
|---|---|---|
| `202` | Accepted | `{ id, status: "requested", formName, createdAt }` |
| `400` | Validation failed | `error.code` ∈ `VALIDATION_ERROR` (`details` names the failing part), `INVALID_FORM_NAME`, `MULTIPART_LIMIT_EXCEEDED` |
| `401` / `403` | Unauthenticated / missing `syteline:forms` | `error.code` ∈ `UNAUTHENTICATED`, `FORBIDDEN` |
| `403` | Feature disabled | `error.code: "FEATURE_DISABLED"` when `FORM_CUSTOMIZATION_API_ENABLED=false` |
| `413` | A part exceeded its size limit | `error.code: "PART_TOO_LARGE"` (`details` names the part) |
| `429` | Rate limited (10/min) | standard error shape |

### `GET /form-customizations/{id}`

Returns the full request record (`200`): `{ id, status, formName,
title, requestedBy?, steps[], resultSummary?, blockedReason?,
blockedDetail?, evidence?, createdAt, updatedAt, completedAt? }`.
`steps[]` items: `{ name, status: "pending"|"running"|"done"|"failed",
startedAt?, completedAt? }`. `evidence` (on `awaiting_review`):
`{ repoUrl, prUrl, formXml, deck, inputs: { formXml, idoPropertiesCsv,
sqlColumnsCsv }, originals: { trn, prd, sha256Prefix }, openItems[],
assumptions[] }`.

| Code | Meaning |
|---|---|
| `200` | Record |
| `401` / `403` | `UNAUTHENTICATED` / `FORBIDDEN` (not the requester or an admin) |
| `404` | `NOT_FOUND` |
| `403` | `FEATURE_DISABLED` |

### `GET /form-customizations`

Query params: `status` (one of the six statuses), `limit` (≤ 100,
default 20), `cursor`. `200`:
`{ items: [{ id, status, formName, title, createdAt, updatedAt }],
nextCursor? }`. Admins see the tenant's requests; others see only
their own.

### `POST /form-customizations/{id}/cancel`

`200`: `{ id, status: "cancelled" }`. Requester or admin only.

| Code | Meaning |
|---|---|
| `200` | Cancelled |
| `401` / `403` | `UNAUTHENTICATED` / `FORBIDDEN` |
| `404` | `NOT_FOUND` |
| `409` | `REQUEST_ALREADY_TERMINAL` — already `awaiting_review`, `completed`, `blocked`, or `cancelled` |
| `403` | `FEATURE_DISABLED` |

### Error codes (summary)

`VALIDATION_ERROR` · `INVALID_FORM_NAME` · `PART_TOO_LARGE` ·
`MULTIPART_LIMIT_EXCEEDED` · `FEATURE_DISABLED` · `UNAUTHENTICATED` ·
`FORBIDDEN` · `NOT_FOUND` · `REQUEST_ALREADY_TERMINAL` · `RATE_LIMITED`

Blocked-reason codes (on the request record, not errors):
`missing-current-form-xml` · `missing-production-original` ·
`trn-prd-drift` · `missing-github-token` · `invalid-requirements` ·
`attachment-quarantined` · `build-check-failed`

### Audit events

`FORM_CUSTOMIZATION_REQUESTED` · `FORM_CUSTOMIZATION_STARTED` ·
`FORM_CUSTOMIZATION_STEP` (step names only) ·
`FORM_CUSTOMIZATION_BLOCKED` (reason) ·
`FORM_CUSTOMIZATION_AWAITING_REVIEW` (repo + PR urls) ·
`FORM_CUSTOMIZATION_MERGED` (human actor recorded) ·
`FORM_CUSTOMIZATION_CANCELLED`. Query with
`GET /api/v1/audit?action=…` (`audit:read`).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `403 FEATURE_DISABLED` on every call | `FORM_CUSTOMIZATION_API_ENABLED` is `false`/unset | Set `FORM_CUSTOMIZATION_API_ENABLED=true` and restart |
| `403 FORBIDDEN` | Caller lacks `syteline:forms` (User role) | Form customization is Admin/AI-Admin only — grant the role or have an admin submit |
| `400 VALIDATION_ERROR` on a part | A part failed validation (size, format, header row) | Read `details` for the failing part and fix it |
| `blocked` with `missing-current-form-xml` | Input 1 (the current form `.xml`) was not supplied or failed validation | Supply the TRN FormSync export as `formXml` |
| `blocked` with `missing-production-original` | No production FormSync export was supplied | Export the same form from production FormSync and attach it (`*.production.original.xml`) |
| Request stuck in `requested` | `FORM_CUSTOMIZATION_RUNNER_ENABLED` is `false`/unset | Set it `true` and restart; check `FORM_CUSTOMIZATION_API_ENABLED` too |
| `blocked` with `trn-prd-drift` | Production form has local changes the TRN export doesn't include | Per template procedure 3: decide whether production or TRN is authoritative, then create a follow-up request |
| `blocked` with `missing-github-token` | `GITHUB_TOKEN` unset or lacking org access | Set the token (repo + PR scope in `FORM_CUSTOMIZATION_GITHUB_ORG`); the request can be retried |
| `blocked` with `invalid-requirements` | Requirements too vague or form name not in the supplied form XML | Restate with field type, label, tab, position; verify `formName` against SyteLine |
| `blocked` with `build-check-failed` | Deterministic-rebuild check failed in the build script | Backend-team issue, not a request issue — include the step log |
| `409 REQUEST_ALREADY_TERMINAL` on cancel | Request already finished | Read the completion report or blocked reason instead |

When reporting a form-customization problem, include the request id
and the relevant audit events — never paste form XML containing
customer data into a ticket.
