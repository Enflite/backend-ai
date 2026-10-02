# ADR-022: Flows — deterministic, versioned pipelines (first of the "big four")

**Status:** Accepted

## Context

Jake (2026-10-02, from the Runtype API review): the platform builds, in
order — **1) Flows**, 2) Schedules API, 3) client tokens, 4) Batch.
Flows are first.

Product shaping from Jake: flows are **deterministic versioned
pipelines** — versioned runbooks, config-as-code, PR-reviewed, with an
agent-escalation seam. Batch is flows over SyteLine entity sets; the
Schedules API feeds the "what did the AI do today" view; client tokens
are scoped browser tokens for the Ask Enflite AI button.

The first consumer is the platform coordinator plus the **SyteLine
Form AI Agent pipeline** (ADR-021): the ADR-021 §6 sequence
(scaffold → record originals → compare → build → docs → open PR)
becomes a flow definition instead of bespoke runner code.

Why a separate primitive: ADR-020's task agents plan with the model
(a model-generated plan, zod-validated). That is the right shape for
open-ended tasks ("check why this order is late"), but it is wrong for
repeatable runbooks — a model re-planning the form-customization
workflow on every request is nondeterministic, unreviewable as code,
and impossible to version. Flows are the deterministic counterpart:
a fixed, named step graph, reviewed in a PR like any other config,
executed the same way every time. The two compose: a flow can contain
a bounded agent step (the escalation seam) where a fuzzy sub-step
genuinely needs the model, but the graph itself never changes at
runtime.

## Decision

### 1. A flow is a JSON file: `flows/<name>.flow.json` (config-as-code, PR-reviewed)

Flow definitions live in the repo under `flows/` and are reviewed like
code. Fields:

| Field | Required | Shape |
|---|---|---|
| `name` | yes | `^[a-z0-9-]+$` — the flow's identity |
| `title` | yes | Human-readable title |
| `description` | yes | What the flow does and when to run it |
| `inputs` | yes | Map of `{ type: string \| number \| boolean \| string[], required: boolean, description: string }` |
| `outputs` | yes | Map of `{ type, description }` — what a completed run produces |
| `steps` | yes | Ordered array of steps (decision 2) |
| `onError` | no | `"stop"` (default) — stop-on-first-failure |

*Rationale:* Jake's "versioned runbooks" shaping — the runbook is a
file in the repo, not a database row created in an admin UI, so every
change gets review, history, and rollback for free.

### 2. Four step kinds, discriminated by `kind`

**`tool`** — invoke a registered platform tool through the tool
gateway:

```json
{ "id": "build_xml", "kind": "tool",
  "tool": "syteline.form_add_field",
  "params": { "formName": "{{inputs.formName}}" },
  "timeoutMs": 120000, "retries": 1, "continueOnError": false }
```

- `params` support templates (`{{inputs.x}}`,
  `{{steps.<id>.output.<path>}}`; decision 3).
- `timeoutMs`, `retries`, `continueOnError` (default `false`) are
  optional.
- The step executes via the tool gateway **with the run requester's
  auth** — each tool's own permission check applies exactly as if the
  requester had called it directly. Capability scoping is by
  construction: a flow cannot grant the requester powers they don't
  have.
- Destructive tools need `confirmWrites: true` on the run request
  (decision 5), or the run blocks before executing them.

**`subflow`** — run another flow as a step:

```json
{ "id": "preflight", "kind": "subflow",
  "flow": "syteline-backup-check", "alias": "live",
  "inputs": { "formName": "{{inputs.formName}}" } }
```

- `version?` (number) pins an exact published version; `alias?`
  (`"live"` default) resolves to whatever the alias points at.
  Exactly one of `version`/`alias` may be given; omitted means
  `"live"`.

**`agent`** — bounded LLM escalation for a genuinely fuzzy step:

```json
{ "id": "draft_summary", "kind": "agent",
  "prompt": "Summarize these build results for the requester: {{steps.build_xml.output}}",
  "outputSchema": { "type": "object",
    "properties": { "summary": { "type": "string" } },
    "required": ["summary"] },
  "maxTokens": 1000, "timeoutMs": 60000 }
```

- The model's output **must validate against `outputSchema`**; a
  validation failure fails the step. This is the escalation seam:
  the graph stays deterministic, but one step may use the model
  inside a schema-shaped box.
- `maxTokens`, `timeoutMs` optional.

**`condition`** — deterministic branch, no LLM:

```json
{ "id": "drift_check", "kind": "condition",
  "when": "'{{steps.build_xml.output.drift}}' == 'true'",
  "then": "report_drift", "else": "write_docs" }
```

- `when` is a template, or a `<template> == <literal>` comparison —
  nothing else. There is deliberately no general expression language.

*Rationale:* four kinds cover the shapes the platform needs (call a
tool, compose a flow, ask the model something fuzzy, branch on a
fact) without turning flow definitions into a programming language.
The ADR-019 scope-creep rule applies here too: growing the step
kinds is a new ADR.

### 3. Strict template resolution

Templates are `{{inputs.x}}` and `{{steps.<id>.output.<path>}}`
only. Resolution is strict: an unknown path fails the step with
`TEMPLATE_RESOLUTION_ERROR` — never an empty string, never a guess.
No arbitrary code in templates, ever (same discipline as the
"authorization in application code, never in prompts" rule: the
runner resolves templates in code before any tool or model sees
them).

### 4. Registry, versioning, and aliases (Mongo `flows`)

Definitions live in the tenant-scoped Mongo collection `flows`.
Publishing is explicit and immutable:

- `POST /flows/:name/versions` publishes the current definition as
  an immutable version: `{ number, definitionHash, publishedBy,
  publishedAt }`. Published versions never change.
- The `live` alias points at a version. `POST /flows/:name/alias`
  moves an alias and requires `If-Match: <revision>` (compare-and-
  swap); a stale revision returns `412`.
- `POST /flows/ensure` converges `flows/*.flow.json` from the repo
  into the registry (the config-as-code deploy path: merge the PR,
  then ensure).
- `GET /flows/:name/pull` exports a definition back out of the
  registry.

*Rationale:* the runbook is reviewed as a file (decision 1), but the
runner executes a published, hashed, immutable version — so "what
ran" is always answerable after the fact. The `live` alias gives
operators a single safe pointer to move after verifying a new
version; `If-Match` prevents two admins from racing the alias move.

### 5. Runs: the execution API

| Method | Path | Purpose |
|---|---|---|
| POST | `/flows/:name/runs` | Start a run: `{ inputs, version? \| alias? ("live" default), confirmWrites? (default false), sync? (default false) }` |
| GET | `/flows/runs` | List runs; optional `status` filter — the kanban-board query for flows |
| GET | `/flows/runs/:runId` | Poll a run: status, step log, outputs / blocked reason |
| GET | `/flows/runs/:runId/events` | SSE stream of run events |
| POST | `/flows/runs/:runId/cancel` | Cancel a run (ends work in flight) |

- **Async by default:** `202 { runId }`. `sync: true` waits up to a
  server-side cap, then falls back to `202` — the client always ends
  up with a `runId` it can poll.
- **Idempotency:** the `Idempotency-Key` header makes a repeated
  request return the existing run. Same key with a *different*
  request body returns `409` — a replayed key and a colliding key
  are different situations and must not be conflated.
- **Lifecycle:** `queued → running → completed | blocked |
  cancelled`. Stop-on-first-failure (`onError: "stop"`, the
  default): a failed step marks the run `blocked` with a reason —
  unless that step set `continueOnError: true`, in which case the
  run continues and the failure is recorded on the step.
- **Writes gate:** a run whose steps include destructive tools
  blocks unless the run request carried `confirmWrites: true`
  (decision 2, tool kind). This is the flow equivalent of the
  ADR-020 `autoApproveWrites` seam: one explicit, run-scoped,
  auditable confirmation.

### 6. Every step is audit-logged with evidence

Same discipline as the ADR-020 task runner: each step writes an
audit event with its id, kind, status, timestamps, and evidence
(tool outputs by reference, never secrets in clear). A run's
step log plus its published version hash is the complete,
replayable record of what ran — the "what did the AI do today" raw
material the Schedules API will later feed on.

### 7. Fail-closed flags and permissions

Two independent kill switches, both default `false` (fail closed):

- `FLOWS_ENABLED` — the API surface. When off, every `/flows`
  endpoint fails fast with `FEATURE_DISABLED`.
- `FLOW_RUNNER_ENABLED` — the runner. When off, runs stay `queued`
  and nothing executes.

Permissions:

- `flows:manage` — flow CRUD, publish, alias moves, `ensure`
  (Admin / AI Admin only).
- `flows:run` — create runs, poll, stream events, cancel.

Privacy routing treats flows like the other SyteLine-adjacent
surfaces: a flow that drives `syteline.*` tools is never offered on
cloud turns when customer or finance categories are enforced (see
`docs/privacy-routing.md`) — the tool-level checks inherit
automatically through the gateway.

## Consequences

- The first flow replaces bespoke ADR-021 runner code with a
  reviewed JSON file: the SyteLine Form AI Agent pipeline
  (scaffold → record originals → compare → build → docs → open PR)
  becomes `flows/syteline-form-customization.flow.json`. The runner
  becomes generic; new runbooks are data, not code.
- Publishing is the deploy: merging the JSON is not enough — an
  operator (or `ensure` in the deploy pipeline) must publish a
  version and move `live`. Stale `live` aliases are the expected
  failure mode; `GET /flows/:name` surfaces the alias → version →
  hash chain so it is always inspectable.
- The strict-template rule (`TEMPLATE_RESOLUTION_ERROR`) trades a
  little authoring convenience for a guarantee: a flow can never
  silently run with a missing input.
- `condition` is deliberately inexpressive. Anything needing real
  logic is either a tool (deterministic code) or an `agent` step
  (schema-boxed model output). If a third shape emerges, it is a
  new ADR, not a quiet extension.

## Design hooks (future — NOT built now)

Documented here so the schema doesn't paint them out; none of this
ships in the flows build:

- **Schedules triggering flows** — the Schedules API (big-four #2)
  will target flow names + aliases.
- **Batch running a flow over a record set** — big-four #4: one
  parent run, per-record child runs, surfaced as one kanban card.
- **Client-token-scoped flow invocation** — big-four #3: the Ask
  Enflite AI button invoking named flows under a scoped token.
- **Flow-to-tool conversion** — a published flow exposed as a
  callable tool in the agentic loop.

## Validation status (docs PR)

This ADR is the design record. The code PR must validate: the flow
JSON schema (valid definitions accepted, malformed rejected);
`name` pattern enforcement; immutable versions (republish never
mutates); alias moves with `If-Match` (stale revision → `412`);
`ensure` convergence and `pull` export round-trip; the run
lifecycle (`queued → running → completed | blocked | cancelled`);
idempotency (repeat key → existing run; same key + different body
→ `409`); sync/async behavior (sync falls back to `202` past the
cap); `continueOnError` vs. stop-on-first-failure → `blocked`;
`TEMPLATE_RESOLUTION_ERROR` on unknown paths; per-step audit
events; the writes gate (destructive tool step without
`confirmWrites` → blocked); both kill switches default-off
(`FEATURE_DISABLED` / runs stay `queued`); authorization
(`FORBIDDEN` without `flows:manage` / `flows:run`); tenant
isolation of the `flows` collection and run records.
**REQUIRES REAL TOOL EXECUTION:** `tool`-kind steps against live
tools and `agent`-kind steps against the model gateway exercise
real integrations and are validated against the same harnesses as
their underlying tools — the flow schema, lifecycle, gating, and
audit behavior above are **VALIDATED IN CI** with fakes.
