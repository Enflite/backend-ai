# ADR-023: Schedules — cron-triggered flow runs (the daily-SOP engine)

**Status:** Accepted

## Context

Jake (2026-10-02, from the Runtype API review): the platform builds,
in order — 1) Flows, **2) Schedules API**, 3) client tokens, 4)
Batch. Flows shipped first (ADR-022); this ADR records the Schedules
design.

Product shaping: Schedules are **the daily-SOP engine** — run Flows
on a timetable. The concrete jobs are the recurring, operational
ones: a weekday 7am buyer routine, a nightly 2am TRN/production drift
check, recurring recon that feeds the kanban "what did the AI do
today" view. Jake's planner daily-SOP work is the template: numbered
routines an operator runs every day, now fired by the platform.

What exists already: deterministic versioned runbooks (ADR-022 —
the flow definition, immutable versions, the `live` alias, and the
run lifecycle `queued → running → completed | blocked | cancelled`),
plus the server-side runner executing them through the tool gateway
with the requester's auth. What is missing is the clock: an
operational, admin-managed "fire this flow on this timetable"
primitive. A schedule is **not** a runbook (that's the flow) — it is
"when + as whom + with what inputs + writes approved?".

## Decision

### 1. A schedule targets a flow — never tools directly

A schedule record is operational config, managed at runtime via the
API (not PR-reviewed JSON):

```json
{
  "name": "nightly-trn-prd-drift-check",
  "title": "Nightly TRN/PRD drift check",
  "target": { "flow": "syteline-drift-check", "alias": "live" },
  "trigger": { "cron": "0 2 * * *", "timezone": "America/Chicago" },
  "inputs": { "scope": "monitored-artifacts" },
  "confirmWrites": false,
  "enabled": true,
  "runAsUserId": "<admin user id>"
}
```

- `target`: `{ flow, version? | alias? }` — an exact published
  version or (default) the `live` alias, resolved **at fire time**,
  so a schedule always runs what `live` means at that tick.
- `trigger`: `{ cron, timezone }` — a 5-field cron expression with
  an IANA timezone (decision 2).
- `inputs`: passed to the created flow run.
- `confirmWrites` (default `false`) — the scoped human approval for
  writes in fired runs (decision 4).
- `enabled` (default `true`) — paused schedules claim no ticks.
- `runAsUserId` — the user the fired runs execute as, re-resolved
  live at every tick (decision 3).

*Rationale:* keeping the runbook in the flow and the timetable in
the schedule means moving the 7am job to 8am is an API call by an
admin, not a repo change + republish + alias move. Timing is
operational config; determinism is the flow's job.

### 2. Cron-only triggers now; event triggers are a designed hook

The trigger is a dependency-free 5-field cron with Vixie semantics
(lists `1,15`, ranges `1-5`, steps `*/15`, month/weekday names, and
the Vixie day-of-month **or** weekday rule when both are
restricted) evaluated in an IANA timezone via `Intl`, with explicit
DST gap/fold handling: a tick that falls in a spring-forward gap
(a local time that does not exist) is skipped; a tick that falls in
a fall-back fold (a local time that occurs twice) fires once per
tick — no phantom firings, no double firings.

Event triggers (`on PO created`, `on document ingested`) are a
documented design hook — the trigger schema is shaped to become a
discriminated union later — and are **not built now**. They need a
durable event bus and a subscription model; that is a separate
design (and a new ADR), not a quiet extension of cron.

*Rationale:* cron covers every concrete job on the list today
(nightly checks, weekday routines). The event bus is a larger build
with no current consumer; documenting the hook keeps the schema
from painting it out.

### 3. runAs: live re-resolution at fire; demoted owners fail closed

A schedule fires **as** `runAsUserId`. At each tick the runner
re-resolves the owner's auth live — the same tenant, still active,
still holding the permissions the flow's steps need. If the owner
was demoted, deactivated, or deleted, the tick is **skipped** and
the skip is audited (`SCHEDULE_TICK_SKIPPED` with reason
`runas-invalid`) — the run never fires as someone else and never
fires with stale powers. This is the unattended analogue of the
ADR-022 "runs with the requester's auth" rule: there is no requester
at the keyboard, so the platform must prove the authority is still
real at the moment of firing.

*Rationale:* unattended runs are the highest-privilege moments in
the system. Failing closed on demotion is load-bearing — a former
admin's nightly routine must stop working the moment the admin
role is revoked, not the next time someone remembers the schedule.

### 4. `confirmWrites` on the schedule is the scoped human approval

ADR-022's writes gate needs `confirmWrites: true` on the run
request before destructive steps execute. For a schedule there is
no human at fire time, so the approval lives on the schedule
itself: setting `confirmWrites: true` when creating or updating the
schedule **is** the explicit, auditable, scoped human approval
covering writes in every run that schedule fires. It is recorded
in `SCHEDULE_CREATED` / `SCHEDULE_UPDATED` with the acting admin's
identity.

Default `false` means scheduled runs are read-only/recon: a flow
whose steps include destructive tools blocks per tool policy when
fired from such a schedule, exactly as if the run request had
omitted the flag. This mirrors the ADR-020 task agents'
`autoApproveWrites` seam: one deliberate, named, auditable
confirmation — never a prompt bypass, never inherited from the
flow, and re-affirmed on every schedule update (an update that
leaves it `false` leaves the runs read-only).

*Rationale:* the approval has to live somewhere a human touches
deliberately. The schedule is that place — it is created by a
human, under permission checks, with an audit event naming the
actor. Putting the approval on the flow would silently upgrade
every schedule targeting it; putting it on each tick is impossible
because no human is present.

### 5. Atomic claim + no catch-up

An interval sweeper (default every 30s) finds due schedules and
claims each tick with a **compare-and-swap on `nextRunAt`** — the
claim updates `nextRunAt` past the tick only if it still equals the
value read, so exactly one claimer wins even with multiple backend
instances sweeping. Each firing carries the idempotency key
`sched:<id>:<tickISO>` into `createRun`: a tick fires at most once,
even if two sweepers race past the claim or a claim is retried.

**No catch-up:** a missed tick (downtime, paused schedule,
disabled kill switch) is skipped, never backfilled. `nextRunAt`
always advances past "now" after a claim or a resume — the next
firing is the next tick on the clock, not the one that was missed.

*Rationale:* backfilling a nightly drift check at 9am produces
confusing evidence and potentially duplicate writes; the
idempotency key makes "exactly once per tick" provable; and per
ADR-022 the run history must answer "what ran when" — late
duplicates corrupt that record. Skipped ticks are visible: they
show as gaps in the schedule's run history and are auditable.

### 6. Stats derive from `flow_runs`; every firing carries `scheduleRef`

There is no separate schedule-run ledger. Each firing creates a
flow run with `scheduleRef: { scheduleName, tickISO }` — so
scheduled runs appear in `GET /flows/runs`, the kanban board, and
the "what did the AI do today" view with zero extra aggregation
and full step-level audit. The schedule's stats (run counts by
status, last run at, last success at) are **derived** by querying
`flow_runs` on `scheduleRef` — one source of truth, not two that
can drift apart.

*Rationale:* the ADR-022 §6 discipline says a run's step log plus
its published version hash is the complete record of what ran.
A parallel ledger would need its own lifecycle, its own tenant
scoping, and its own reconciliation — all of it duplicated
machinery answering questions `flow_runs` already answers.

### 7. Fail-closed flags and permissions

One master kill switch, default `false` (fail closed):

- `SCHEDULES_ENABLED` — the API surface **and** the sweeper. When
  off: every `/schedules` endpoint fails fast with `403
  FEATURE_DISABLED`, and the sweeper claims no ticks (schedules sit
  at their current `nextRunAt`; nothing fires).
- `SCHEDULE_SWEEP_INTERVAL_MS` (default `30000`) — how often the
  sweeper looks for due ticks. `SCHEDULE_SWEEP_LIMIT` (default
  `20`) — max ticks claimed per sweep.

Permissions:

- `schedules:manage` — create / update / delete schedules, pause,
  resume.
- `schedules:run` — list / view / `run-now` / runs / stats.

Access posture (Jake, 2026-10-02): every role holds every permission
for now; the checks stay enforced. Granularity may return later.

Tenant isolation: schedules are tenant-scoped; the `runAsUserId`
must belong to the same tenant. Privacy routing treats the family
like flows: a schedule firing a `syteline.*` flow is never offered
on cloud turns when customer or finance categories are enforced
(see `docs/privacy-routing.md`) — the tool-level checks inherit
through the gateway. Migration 035 seeds the permissions and the
indexes.

## Consequences

- Schedules make **unattended writes possible** — that is the point
  of the daily-SOP engine — and every gate around them is an
  audited, fail-closed one: `SCHEDULES_ENABLED`
  default-off, permission checks (currently every role holds every
  permission per Jake 2026-10-02), explicit `confirmWrites`,
  live `runAs` re-resolution, and per-tool permission checks via
  the gateway inherited from flows.
- A paused schedule never fires; `resume` recomputes `nextRunAt`
  from now — there is deliberately no catch-up backlog to clear.
- `run-now` is the manual fire path (testing, one-offs): it creates
  a run with the schedule's target/inputs/`confirmWrites` plus a
  `scheduleRef`, but it does **not** move `nextRunAt`.
- The kanban "what did the AI do today" query works unchanged:
  flow runs filtered by `scheduleRef` (or `GET
  /schedules/:name/runs` per schedule).
- Stale `live` aliases are the expected failure mode, same as
  ADR-022: a schedule whose target flow has no live version skips
  its ticks (`SCHEDULE_TICK_SKIPPED`, reason `no-live-version`)
  until an operator publishes and moves the alias.

## Design hooks (future — NOT built now)

Documented so the schema doesn't paint them out; none of this ships
in the schedules build:

- **Event triggers** — `trigger` becomes a discriminated union
  (`cron` | `event`); needs a durable event bus + subscription
  model (new ADR).
- **Client-token-scoped schedule invocation** — big-four #3 may
  let the Ask Enflite AI button fire named schedules.
- **Scheduled batch** — big-four #4: a schedule whose target is a
  batch flow.
- **Notifications on blocked scheduled runs** — a run that blocks
  overnight should page someone; the run record and audit events
  already carry everything such a notifier needs.

## Alternatives considered

- **Event-driven-only scheduling (skip cron)** — rejected. Cron
  covers every concrete job on the list; the event bus is a larger
  build with no current consumer.
- **Scheduling inside the flow JSON** (a `schedule:` block in
  `flows/<name>.flow.json`) — rejected. Timing is operational
  config admins change at runtime; coupling it to the PR-reviewed
  runbook would force a repo change + republish + alias move just
  to move the 7am job to 8am.
- **Schedules executing tools directly** (no flow indirection) —
  rejected. Loses the immutable-version guarantee and the kanban
  lineage: "what ran" would no longer be answerable from flow run
  history, and per-tool auth would need a second enforcement path.
- **Catch-up / backfill of missed ticks** — rejected. Late runs
  fire with stale inputs and corrupt the "what ran when" record;
  skipped ticks are visible and auditable instead.
- **A separate schedule-run ledger table** — rejected. Duplicates
  `flow_runs`; `scheduleRef` + derived stats keep one source of
  truth.
- **`confirmWrites` inherited from the flow definition** —
  rejected. It would silently upgrade every schedule targeting the
  flow; the approval must be a deliberate per-schedule admin act.

## Validation status (docs PR)

This ADR is the design record. The code PR must validate: cron
parsing (Vixie semantics incl. the day-of-month/weekday OR rule,
IANA timezones, DST gap skipped / fold fired once, invalid
expressions → `400`); atomic due-claim (concurrent sweepers claim
each tick exactly once); idempotency (`sched:<id>:<tickISO>` → a
tick fires at most once); no catch-up (downtime → `nextRunAt`
advances past now, missed ticks skipped, never backfilled); `runAs`
demotion/deactivation → tick skipped + `SCHEDULE_TICK_SKIPPED`
audit; writes gate (`confirmWrites: false` + destructive step →
run `blocked`; `confirmWrites: true` → approval recorded on the
schedule and surfaced in fired runs); stats correctness over
`flow_runs`; pause/resume (no firing while paused; resume advances
`nextRunAt` past now); `run-now` does not move `nextRunAt`; the
kill switch default-off (`403 FEATURE_DISABLED`, no claims);
authorization (`FORBIDDEN` without `schedules:manage` /
`schedules:run`); tenant isolation of schedules and the
`runAsUserId` same-tenant rule; migration 035 (permissions seeded,
indexes present). **REQUIRES REAL CLOCK / REAL TOOL EXECUTION:**
tick-to-tool latency and fired runs against live tools are
validated against the same harnesses as the underlying tools —
the claim, lifecycle, gating, and audit behavior above are
**VALIDATED IN CI** with fakes and a controllable clock.
