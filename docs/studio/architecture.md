# SyteLine Automation Studio — Architecture

**Status:** backend foundation shipped (connections, capability probe, action
catalog, single-action test execution). The builder UI and automation
compilation are later slices.

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

- **Event triggers** (webhooks / polling for "when X changes in SyteLine"):
  not designed here. The trigger story starts with the Schedules API (cron)
  when the builder slice lands.
- **Write operations** (`syteline.record.create/update/delete`,
  `syteline.ido.invoke`): defined in the catalog and flagged
  `destructive: true`, but gated behind a successful capability probe. The
  current upstream serves no write endpoints, so they report
  `supported: false` with the reason. When the upstream grows write
  endpoints, the probe flips them on — no catalog rewrite needed.
- **Destructive enforcement**: the catalog *flags* destructive actions;
  approval flows and execution guards come in a later slice.
- **Automation compilation** (builder → `.flow.json` → deploy): the next
  slice after this foundation, using the Flows API (`/api/v1/flows`).

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
