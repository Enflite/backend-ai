# SyteLine UI Automation — Operator Guide

The assistant can drive the SyteLine web client in a real browser
session and complete multi-step tasks as the user — logging in with the
user's own SyteLine credentials, navigating to forms, filling fields,
clicking buttons, and reading results back. Design: ADR-019.

> **Honesty note:** the docs in this guide describe the full design.
> Playwright driving a real SyteLine web client is **REQUIRES REAL
> SYTELINE** — it has never been exercised in this sandbox. The
> FakeDriver (deterministic, in-memory) path is **VALIDATED IN CI**.

## Who can use it

UI driving is privileged: acting as a user inside the ERP can do
anything that user can do. The `syteline:ui` permission is granted to
**Admin and AI Admin only** — never the User role. A user drives
SyteLine only as themselves: their own stored credentials, or the
tenant service account. There is no cross-user impersonation.

The feature is also behind a master kill switch. If
`SYTELINE_UI_ENABLED=false` (the default), every `syteline.ui.*` tool
fails fast with a clear error.

## Environment variables

All set in the backend environment (`backend/.env`; production via the
secret manager — never committed). None of these have placeholder
values you should keep: placeholders are rejected at boot.

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `SYTELINE_UI_ENABLED` | no | `false` | Master kill switch. Everything UI fails fast when off. |
| `SYTELINE_UI_URL` | yes (to run) | — | HTTPS URL of the SyteLine web client, e.g. `https://syteline.example.com/...`. Must be `https`. |
| `SYTELINE_UI_USERNAME` / `SYTELINE_UI_PASSWORD` | no | — | Tenant/service-account fallback credentials, used only when the user has no stored credentials. Never logged. |
| `CREDENTIAL_STORE_KEY` | yes (for the credential store) | — | ≥32 bytes, hex or base64. AES-256-GCM key for stored passwords. Placeholder values are rejected; the credential feature refuses to boot without it (fail closed). |
| `SYTELINE_UI_SESSION_IDLE_MS` | no | `300000` (5 min) | Browser session idle TTL. |
| `SYTELINE_UI_SESSION_MAX_MS` | no | `1800000` (30 min) | Absolute max browser session duration. |
| `SYTELINE_UI_STEP_TIMEOUT_MS` | no | `30000` (30 s) | Per-driver-step timeout (inside `AI_TOOL_TIMEOUT_MS`). |
| `SYTELINE_TASK_RUNNER_ENABLED` | no | `false` | Master kill switch for the task-agent runner. When off, tasks stay `assigned` and nothing runs — even if task tools are used. |
| `SYTELINE_TASK_RUNNER_INTERVAL_MS` | no | `15000` (15 s) | Poll interval for the task runner to pick up `assigned` tasks. |

`CREDENTIAL_STORE_KEY` generation (run once, store in the secret
manager):

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Windows setup (Enflite runs Windows)

Playwright supports Windows natively; no .bat launcher is needed
because the browser runs in-process in the backend. Setup on the
machine hosting the backend:

1. Install the backend's dependencies as usual (`npm ci` in
   `backend/`). Playwright is an **optional, lazy dependency** — the
   backend boots without it.
2. Install the Chromium browser binary Playwright drives:

   ```powershell
   npx playwright install chromium
   ```

3. Confirm the feature prerequisites: `SYTELINE_UI_ENABLED=true`,
   `SYTELINE_UI_URL` reachable from the backend host, and
   `CREDENTIAL_STORE_KEY` set.
4. Run the backend as a Windows service (or scheduled task) so the
   browser sessions survive logoff; Chromium needs no interactive
   desktop — it runs headless.

Notes:

- Headless Chromium is the default; the driver never needs a visible
  desktop.
- If Playwright is not installed, UI sessions fail fast with an
  explicit error naming the missing dependency — the backend itself
  keeps running.
- CI and machines without browser binaries exercise the deterministic
  `FakeDriver` instead; nothing in `npm test` / `npm run typecheck` /
  `npm run build` requires real Chromium.

## Credential save / rotate / revoke flow

Credentials are saved **per user** — the `userId` comes from the auth
context, never from tool arguments, so a user can only ever store
their own. Save is an upsert: saving again rotates.

Typical flow (in chat, Admin/AI-Admin role):

1. **Save** — `syteline.ui.saveCredentials { username, password, label? }`.
   Destructive: requires explicit confirmation. The `password` argument
   is declared in `secretParams`, so it is stored as `"[REDACTED]"` in
   persisted `tool_executions` and in audit metadata — it never lands in
   any log, transcript store, or audit trail in clear. The password the
   user typed in their own chat message is inherent; the save flow
   exists so it is typed exactly once.
2. **Rotate** — save again with the new password. The old entry is
   replaced (upsert per user).
3. **Revoke** — `syteline.ui.deleteCredentials {}`. Destructive:
   requires explicit confirmation. The stored entry is removed; audit
   records `SYTELINE_CREDENTIAL_DELETED` with the username only.
4. **Inspect (non-secret)** — `syteline.ui.listCredentials {}` returns
   `username` / `label` / `updatedAt` only — never secret material.

At login time the session manager decrypts the password into memory,
uses it for the SyteLine form login, then zero-fills the buffer.
Credential precedence: the user's stored credentials first, then the
`SYTELINE_UI_USERNAME` / `SYTELINE_UI_PASSWORD` service-account
fallback from env. The secret never appears in tool output, errors, or
logs — failures go through `sanitizeReason`.

**Key rotation:** rotating `CREDENTIAL_STORE_KEY` invalidates every
stored credential (they cannot be decrypted with the new key).
Procedure: set the new key, have each user re-save their credentials,
verify a login, then retire the old key. There is no automatic
re-encryption — by design, so a compromised key cannot be "recovered"
from stored ciphertext.

## Session lifecycle

`UiSessionManager` enforces: **at most one active browser session per
(tenantId, userId)**. Sessions are short-lived:

- `syteline.ui.startSession {}` — acquires (or reuses) the user's
  session and logs in to `SYTELINE_UI_URL`. Non-destructive, but only
  runs on explicit user request.
- Idle longer than `SYTELINE_UI_SESSION_IDLE_MS` → the session is
  closed and released.
- Older than `SYTELINE_UI_SESSION_MAX_MS` → the session is closed and
  released, no matter what.
- `syteline.ui.endSession {}` — closes the browser now and writes a
  session-summary audit event.

Every acquire and release writes an audit event (see below). Session
records carry `{ sessionId, userId, tenantId, startedAt, lastUsedAt }`
— sessions are never shared across users or tenants.

## Task agents

One level above driving the browser by hand: **AI agents that complete
SyteLine tasks for you.** Hand the system a task in plain language —
"create this PO", "check why this order is late and update it", "run
the morning buyer routine" — and a server-side agent picks it up,
plans the steps, drives SyteLine as you (your saved-credential login),
does the work, and reports back with evidence. Design: ADR-020. The
UI-automation engine above (driver, session manager, credential store,
step semantics, approval gates) is the execution layer underneath;
this section is the task layer on top.

> **Honesty note:** like the driver itself, the task runner is
> **REQUIRES REAL SYTELINE** for real ERP work — it has never been
> exercised against a live SyteLine web client in this sandbox. Task
> lifecycle, claiming, planning, and the approval gate are
> **VALIDATED IN CI** via the deterministic FakeDriver.

### How to hand the AI a task

In chat (Admin/AI-Admin role — task tools require `syteline:ui`):

```
You:  Create a task: generate PO 450123 for vendor ACME, 500 units of
      item WIDGET-1, and confirm it. autoApproveWrites: true.
You:  Create a task: check why sales order SO-8841 is late and update
      it. autoApproveWrites: false — recon first, tell me what you'd do.
You:  List my tasks that are blocked.
You:  Show me task <taskId> — what steps ran, and the evidence.
You:  Cancel task <taskId>.
```

`title` is the short label (kanban card title); `goal` is the natural-
language objective the agent plans from. Tasks you create are owned by
you — `requesterUserId` comes from the auth context, never from tool
arguments. The agent always executes **as you**: your saved SyteLine
credentials, your UI session, never anyone else's.

### Task lifecycle (the kanban data model)

Tasks live in the tenant-scoped `syteline_tasks` collection. Statuses
map directly onto the kanban columns from Jake's 2026-09-22 ask:

| Status | Kanban column | Meaning |
|---|---|---|
| `assigned` | Assigned | Created, waiting for the runner |
| `in_progress` | In progress | Claimed by the runner and executing |
| `completed` | Completed | All steps ran; `resultSummary` written |
| `blocked` | Blocked | Stopped — see `blockedReason` (plan failed validation, a step failed, or awaiting write approval) |
| `cancelled` | — | Cancelled by the requester or an admin |

Lifecycle per task: **plan → execute → report**.

1. **Plan.** The runner calls the model with your goal and the
   available UI actions and requires a JSON task plan in the
   `runTaskPlan` DSL (the same five actions: `gotoForm`, `fillField`,
   `clickButton`, `readScreen`, `assertText`). The plan is zod-
   validated *before anything runs* — an invalid plan marks the task
   `blocked` with a reason.
2. **Execute.** The runner acquires your UI session and runs the steps
   sequentially: each step audit-logged (argument keys only), a
   screenshot captured per step (its `evidenceId` attached to the
   step), stopping at the first failure → `blocked` with a reason.
3. **Report.** `resultSummary` and per-step outcomes are written to the
   task. If the task was created from chat, an assistant message with
   the summary and evidence references is appended to that
   conversation. The task record itself is always the durable report —
   `syteline.task.get` shows every step, its status, and its evidence
   ids long after the conversation scrolls by.

Claiming is atomic (`assigned` → `in_progress` in one
`findOneAndUpdate`), so concurrent backends can never double-run a
task.

### Write approval inside tasks (`autoApproveWrites`)

"Write actions need a confirmation step" still holds — scoped to the
task. `autoApproveWrites: true` on task creation **is** the human's
explicit confirmation for that task's writes: recorded on the task,
bounded to that task's plan, auditable.

- **Default `false`:** the agent runs read-only reconnaissance
  (`gotoForm` / `readScreen`), then reports a proposed write plan and
  marks the task `blocked` with
  `blockedReason: 'awaiting-write-approval'`. To proceed, create a
  follow-up task with `autoApproveWrites: true`. (A dedicated
  `syteline.task.approveWrites` tool is the future seam; out of scope
  for this build.)
- **`true`:** write steps (`fillField`, `clickButton`, any write in
  the plan) execute inside this task without further per-step prompts.
  The approval covers exactly this task's recorded plan — nothing
  else.

The interactive destructive gate is unchanged: driving the browser by
hand in chat still requires explicit confirmation per write.

### When tasks don't run

The runner is dark by default. Two gates must both open before any
autonomous ERP work happens:

1. `SYTELINE_TASK_RUNNER_ENABLED=true` (default `false` — fail
   closed). When off, tasks stay `assigned` and nothing runs.
2. The requester holds `syteline:ui` (Admin / AI Admin only), and the
   task tools are behind the `SYTELINE_UI_ENABLED` kill switch like
   the rest of the UI family.

### Completion reports and evidence

A finished (or blocked) task carries: `status`, per-step log (`action`,
detail, `status`, timestamps, `evidenceIds[]`), `resultSummary` or
`blockedReason`, and — when created from chat — an assistant message
in the originating conversation. Evidence is screenshots stored
server-side, tenant-scoped: fetch them by `evidenceId`; the model
never receives raw pixels. To review a day's work: `syteline.task.list`
filtered by status — the kanban board's API contract (the board UI
itself is out of scope; `syteline.task.list` is what it would query).

### Worked example: PO Detail Report Viewer changes

A canonical example of the kind of multi-step SyteLine task agents are
built to complete (real walkthrough supplied by Jake, 2026-09-30): a
series of report-designer changes to the Purchase Order Detail Report
Viewer. The full lifecycle, end to end:

**Intake.** `syteline.task.create { title: "PO detail report viewer
changes", goal: "Make the PO detail report viewer changes: back it up
first, re-point the primary collection, regenerate, then add the
Terms & Conditions footer.", autoApproveWrites: true }` → `assigned`.

**Plan.** The agent's validated plan mirrors the walkthrough's
structure — and encodes its two standing lessons:

1. **Backup FIRST (standing safety rule).** Open FormSync, default
   scope, export the Purchase Order Detail Report Viewer to a file
   before touching anything. No backup, no changes.
2. **Scope decision.** Work directly in default scope — the detail
   viewer isn't in use, so changes land safely; changes to the live
   Purchase Order Report form (which would affect Purchasing
   immediately) are explicitly deferred to a live meeting, out of
   this task's scope.
3. Re-point the primary collection to the customized collection from
   the simple report (UE_FL-SL purchase order report) and set the
   matching custom load method.
4. Save, regenerate the form (close/reopen).
5. Build the T&Cs group-footer: new group-footer region on the main
   flex layout (group property PO, page break before, ~92 × 30);
   nested three-column flex layout (1-3-1 proportions); vertical flex
   with five statics; T&C captions pasted in, left-justified, "no
   colon" on each static.
6. **Truncation gotcha (standing lesson).** Long text pasted into a
   component *name* throws a string-truncation save error — keep
   component names short, put long text only in the string
   value/caption.

**Execute.** The runner acquires the requester's session (their saved
credentials), runs the steps in order — each step audit-logged (keys
only) with a screenshot `evidenceId` attached — and stops at the first
failure with a `blocked` reason naming the failing step.

**Report.** `syteline.task.get` returns `completed` with a
`resultSummary` ("Backup exported to <path>; primary collection now
UE_FL-SL purchase order report; custom load method set; form
regenerated; T&Cs group footer added with 5 statics") plus the
per-step log and evidence ids. Because the task came from chat, the
same summary lands as an assistant message in the originating
conversation.

Two things this example teaches the plan-generation side: the agent
must know that **backup comes before everything** (FormSync export,
default scope), and that report-designer text handling has a known
failure mode — paste long text via a text edit and keep names short,
or the save blows up on truncation. Both are the kind of operational
lore that lives in the plan prompt, not in the user's head.

## Tool reference (summary)

Full contracts in `docs/api.md`. At a glance:

| Tool | Destructive | What it does |
|---|---|---|
| `syteline.ui.startSession` | no | Acquire the user's browser session; log in to `SYTELINE_UI_URL` |
| `syteline.ui.gotoForm` | no | Navigate to a form via the SyteLine form URL convention (`formName` must match `^[A-Za-z0-9_]+$`) |
| `syteline.ui.readScreen` | no | Return the ARIA/accessible snapshot text of the current screen |
| `syteline.ui.screenshot` | no | Store evidence server-side (tenant-scoped); returns `{ evidenceId, capturedAt }` — the model never receives raw pixels |
| `syteline.ui.fillField` | **yes** | Fill a field by accessible label — requires explicit confirmation |
| `syteline.ui.clickButton` | **yes** | Click a button by accessible label (may submit/save) — requires explicit confirmation |
| `syteline.ui.runTaskPlan` | **yes** | Execute a bounded (max 25 steps), zod-validated JSON task-plan: `gotoForm` / `fillField` / `clickButton` / `readScreen` / `assertText`; sequential, stops at first failure, per-step outcomes — requires explicit confirmation |
| `syteline.ui.endSession` | no | Close the browser; write the session-summary audit |
| `syteline.ui.saveCredentials` | **yes** | Save/rotate the caller's credentials (`secretParams: ['password']`) — requires explicit confirmation |
| `syteline.ui.deleteCredentials` | **yes** | Revoke the caller's stored credentials — requires explicit confirmation |
| `syteline.ui.listCredentials` | no | Username/label/updatedAt only; no secret material |

### Task-agent tools (`syteline.task.*`, ADR-020)

All require `syteline:ui` (Admin / AI Admin only) in addition to
`tool:use`, ride the `SYTELINE_UI_ENABLED` kill switch, and are never
offered on cloud turns when customer or finance categories are
enforced (same `syteline.*` privacy-routing treatment). The runner
itself additionally requires `SYTELINE_TASK_RUNNER_ENABLED=true`.

| Tool | Destructive | What it does |
|---|---|---|
| `syteline.task.create` | no | Create an `assigned` task: `{ title, goal, autoApproveWrites? }` (default `false`); ownership from auth context; `autoApproveWrites: true` is the human's explicit, task-scoped write confirmation |
| `syteline.task.list` | no | List the requester's (or, for admins, tenant's) tasks; optional `status` filter — the kanban board's API contract |
| `syteline.task.get` | no | Full task record: status, plan, per-step log with evidence ids, `resultSummary` / `blockedReason` |
| `syteline.task.cancel` | **yes** | Cancel a task (ends work in flight); requester or admin only — requires explicit confirmation |

Destructive tools are gated by the agentic loop's existing explicit-
confirmation flow (`destructive:true`) — UI writes get no new bypass.
Privacy routing treats the whole family as `syteline.*`: these tools
are never offered on cloud turns when customer or finance categories
are enforced, and capability prediction routes UI turns to local
Enflite preemptively (see `docs/privacy-routing.md`).

## Audit events

Query with `GET /api/v1/audit?action=…` (`audit:read`). Every event
carries tenant/user context and **never carries secret material** —
usernames only, passwords nowhere.

| Action | When | Metadata |
|---|---|---|
| `SYTELINE_CREDENTIAL_SAVED` | Credentials saved/rotated | `username` only |
| `SYTELINE_CREDENTIAL_DELETED` | Credentials revoked | `username` only |
| `SYTELINE_UI_LOGIN` | SyteLine login attempt | `username`, `success` / `failure` — never the secret |
| `SYTELINE_UI_SESSION_ACQUIRED` | Browser session acquired | `sessionId` |
| `SYTELINE_UI_SESSION_RELEASED` | Session closed (idle/max/explicit), with reason | `sessionId`, `reason` |
| `TOOL_EXECUTED` | Any `syteline.ui.*` call (existing tool audit) | sanitized reason; `saveCredentials` params carry `password: "[REDACTED]"` |
| `AGENTIC_LOOP_STEP` | Each agentic-loop step, including `runTaskPlan` steps | argument **keys** only |
| `SYTELINE_TASK_CREATED` | Task created via `syteline.task.create` | `taskId`, `title`, `autoApproveWrites` |
| `SYTELINE_TASK_STARTED` | Runner atomically claims a task (`assigned` → `in_progress`) | `taskId` |
| `SYTELINE_TASK_STEP` | Each executed plan step | `taskId`, `action`, argument **keys** only |
| `SYTELINE_TASK_COMPLETED` | Task finished all steps | `taskId` |
| `SYTELINE_TASK_BLOCKED` | Task stopped (invalid plan, step failure, awaiting write approval) | `taskId`, `blockedReason` |
| `SYTELINE_TASK_CANCELLED` | Task cancelled by requester or admin | `taskId` |

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| UI tools fail immediately with "feature disabled" | `SYTELINE_UI_ENABLED` is `false`/unset | Set `SYTELINE_UI_ENABLED=true` and restart |
| `startSession` errors about Playwright unavailable | Playwright not installed | `npm i playwright` (optional dep) + `npx playwright install chromium` |
| `saveCredentials` refuses to boot / errors | `CREDENTIAL_STORE_KEY` missing, malformed, or a rejected placeholder | Generate a fresh ≥32-byte key (see above); never reuse a documented example |
| Login fails (`SYTELINE_UI_LOGIN` failure) | Wrong stored creds, or `SYTELINE_UI_URL` unreachable from the backend host | Re-save credentials; check the URL is `https` and reachable from the backend machine (not just your laptop) |
| `gotoForm` rejected | `formName` contains characters outside `^[A-Za-z0-9_]+$` | Use the plain form name; the driver builds the URL itself |
| `runTaskPlan` stops mid-plan | First failing step aborts the plan by design | Read the per-step outcomes, fix the failing step's label/text (screens change; ARIA labels are the selector), re-run |
| Session disappears between turns | Idle TTL or max duration expired | Re-run `startSession`; tune `SYTELINE_UI_SESSION_IDLE_MS` / `SYTELINE_UI_SESSION_MAX_MS` if the workflow legitimately needs longer |
| `TOOL_FORBIDDEN` on UI tools | Caller lacks `syteline:ui` (User role) | UI driving is Admin/AI-Admin only — grant the role or have an admin run it |
| Task stuck in `assigned`, never runs | `SYTELINE_TASK_RUNNER_ENABLED` is `false`/unset | Set `SYTELINE_TASK_RUNNER_ENABLED=true` and restart; check `SYTELINE_UI_ENABLED` too |
| Task went `blocked` with `awaiting-write-approval` | `autoApproveWrites` was `false` and the plan reached write steps | Intended: the agent did read-only recon and proposed a plan. Create a follow-up task with `autoApproveWrites: true` to approve this task's writes |
| Task went `blocked` on plan validation | Model-generated plan failed zod validation (unknown action, bad shape) | Read `blockedReason`; restate the goal more concretely and create a new task |
| Task went `blocked` mid-execution | First failing step aborts the plan by design | `syteline.task.get` → per-step outcomes + evidence ids; fix the failing step's label/text (screens change; ARIA labels are the selector) and create a new task |
| `syteline.task.cancel` returns `TOOL_FORBIDDEN` | Caller is neither the requester nor an admin | Task cancellation is owner-or-admin only |
| Browser works locally but not as a service | Service account lacks a user profile temp dir, or proxy env vars missing | Run the service under a dedicated account with a writable profile; mirror `HTTP_PROXY`/`HTTPS_PROXY` into the service environment |

When reporting a UI-automation problem, include the `sessionId` and the
relevant audit events — never paste credentials, screenshots of login
fields, or ARIA snapshots containing customer data into a ticket.
