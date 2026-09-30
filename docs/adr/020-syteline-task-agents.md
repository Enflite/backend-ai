# ADR-020: SyteLine task agents (task layer above UI automation)

**Status:** Accepted

## Context

ADR-019 gave the assistant hands: a Playwright-driven browser that logs
in as the user, navigates the Infor Mongoose / SyteLine web client,
fills fields, clicks buttons, and reads results back — all behind the
`SYTELINE_UI_ENABLED` kill switch, the `syteline:ui` permission (Admin /
AI Admin only), and per-user encrypted credentials.

Jake's reframe (2026-09-30): hands are not enough. He wants **AI agents
that complete SyteLine tasks for us.** A user hands the system a task in
plain language — "create this PO", "check why this order is late and
update it", "run the morning buyer routine" — an agent picks it up,
plans the steps, drives SyteLine as the user, does the work, and
reports back with evidence. This connects to Jake's 2026-09-22
kanban-board ask: assign AI tasks, see what the AI completed each day,
mark tasks complete, or surface issues.

The §3–§4 engine from the UI-automation plan (Playwright driver,
`UiSessionManager`, credential store, the `runTaskPlan` step semantics,
destructive-gated writes, fail-closed privacy) is the execution layer
underneath. This ADR records the decisions for the **task layer on
top**: task intake, lifecycle, the server-side runner, scoped write
approval, and report-back.

## Decision

### 1. Task queue as a Mongo collection (`syteline_tasks`)

New tenant-scoped collection `syteline_tasks`:

```
{ _id, tenantId, requesterUserId, title, goal (natural language),
  status: 'assigned' | 'in_progress' | 'completed' | 'blocked' | 'cancelled',
  plan: [ validated task-plan steps ],   // model-generated, zod-checked
  steps: [ { action, detail, status, startedAt, completedAt, evidenceIds[] } ],
  autoApproveWrites: boolean,
  resultSummary?, blockedReason?,
  conversationId?,                        // for reporting back, when created from chat
  createdAt, updatedAt, completedAt? }
```

*Rationale:* Mongo, not a new store, because the task queue is
operational state (like the ingestion queue and session records), and
the kanban-board ask needs a queryable, status-indexed data model, not
chat transcripts. Every record is tenant-scoped and tied to its
requester — the same scoping discipline as the credential store.

### 2. Lifecycle as the kanban data model

Statuses are exactly the kanban columns Jake asked for:

`assigned` → `in_progress` → `completed`
`assigned` → `in_progress` → `blocked`
(any non-terminal state) → `cancelled`

The frontend board UI is explicitly out of scope; `syteline.task.list`
(with a `status` filter) is the board's API contract. The task record —
with its per-step log and evidence ids — is the durable report; the
board is a view over it, not a separate system.

### 3. Server-side task runner with an atomic claim

New module `backend/src/syteline/tasks/taskRunner.ts`: a server-side
worker that processes `assigned` tasks, triggered on a poll interval
(`SYTELINE_TASK_RUNNER_INTERVAL_MS`, default 15000) and/or on demand
when a task is created. A single in-process runner claims work with an
atomic `findOneAndUpdate` (`assigned` → `in_progress`), so concurrent
backends can never double-run a task. Master kill switch
`SYTELINE_TASK_RUNNER_ENABLED` (default `false` — fail closed): when
off, tasks stay `assigned` and nothing runs.

Per task, three phases:

1. **Plan.** Call the model (gateway, non-streaming) with the goal plus
   the available UI actions; require a JSON task plan in the
   `runTaskPlan` DSL schema. **Zod-validate before executing** — an
   invalid plan marks the task `blocked` with a reason. The model
   proposes; the schema disposes.
2. **Execute.** Acquire the requester's UI session (their saved
   credentials — see decision 6), run the plan's steps sequentially
   with `runTaskPlan` semantics: each step audit-logged (argument keys
   only, per the `AGENTIC_LOOP_STEP` pattern), a screenshot captured
   per step (its `evidenceId` attached to the step), stop at first
   failure → `blocked` with a reason.
3. **Report.** Write `resultSummary` plus per-step outcomes to the task;
   audit `SYTELINE_TASK_COMPLETED` / `SYTELINE_TASK_BLOCKED`. If
   `conversationId` is set (task created from chat), append an
   assistant message to that conversation with the summary and evidence
   references. The task record itself is always the durable report —
   conversation messages are notification, not the record of truth.

### 4. `autoApproveWrites` is the scoped human write-confirmation

The rule "write actions need a confirmation step" holds, scoped to the
task: `autoApproveWrites: true` on `syteline.task.create` **is** the
human's explicit confirmation for that task's writes — recorded on the
task, bounded to that task's plan, auditable.

- Default `false`: the agent runs read-only reconnaissance
  (`gotoForm` / `readScreen` — non-destructive), then reports a
  proposed write plan and marks the task `blocked` with
  `blockedReason: 'awaiting-write-approval'`. The requester flips it by
  creating a follow-up task with `autoApproveWrites: true`. (A future
  `syteline.task.approveWrites` tool is the cleaner seam; it is out of
  scope for this build and noted, not promised.)
- `true`: write steps (`fillField`, `clickButton`, and any write in
  the plan) execute inside this task without further per-step prompts.
  The scope of the approval is the task's recorded plan — nothing else.

This keeps the ADR-019 destructive gate (agentic-loop confirmation)
for interactive driving, while giving the autonomous runner a
bounded, auditable approval it can act on without a human in the loop.

### 5. Four task tools, all behind `syteline:ui`

`backend/src/tools/sytelineTasks.ts`, registered in `toolRegistry`,
all with `permission: 'syteline:ui'` (Admin / AI Admin only — the same
privilege bar as driving a browser as a user):

- `syteline.task.create { title, goal, autoApproveWrites? }` —
  non-destructive. Creates an `assigned` task owned by the requester
  (`userId` from the auth context, never from arguments).
  `autoApproveWrites` defaults to `false`.
- `syteline.task.list { status? }` — non-destructive. The requester's
  tasks, or (for admins) the tenant's tasks — the kanban board's query.
- `syteline.task.get { taskId }` — non-destructive. Full record:
  status, plan, per-step log, evidence ids, summary, blocked reason.
- `syteline.task.cancel { taskId }` — `destructive:true` (ends work in
  flight). Requester or admin only.

Privacy routing inherits automatically: the `syteline.` prefix means
these tools are never offered on cloud turns when customer or finance
categories are enforced, exactly like the `syteline.ui.*` family
(ADR-019, decision 7). The code PR must verify, not re-implement.

### 6. Agents act only as the requester (no cross-user execution)

Execution always uses the **requester's** saved credentials (or the
tenant service-account fallback) and their own UI session — the agent
never acts as someone else. This is the ADR-019 session rule applied to
the runner: one browser session per `(tenantId, userId)`, and the
runner acquires the session of the task's `requesterUserId`.

### 7. Audit events (new)

`SYTELINE_TASK_CREATED`, `SYTELINE_TASK_STARTED`,
`SYTELINE_TASK_STEP` (argument keys only, never values),
`SYTELINE_TASK_COMPLETED`, `SYTELINE_TASK_BLOCKED` (reason),
`SYTELINE_TASK_CANCELLED`. Same secret hygiene as ADR-019: usernames
and task ids in clear are fine; passwords and field values never.

## Consequences

- The task runner is dark by default: `SYTELINE_TASK_RUNNER_ENABLED`
  is `false`, and without the `syteline:ui` permission the task tools
  are never offered. Two independent gates before any autonomous ERP
  write can happen.
- A task is a unit of auditable autonomy: every plan, step, evidence
  screenshot id, and completion summary is queryable from the task
  record, so a human (or a future kanban board) can review what the
  agent did day by day — Jake's original ask.
- The plan DSL stays the `runTaskPlan` five-action set; growing it is
  a new ADR (ADR-019's scope-creep rule applies here too).
- Mid-task human approval UI and push notifications are explicitly out
  of scope: the `autoApproveWrites` flag is the approval, and
  conversation messages plus the task record are the notification.

## Validation status

- **VALIDATED IN CI (code PR):** task lifecycle (create → claim →
  in_progress → completed/blocked/cancelled), atomic claim (no
  double-run), tenant + requester scoping, invalid-plan → `blocked`,
  FakeDriver execution with per-step outcomes and evidence ids,
  stop-on-first-failure, `autoApproveWrites=false` producing
  `blocked`/`awaiting-write-approval` without executing writes, tool
  authorization (`TOOL_FORBIDDEN` without `syteline:ui`; cancel limited
  to owner/admin), deterministic task-planning eval case.
- **REQUIRES REAL SYTELINE:** a real browser session completing a real
  multi-step SyteLine workflow end to end (planning prompt quality,
  ARIA-label selectors against real forms, evidence screenshots of the
  real web client).
