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
turn `{ formName, requirements }` into a tracked unit of work
executed by a server-side agent, reporting back with a completion
report and the GitHub PR link. It drives the same workflow as
[`Enflite/Form-Project-Templates`](https://github.com/Enflite/Form-Project-Templates)
(the template the team already uses with Claude), behind the
`syteline:forms` permission.

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

```bash
curl -X POST https://api.example.com/api/v1/form-customizations \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "formName": "Incidents",
    "title": "Date of Manufacture and Product Code",
    "requirements": [
      "Add a new date field \"Date of Manufacture\" to the General tab, to the right of Item Description",
      "Add a new text field \"Product Code\" to the General tab, under Date of Manufacture",
      "Relabel \"Notes\" to \"Internal Notes\" on the Comments tab (label only)"
    ],
    "originals": {
      "trn": "document:01J9…",
      "prd": "document:01J9…"
    },
    "requestedBy": "Jane Smith / Engineering"
  }'
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

**Backup-first is an intake gate, not a suggestion.** The request is
rejected (`400 FORM_SYNC_ORIGINALS_MISSING`, naming which export is
absent) unless **both** originals are supplied: the FormSync export
of the current form from TRN and from production. These are the
rollback copies the agent records in `original/` unchanged (UTF-8
with BOM, CRLF — never opened and re-saved). If you don't have them
yet, export them from FormSync first (template procedure 3), upload
each via `POST /api/v1/documents`, and pass the document ids as
`originals.trn` / `originals.prd`.

Validation on create: `formName` matches `^[A-Za-z0-9_]+$`
(the SyteLine form name); `title` 1–200 chars; `requirements` is a
non-empty array of 1–500-char strings (be specific: field type,
label, tab, position — the mockup-or-spreadsheet rule applies to
what you put in these strings); `requestedBy` optional, 1–200 chars.

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
| `missing-formsync-originals` | TRN and/or production export not recorded | Export both from FormSync and create a new request with them (or re-run intake once supplied) |
| `trn-prd-drift` | TRN and production originals differ — production has local changes | Resolve the drift: build from the production export per template procedure 3, or confirm TRN is authoritative; create a follow-up request |
| `missing-github-token` | No GitHub token configured; the agent cannot create the repo / open the PR | Set `GITHUB_TOKEN` and retry the request |
| `invalid-requirements` | The requirements could not be turned into a plan (e.g. the form name isn't in the TRN export) | Restate the requirements more concretely (field type, label, tab, position) and create a new request |
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

Creates a form-customization request. `202` on acceptance.

Request body (`application/json`):

| Field | Type | Required | Constraints |
|---|---|---|---|
| `formName` | string | yes | SyteLine form name; `^[A-Za-z0-9_]+$` |
| `title` | string | yes | 1–200 chars |
| `requirements` | string[] | yes | Non-empty; each 1–500 chars |
| `originals.trn` | string | yes | Document id (`document:<id>`) or repo path of the TRN FormSync export |
| `originals.prd` | string | yes | Document id (`document:<id>`) or repo path of the production FormSync export |
| `requestedBy` | string | no | 1–200 chars |

Responses:

| Code | Meaning | Body |
|---|---|---|
| `202` | Accepted | `{ id, status: "requested", formName, createdAt }` |
| `400` | Validation failed | `error.code` ∈ `VALIDATION_ERROR`, `FORM_SYNC_ORIGINALS_MISSING` (details name which export is absent), `INVALID_FORM_NAME` |
| `401` / `403` | Unauthenticated / missing `syteline:forms` | `error.code` ∈ `UNAUTHENTICATED`, `FORBIDDEN` |
| `403` | Feature disabled | `error.code: "FEATURE_DISABLED"` when `FORM_CUSTOMIZATION_API_ENABLED=false` |
| `429` | Rate limited (10/min) | standard error shape |

### `GET /form-customizations/{id}`

Returns the full request record (`200`): `{ id, status, formName,
title, requestedBy?, steps[], resultSummary?, blockedReason?,
blockedDetail?, evidence?, createdAt, updatedAt, completedAt? }`.
`steps[]` items: `{ name, status: "pending"|"running"|"done"|"failed",
startedAt?, completedAt? }`. `evidence` (on `awaiting_review`):
`{ repoUrl, prUrl, formXml, deck, originals: { trn, prd,
sha256Prefix }, openItems[], assumptions[] }`.

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

`VALIDATION_ERROR` · `FORM_SYNC_ORIGINALS_MISSING` ·
`INVALID_FORM_NAME` · `FEATURE_DISABLED` · `UNAUTHENTICATED` ·
`FORBIDDEN` · `NOT_FOUND` · `REQUEST_ALREADY_TERMINAL` · `RATE_LIMITED`

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
| `400 FORM_SYNC_ORIGINALS_MISSING` | TRN and/or production export not supplied | Export both from FormSync (template procedure 3), upload via `POST /api/v1/documents`, pass the document ids |
| Request stuck in `requested` | `FORM_CUSTOMIZATION_RUNNER_ENABLED` is `false`/unset | Set it `true` and restart; check `FORM_CUSTOMIZATION_API_ENABLED` too |
| `blocked` with `trn-prd-drift` | Production form has local changes the TRN export doesn't include | Per template procedure 3: decide whether production or TRN is authoritative, then create a follow-up request |
| `blocked` with `missing-github-token` | `GITHUB_TOKEN` unset or lacking org access | Set the token (repo + PR scope in `FORM_CUSTOMIZATION_GITHUB_ORG`); the request can be retried |
| `blocked` with `invalid-requirements` | Requirements too vague or form name not in the TRN export | Restate with field type, label, tab, position; verify `formName` against SyteLine |
| `blocked` with `build-check-failed` | Deterministic-rebuild check failed in the build script | Backend-team issue, not a request issue — include the step log |
| `409 REQUEST_ALREADY_TERMINAL` on cancel | Request already finished | Read the completion report or blocked reason instead |

When reporting a form-customization problem, include the request id
and the relevant audit events — never paste form XML containing
customer data into a ticket.
