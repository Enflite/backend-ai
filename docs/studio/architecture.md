# SyteLine Automation Studio — Architecture

**Status:** backend foundation shipped (connections, capability probe, action
catalog, single-action test execution) **plus the automation backend
(Wave 2)**: automation model (`studio_automations`), compile-to-Flow,
manual/scheduled/webhook/event triggers, deploy with the destructive-action
approval gate, dry-run, and studio runs. The builder UI is a later slice.

## The one decision

**Automations compile to the existing Flows platform.** An automation is a
*flow* (the versioned, deterministic pipeline from ADR-022) plus a
*trigger* plus a *deployment record*. The Studio builds no workflow engine:
no new runner, no new scheduler, no new step semantics. It builds the
*substrate* a flow author stands on — named SyteLine connections, a typed
action catalog bound to real operations, and a "run this one step against
the real thing" test path — and emits flow definitions the Flows platform
already knows how to version, run, and audit.

So the Studio's product surface is:

1. **Connections** — named, encrypted, capability-probed SyteLine endpoints.
2. **Action catalog** — typed actions, honestly gated on probes.
3. **Single-action test** — Postman-style execution with request/response
   inspection, against the real upstream.
4. *(later)* **Automation builder** — assembles flows from catalog actions,
   compiles to a `.flow.json`, deploys via the Flows API.
5. *(later)* **Triggers & deployments** — schedules (the Schedules API) and
   event triggers that start flow runs.

## The two execution substrates

An action executes against one of two substrates:

| Substrate | What it is | Today |
|---|---|---|
| `api` | The SyteLine REST adapter: fixed paths under a connection's `baseUrl` with a bearer token (`backend/src/studio/`) | Read-only GETs; write ops defined in the catalog as `supported: false` until the upstream serves them |
| `ui` | The task-queue UI runner (`backend/src/syteline/ui/`): Playwright drives SyteLine as the user, with encrypted per-user credentials and per-step audit | Exists and runs tasks; not yet addressable as catalog actions |

The Studio's catalog currently lists `api`-substrate actions only. When the
UI substrate becomes catalog-addressable, its actions get the same shape —
typed params, `destructive` flag, probe gating — with substrate `'ui'`.

## Automations (Wave 2)

An automation (`studio_automations`, tenant-scoped) is `{ name, title,
description, status: draft|active|paused|failed, trigger, steps[],
deployment }`. Step kinds: `action` (catalog actionId + connectionId +
params + retries/continueOnError), `condition` (a flow `when` expression
with then/else step ids), `verify` (re-fetch action + field assertions over
the response body), `log` (message template).

**Compile** (`compileAutomation()`, `backend/src/studio/automations/`) lowers
steps to a flow definition — it never builds a workflow engine:
- `action` → a `tool` step calling `studio.executeAction` (reads) or
  `studio.executeWriteAction` (destructive catalog actions — the tool
  gateway's confirmation gate applies). Params pass through verbatim;
  `{{inputs.x}}` / `{{steps.y.output...}}` templates resolve at run time.
- `condition` → a flow `condition` step (then/else rewired to compiled ids).
- `verify` → a fetch tool step, one `condition` step per assertion
  (`{{steps.<fetch>.output.data.<path>}} == '<value>'` — assertion paths
  are body-relative; the action tool's output envelope is
  `{ status, data, durationMs }`), and a `studio.fail` tool step. Each
  assertion's `then` jumps to the next assertion (or the next automation
  step); every `else` jumps to the fail step, which blocks the run. The
  fail step sits directly after the last assertion and the last assertion's
  `then` jumps *over* it, so normal flow never falls through into it.
- `log` → a `tool` step calling `studio.log` (audited as
  `STUDIO_AUTOMATION_LOG`).

Every compiled automation ends with a terminal `__complete` log step, and
its flow name is the deterministic `studio-<automationId>`.

**Triggers** — `manual` (fire on demand), `scheduled` (a Schedules API
schedule targeting the flow — reused, not duplicated), `webhook`
(`POST /studio/hooks/:token` fires a run; the 256-bit token is stored as a
sha256 hash, returned exactly once at deploy, rotated via
`POST /:id/webhook/rotate`), and `event` (**V1 is poll-based and labeled as
such**: a schedule runs a generated `studio-<id>-watch` flow that snapshots
the watched value in `studio_snapshots` via `studio.snapshotCheck` and
fires the automation flow through a subflow step on detected change).

**Deploy** (`POST /:id/deploy`) compiles, publishes a new flow version,
points the live alias at it, wires the trigger, and marks the automation
active. **Destructive gate**: when any step uses a destructive catalog
action, deploy requires explicit `confirmDestructive: true` in the body —
otherwise `409 STUDIO_DESTRUCTIVE_CONFIRM_REQUIRED` listing the steps.
Destructive automations are never deployed silently; the approval rides the
trigger as `confirmWrites`. Undeploy pauses/removes the trigger (schedules
paused, webhook token invalidated) and marks the deployment superseded;
published flow versions stay as immutable history. Deleting an automation
tears down its triggers and studio-managed flows first — a deleted
automation never keeps firing.

**Dry-run** (`POST /:id/test`) executes the draft's steps without the flow
runner: non-destructive steps run for real against the connection's
upstream (same shared execution core as the test endpoint and the flow
tools — probe-gated, token zero-filled); destructive steps are **skipped,
never executed**. Returns per-step
`{ stepId, kind, status, skipped, request?, response?, durationMs?, error?, detail? }`.

**Runs** — `GET /studio/runs` lists `flow_runs` filtered to studio flow
names (`studio-` prefix; `?automationId=` narrows to one automation, watcher
runs included as `kind: 'watcher'`); `GET /studio/runs/:id` returns the run
with its per-step log (output *shapes* only, per the Flows platform's
ADR-004 rule — values never persist).

**Honesty rules carried over**: an action executes only when its operation
probed `ok` on the connection (`STUDIO_ACTION_UNPROBED` otherwise); write
actions the upstream lacks report `STUDIO_ACTION_UNSUPPORTED` and never
execute; tokens never appear in logs, audit, or responses. Everything is
behind `FLOWS_ENABLED` (403 `FEATURE_DISABLED` when off); scheduled/event
triggers additionally require `SCHEDULES_ENABLED`.

## API surface (automation slice)

- `GET /api/v1/studio/automations` — list (`studio:run`)
- `POST /api/v1/studio/automations` — create (`studio:manage`)
- `GET /api/v1/studio/automations/:id` — one automation (`studio:run`)
- `PATCH /api/v1/studio/automations/:id` — update; editing a deployed
  automation returns it to draft (edits take effect on next deploy)
  (`studio:manage`)
- `DELETE /api/v1/studio/automations/:id` — delete + trigger/flow teardown
  (`studio:manage`)
- `POST /api/v1/studio/automations/:id/test` — dry run (`studio:run`)
- `POST /api/v1/studio/automations/:id/run` — manual fire (`studio:run`)
- `POST /api/v1/studio/automations/:id/deploy` — deploy
  (`studio:manage`; 409 without `confirmDestructive` when destructive)
- `POST /api/v1/studio/automations/:id/undeploy` — undeploy
  (`studio:manage`)
- `POST /api/v1/studio/automations/:id/webhook/rotate` — rotate the webhook
  token (`studio:manage`)
- `GET /api/v1/studio/runs[?automationId=&status=]` — studio runs
  (`studio:run`)
- `GET /api/v1/studio/runs/:id` — run detail with per-step log
  (`studio:run`)
- `POST /api/v1/studio/hooks/:token` — webhook fire (token-gated, no
  session auth, rate-limited)

Audited: `STUDIO_AUTOMATION_CREATED/UPDATED/DELETED/DEPLOYED/UNDEPLOYED/
TESTED/RUN`, `STUDIO_WEBHOOK_FIRED/ROTATED`, `STUDIO_AUTOMATION_LOG`.

## Connection & capability model

- **Named connections** live in Mongo (`studio_connections`), tenant-scoped,
  with a per-tenant unique name, an environment label (TRN / PRD / …), a
  base URL, and an AES-256-GCM encrypted bearer token (the shared
  `credentialCrypto` helper; the token is never logged, returned, or audited
  in cleartext, and is zero-filled after each request-time use).
- **The env-backed `default` connection** is `SYTELINE_BASE_URL` /
  `SYTELINE_API_TOKEN` presented as a connection named `default`. It is not
  persisted, is read-only through the API, and keeps all current behavior
  working with zero migration.
- **Capability probe** (`POST /:id/test`, also run on save): hits the
  connection's upstream for the 7 known GET endpoints plus the documented
  candidate write endpoints, and stores per-operation status
  (`ok` / `unsupported` / `error`). Write candidates are probed with
  `OPTIONS` only — never a mutating request against an unknown upstream.
- **Honesty rule:** an action runs only when its operation probed `ok` on
  the connection being used. Unprobed → "test the connection first".
  Unsupported → the catalog shows it with `supported: false` and the reason.
  There are no fake operations anywhere in the Studio.

## What's deliberately deferred

- **Write operations** (`syteline.record.create/update/delete`,
  `syteline.ido.invoke`): defined in the catalog and flagged
  `destructive: true`, gated behind a successful capability probe AND the
  deploy/run destructive approval gate (Wave 2). The current upstream serves
  no write endpoints, so they report `supported: false` with the reason and
  never execute. When the upstream grows write endpoints, the probe flips
  them on — no catalog rewrite needed.
- **True push event triggers**: the `event` trigger is poll-based in V1
  (honestly labeled) — a real push/event-bus trigger is future work.
- **The builder UI**: the frontend Automation Studio views exist as shells
  (Wave 1); the visual builder that authors automations is a later slice —
  the backend API above is the contract it will build against.

## API surface (this slice)

- `GET /api/v1/studio/connections` — list (`studio:run`)
- `POST /api/v1/studio/connections` — create + probe (`studio:manage`)
- `GET /api/v1/studio/connections/:id` — one connection (`studio:run`)
- `PATCH /api/v1/studio/connections/:id` — update + re-probe (`studio:manage`)
- `DELETE /api/v1/studio/connections/:id` — delete (`studio:manage`)
- `POST /api/v1/studio/connections/:id/test` — connectivity + capability probe (`studio:run`)
- `GET /api/v1/studio/actions[?connectionId=]` — catalog, support evaluated per connection (`studio:run`)
- `POST /api/v1/studio/actions/test` — execute one action against the real upstream (`studio:run`)

Connection create/update/delete and every action test execution are audited
(`STUDIO_CONNECTION_CREATED/UPDATED/DELETED/TESTED`, `STUDIO_ACTION_TESTED`).
