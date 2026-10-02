# ADR-021: SyteLine Form AI Agent (Runtype-style dispatch over Form-Project-Templates)

**Status:** Accepted

## Context

Jake (2026-10-02): "we also need an api for AI that automatically
completes this for us — Enflite/Form-Project-Templates — so people can
easily customize a form using our AI."

The Form-Project-Templates repo (`Enflite/Form-Project-Templates`) is
the team's proven SOP for SyteLine form changes: a requester supplies
the form name, the requirements (mockup / spreadsheet / written list),
and the **TRN and production FormSync exports** (the rollback copies);
Claude scaffolds a form project repo from the template, builds
`<Form>.xml` from the TRN original (UTF-8 with BOM, CRLF, UET-only
`Uf_ENF_*` fields, changes highlighted in purple), writes the
implementation plan and the deck, opens a **review PR** — and a human
imports the XML into TRN, tests, and only then launches to production
via the launch procedure, with the original exports as the rollback
path.

The backend already has the pieces the SyteLine Form AI Agent rides
on:

- The `syteline.form_*` tool family (see `docs/api.md`) — the port of
  the template workflow: scaffold the project, build `<Form>.xml` from
  the TRN original (stopping when TRN and production originals differ),
  write docs, build the deck, and open the review PR. Each tool requires
  `syteline:forms`.
- The ADR-020 task-agent pattern — plain-language intake into a
  tenant-scoped queue, a server-side runner executing a tracked unit of
  work, statuses doubling as a kanban data model, and a completion
  report with evidence.

Jake asked for "Runtype-style dispatch": typed REST endpoints that turn
a `{ form, requirements }` request into a tracked unit of work, with a
server-side agent executing the whole workflow and reporting back —
POST → id → poll status → PR link. Jake named the product the
**SyteLine Form AI Agent** (2026-10-02). This ADR records the design
decisions for that dispatch layer.

## Decision

### 1. Four versioned REST endpoints under `/api/v1/form-customizations`

All require auth plus the `syteline:forms` permission (the same
permission bar as the `syteline.form_*` tools):

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/form-customizations` | Create a request from Jake's five-input contract — current form `.xml`, IDO-properties CSV, SQL-columns CSV, instruction list, optional attachments; returns `202 { id, status: 'requested' }` |
| GET | `/api/v1/form-customizations/:id` | Full request record: status, agent progress log, `resultSummary` / `blockedReason`, completion evidence (`repoUrl`, `prUrl`, artifacts) |
| GET | `/api/v1/form-customizations` | List the requester's (or, for admins, the tenant's) requests; optional `status` filter — the kanban-board query for the SyteLine Form AI Agent |
| POST | `/api/v1/form-customizations/:id/cancel` | Cancel (ends work in flight); requester or admin only |

*Rationale:* versioned REST, not chat, because the caller is often a
system (Jake: "so people can easily customize a form using our AI" —
people *and* systems). The shape mirrors the ADR-020 task-agent
endpoints deliberately: the same intake → tracked work → report
pattern, with form-specific lifecycle and gating.

### 1a. The request input contract (Jake, 2026-10-02): exactly five inputs

The requester supplies exactly these five inputs — nothing else.
The SOP knowledge lives in the agent, not the request (decision 1b):

1. **The current form `.xml`** — file upload or inline content.
   This is the TRN export: the before-anything baseline the agent
   builds `<Form>.xml` from.
2. **IDO properties as a CSV** — the IDO's properties (names, types,
   the alias prefix), feeding the UET design tables and the build.
3. **SQL columns as a CSV** — the backing SQL Table's columns, so the
   agent knows what exists before designing `Uf_ENF_*` fields.
4. **A list of instructions** — the actual customization
   requirements (add field / relabel / resize), each item specific:
   field type, label, tab, position.
5. **Other information / attachments** — free-form context files the
   requester wants the AI to have (mockup screenshots, spreadsheets,
   notes). This is also where the **production FormSync export** can
   arrive (see decision 6).

Two submission shapes, both accepted:

- `multipart/form-data` — file parts
  (`formXml`, `idoPropertiesCsv`, `sqlColumnsCsv`,
  `attachments[]`) plus text fields (`formName`, `title`,
  `instructions` as JSON array or newline-delimited). The backend
  already registers Fastify multipart in `server.ts`; this endpoint
  raises its file limits (see decision 7).
- `application/json` — the same fields with `formXml`, `idoPropertiesCsv`,
  `sqlColumnsCsv` as inline strings, `instructions` as a string
  array, `attachments` as `[{ filename, content }]` items.

Per-part validation rules and size limits are in decision 7 and
`docs/form-customizations.md`; the code PR implements them.

### 1b. The SOP knowledge is baked into the agent — the requester never re-explains it

The Form-Project-Templates SOP is part of the agent's
knowledge/planner prompt, not part of the request. The requester does
not re-explain naming conventions, the TRN-first flow, or
byte-preservation rules — they supply the five inputs above and the
agent knows the rest. The baked-in knowledge includes:

- **Procedures 01–07**: start a project from the template (01), UET
  setup (02), FormSync backup/import (03), UET field confirmation /
  staging checks (04), launch to production (05), rollback (06),
  new SQL Table + IDO (07) — plus the troubleshooting notes.
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

*Rationale (Jake, 2026-10-02):* the friction in the templates flow is
the requester having to re-explain the SOP every time. Baked-in
knowledge makes the API a true dispatch: five inputs in, a review PR
out.

### 2. Lifecycle: `requested → in_progress → awaiting_review → completed`, plus `blocked` and `cancelled`

```
requested → in_progress → awaiting_review → completed
requested → in_progress → blocked
(any non-terminal state) → cancelled
```

- `requested` — created, waiting for the runner.
- `in_progress` — claimed by the runner; the agent is executing the
  template workflow (scaffold → build XML → docs → deck → PR).
- `awaiting_review` — the agent finished its work and the review PR is
  open. This is the **terminal agent state**: the API's job is done
  here; the completion report (`repoUrl`, `prUrl`, `<Form>.xml`
  artifact, deck, open items, assumptions) is attached.
- `completed` — reached only when a **human** merges the review PR
  (merge hook / webhook marks it; never the agent — see decision 4).
- `blocked` — stopped: `blockedReason` is one of the enumerated
  conditions below (decision 6). The record is the report of what
  failed and what the human must supply.
- `cancelled` — cancelled by the requester or an admin; ends work in
  flight.

### 3. Permission gating: `syteline:forms` (Admin / AI Admin only)

Form customization changes what users see and do in the ERP. Like the
`syteline.form_*` tools and the `syteline:ui` family, the API is gated
to **Admin and AI Admin** — never the User role. The requester's
identity comes from the auth context, never from request arguments;
request records are tenant-scoped. Privacy routing treats the family
as `syteline.*` — never offered on cloud turns when customer or
finance categories are enforced (see `docs/privacy-routing.md`).

### 4. Form-project PRs are NEVER auto-merged

The runner opens the review PR (`syteline.form_open_pr` semantics:
create repo, push branch, open PR) and **stops**. No automation —
agent, runner, or webhook — ever merges a form-project PR. The merge
is a human decision, recorded by the human who reviewed it.

*Rationale:* the templates SOP already works this way ("when the pull
request looks right, a reviewer merges it into `main`"), and the
reason is load-bearing: importing `<Form>.xml` changes real users'
forms in TRN and, after launch, in production. An auto-merged PR is a
silent ERP change with no accountable reviewer. The SyteLine Form AI
Agent exists to do the *build* work automatically, not to skip the
*review* work.

### 5. Fail-closed flags

Two independent kill switches, both default-off:

- `FORM_CUSTOMIZATION_API_ENABLED` (default `false`) — the endpoints
  themselves. When off, all four endpoints fail fast with
  `FEATURE_DISABLED` (403).
- `FORM_CUSTOMIZATION_RUNNER_ENABLED` (default `false`) — the
  server-side runner that executes requests. When off, requests stay
  `requested` and nothing runs.

Additional hard prerequisites, checked at request start (missing →
`blocked` with a named reason, never a half-run):

- `GITHUB_TOKEN` with access to create repos and open PRs in the
  configured org (`FORM_CUSTOMIZATION_GITHUB_ORG`, default
  `Enflite`); without it the agent cannot open the review PR, so the
  request blocks with `blockedReason: 'missing-github-token'`.
- The requester's identity (auth context) — anonymous creation is
  impossible.

### 6. The backup-first rule is enforced by the agent's baked-in SOP knowledge

The templates SOP's first rule — *export TRN and production originals
before anything is imported, they are the rollback copies* — is baked
into the agent (decision 1b), and input 1 of the contract (the current
form `.xml`) is the TRN original. How the runner gets the production
original:

- If the requester supplied it as an attachment (input 5 — e.g. a
  file named `*.production.original.xml` or identified as such), the
  agent records it in `original/` unchanged and compares SHA-256
  against TRN per procedure 3.
- If it is absent, the runner marks the request `blocked` with
  `blockedReason: 'missing-production-original'`. The agent never
  starts building until both originals are recorded.

The agent then compares TRN vs. production. If they differ, production
has local changes: the runner marks the request `blocked` with
`blockedReason: 'trn-prd-drift'` — the templates SOP's "stop and ask"
— and the completion report carries the drift detail instead of a PR
link. A human resolves the drift (build from the production export,
per procedure 3) and creates a follow-up request.

The same TRN-first principle shapes the whole execution order the
runner enforces, in templates order:

1. Scaffold the project from the template (`Enflite/<FormName>`).
2. Record the originals in `original/` (byte-preserved: UTF-8 with
   BOM, CRLF; never opened and re-saved).
3. TRN/PRD comparison → drift stops the build.
4. Build `<Form>.xml` from the **TRN** original only (never by hand —
   the build script rebuilds from the original so every change stays
   traceable); `--check` verifies the deterministic rebuild; new
   fields named `Uf_ENF_*` (UET-only), changes highlighted in purple.
5. Write the implementation plan (UET design tables from the IDO and
   its SQL Tables), the deck, troubleshooting, README.
6. Open the review PR — and stop (`awaiting_review`).

TRN import, UET setup, staging checks, launch-to-production, and
rollback stay **numbered human runbook steps** in the generated
implementation plan — they are operations on the live ERP systems,
and the API automates the build, not the go-live.

### 7. Per-part validation rules and size limits

The five inputs are validated at intake (per part, before anything
runs). Limits mirror existing repo conventions (the documents upload
cap, the `codeFiles` ≤ 20 files / ≤ 200 KB rule):

| Input | Part name | Rules |
|---|---|---|
| Current form `.xml` | `formXml` | Exactly one; `.xml` extension; ≤ 10 MB; must parse as XML and contain the form definition; the form name in the XML must match the request's `formName` |
| IDO properties CSV | `idoPropertiesCsv` | Exactly one; `.csv`; ≤ 5 MB; UTF-8; must have a header row (property-name-like first column); rows are not required to be non-empty |
| SQL columns CSV | `sqlColumnsCsv` | Exactly one; `.csv`; ≤ 5 MB; UTF-8; must have a header row (column-name-like first column) |
| Instructions | `instructions` | Non-empty array (multipart: JSON array or newline-delimited text field); 1–100 items; each 1–500 chars. Each item should be specific: field type, label, tab, position — the mockup-or-spreadsheet rule applies to what goes in these strings |
| Attachments | `attachments[]` | 0–20 files; ≤ 200 KB each; common formats (images, CSV, spreadsheets, PDFs); a `*.production.original.xml` attachment is treated as the production FormSync original |
| Envelope | `formName` | `^[A-Za-z0-9_]+$` (the SyteLine form name) |
| Envelope | `title` | 1–200 chars |
| Envelope | `requestedBy` | Optional, 1–200 chars |

Failed validation → `400 VALIDATION_ERROR` with `details` naming the
failing part. Multipart file parts are scanned through the same
malware boundary as document uploads; a quarantine marks the request
`blocked` with `blockedReason: 'attachment-quarantined'`.

### 7. Completion report and evidence

An `awaiting_review` (or `blocked`) request carries:

- `status`, `resultSummary` (what was built, in plain language) or
  `blockedReason` (enumerated code + human-readable detail).
- `evidence`: `repoUrl`, `prUrl`, `<Form>.xml` artifact reference,
  deck artifact reference, `originals` (the recorded TRN/PRD exports
  with their SHA-256 prefixes), `openItems` (anything the agent was
  unsure about — e.g. an assumed IDO table alias), `assumptions`.
- A progress log: which template steps ran, in order, with
  timestamps — the durable record a reviewer (or a future kanban
  board) reads instead of re-running the work.

Audit events: `FORM_CUSTOMIZATION_REQUESTED`,
`FORM_CUSTOMIZATION_STARTED`, `FORM_CUSTOMIZATION_STEP` (step names
only), `FORM_CUSTOMIZATION_BLOCKED` (reason),
`FORM_CUSTOMIZATION_AWAITING_REVIEW` (repo + PR urls),
`FORM_CUSTOMIZATION_MERGED` (the human's merge — actor recorded),
`FORM_CUSTOMIZATION_CANCELLED`.

## Consequences

- The SyteLine Form AI Agent is dark by default: `FORM_CUSTOMIZATION_API_ENABLED` and
  `FORM_CUSTOMIZATION_RUNNER_ENABLED` are both `false`, and without
  `syteline:forms` the endpoints are never reachable. Two independent
  gates before any autonomous SyteLine Form AI Agent work can happen.
- A SyteLine Form AI Agent request is a unit of auditable autonomy:
  every intake, step, block, evidence artifact, and the PR link is
  queryable from the request record — the same discipline as ADR-020's
  task records.
- The "no auto-merge" rule is architectural, not a comment: the
  runner has no merge capability at all (it is not granted one), so
  the invariant cannot be bypassed by a prompt or a flag.
- Real GitHub and SyteLine behavior is **REQUIRES REAL SYTELINE /
  REAL GITHUB**; the state machine, intake validation, gating, and
  blocked conditions are **VALIDATED IN CI** in the code PR.

## Validation status (docs PR)

This ADR is the design record. The code PR must validate: lifecycle
transitions (create → claim → in_progress → awaiting_review / blocked
/ cancelled), atomic claim, tenant + requester scoping, both
submission shapes (multipart and JSON-inline), per-part validation,
`missing-current-form-xml` / `missing-production-original` /
`trn-prd-drift` / `attachment-quarantined` blocking, no-merge
capability (no code path that can merge), authorization
(`FORBIDDEN` without `syteline:forms`), and both kill switches
default-off. **REQUIRES REAL GITHUB / REAL SYTELINE:** end-to-end
build of a real form project and a real review PR.
