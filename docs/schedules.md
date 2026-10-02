# Schedules — Operator Guide

Cron-triggered flow runs: the daily-SOP engine. A schedule fires a
named flow on a timetable — as a specific user, with fixed inputs,
and with the admin's scoped approval for writes — and every firing
shows up in flow run history and the kanban board. Design: ADR-023.

> **Honesty note:** this guide describes the full design. The
> schedules platform is big-four item #2: the implementation is the
> parallel code PR. The cron engine, atomic due-claim, lifecycle,
> gating, and audit behavior below are **VALIDATED IN CI** there;
> fired runs against live tools are exercised against the same
> harnesses as the underlying tools, never against production
> systems here.

## What schedules are

Flows are runbooks: the same steps, in the same order, every time
(see `docs/flows.md`). Schedules answer the next question: *when*
does the runbook run, *as whom*, and *with the writes approved*?
A schedule is the platform's clock for the recurring, operational
work — the daily-SOP engine:

- a **weekday 7am buyer routine** that pulls yesterday's numbers
  and drafts the day's buy plan,
- a **nightly 2am TRN/production drift check** that compares the
  monitored artifacts and reports before anyone logs in,
- recurring **recon** whose results feed the kanban "what did the
  AI do today" view.

A schedule never runs tools directly. It creates a **flow run** —
the deterministic, versioned, audited unit from ADR-022 — with the
schedule's inputs, the schedule's write approval, and a
`scheduleRef` tying the run back to the schedule and the tick that
fired it.

## Concepts

- **Schedule** — operational config, managed at runtime via the
  API: name, title, target flow, cron trigger + timezone, inputs,
  `confirmWrites`, `enabled`, and `runAsUserId`.
- **Target** — `{ flow, version? | alias? }`: the flow to fire.
  The version or `live` alias is resolved **at fire time**, so a
  schedule always runs what `live` currently means.
- **Trigger** — `{ cron, timezone }`: a 5-field cron expression
  (Vixie semantics) evaluated in an IANA timezone
  (e.g. `America/Chicago`).
- **runAs** — the user the fired runs execute as. The platform
  re-resolves this user's auth live at every tick; if the owner was
  demoted or deactivated, the tick is skipped (fail closed).
- **confirmWrites** — the scoped human approval for writes in
  fired runs (default `false` → scheduled runs are read-only/recon;
  destructive steps block per tool policy).
- **tick** — one scheduled firing instant. Ticks are claimed
  atomically (compare-and-swap on `nextRunAt`), fire at most once
  (idempotency key `sched:<id>:<tickISO>`), and are never caught up:
  a missed tick is skipped, `nextRunAt` always advances past now.
- **scheduleRef** — `{ scheduleName, tickISO }` attached to every
  fired flow run, so scheduled runs appear in flow run history and
  the kanban board alongside on-demand runs.

## Who can use schedules

- `schedules:manage` — create, update, delete, pause, resume.
- `schedules:run` — list, view, `run-now`, runs, stats.

Access posture (Jake, 2026-10-02): every role currently holds every
permission — the checks stay enforced, but no role is excluded.
Granularity may return later.

One master kill switch, default `false` (fail closed): with
`SCHEDULES_ENABLED` off, every `/schedules` endpoint fails fast
with `403 FEATURE_DISABLED` and the sweeper claims no ticks —
schedules sit at their current `nextRunAt` and nothing fires.

## Creating a schedule

`POST /api/v1/schedules` (auth + `schedules:manage`):

```json
{
  "name": "weekday-buyer-routine",
  "title": "Weekday 7am buyer routine",
  "target": { "flow": "buyer-daily-routine", "alias": "live" },
  "trigger": { "cron": "0 7 * * 1-5", "timezone": "America/Chicago" },
  "inputs": { "region": "all", "lookbackDays": 1 },
  "confirmWrites": false,
  "enabled": true,
  "runAsUserId": "01J… (the owning admin's user id)"
}
```

→ `201` with the schedule object, including `nextRunAt` (ISO —
the next tick on the clock, in the trigger's timezone).

```json
{
  "name": "nightly-trn-prd-drift-check",
  "title": "Nightly 2am TRN/PRD drift check",
  "target": { "flow": "syteline-drift-check", "version": 3 },
  "trigger": { "cron": "0 2 * * *", "timezone": "America/Chicago" },
  "inputs": { "scope": "monitored-artifacts" },
  "confirmWrites": false,
  "enabled": true,
  "runAsUserId": "01J…"
}
```

Notes on the examples:

- `name` matches `^[a-z0-9-]+$` (same convention as flow names);
  it is the schedule's identity in `scheduleRef`.
- `target.alias: "live"` (the default) resolves at fire time —
  the schedule follows the flow's `live` pointer. `version: 3`
  pins an exact published version instead. Exactly one of
  `version` / `alias` may be given.
- `inputs` must satisfy the target flow's input schema at create
  time (a schedule for a flow with required inputs must supply
  them — a fired run must never hit
  `TEMPLATE_RESOLUTION_ERROR` for a missing schedule input).
- `confirmWrites: false` (the default) keeps both examples
  read-only/recon: safe to schedule before anyone has reviewed the
  flow's write steps.
- `runAsUserId` must be an active user in the same tenant —
  normally the admin creating the schedule. Fired runs execute
  with that user's auth through the tool gateway, so each tool's
  own permission check applies exactly as if the owner had run the
  flow by hand.

## Cron field reference

```
* * * * *
│ │ │ │ └─ weekday   0–7 (0 and 7 are both Sunday) or SUN–SAT
│ │ │ └─── month     1–12 or JAN–DEC
│ │ └───── day of month  1–31
│ └─────── hour      0–23
└───────── minute    0–59
```

- Lists: `0 7 * * 1,3,5` — Mon/Wed/Fri at 7:00.
- Ranges: `0 7 * * 1-5` — weekdays at 7:00.
- Steps: `*/15 * * * *` — every 15 minutes. `0 */2 * * *` —
  every 2 hours on the hour.
- Names: `0 9 * * MON` — Mondays at 9:00.
- **The Vixie rule:** when *both* day-of-month and weekday are
  restricted (neither is `*`), the tick fires when **either**
  matches. `0 7 1 * 1` fires on the 1st of the month *and* every
  Monday at 7:00 — not only when the 1st is a Monday. If you want
  "the first Monday of the month", that needs a flow-level check,
  not a cron trick.
- Seconds are not supported (5 fields, minute granularity). If a
  job genuinely needs sub-minute cadence, it is not a schedule —
  it is a worker.

## Timezones and DST

The trigger's `timezone` is required and is an IANA name
(`America/Chicago`, `America/New_York`, `UTC`, …). The cron
expression is evaluated in that timezone, so `0 7 * * 1-5` with
`America/Chicago` means 7:00 Central — following daylight-saving
shifts, not drifting against them. There is no server default:
always set the timezone explicitly, so a server move or a daylight
transition never silently changes what "7am" means.

**DST behavior** (the design policy; the code PR validates it):

- **Spring forward (gap):** a tick that falls in the skipped hour
  (a local time that does not exist, e.g. 2:30am on the March
  transition in `America/Chicago`) is **skipped** — the platform
  never fires at a time that isn't on the clock. `nextRunAt`
  advances to the next valid tick.
- **Fall back (fold):** a tick that falls in the repeated hour (a
  local time that occurs twice) fires **once per tick**, not once
  per occurrence — no double firings.

No phantom firings, no double firings: the idempotency key
(`sched:<id>:<tickISO>`) makes "exactly once per tick" hold even
across the transitions.

## Approval gating, explained plainly

A flow with destructive steps (anything that changes data — a
`confirmWrites` step in flow terms) will not execute those steps
unless the run was approved. For a run you start by hand, you pass
`confirmWrites: true` yourself. For a schedule, there is nobody at
the keyboard — so the approval lives **on the schedule**:

- `confirmWrites: false` (default): fired runs are read-only. A
  destructive step blocks the run per tool policy — same as an
  unapproved on-demand run. Start here; the nightly drift check
  and most recon never need more.
- `confirmWrites: true`: you, the admin, have reviewed the target
  flow's steps and are approving writes for every run this
  schedule fires. The approval is recorded in the
  `SCHEDULE_CREATED` / `SCHEDULE_UPDATED` audit event with your
  identity — it is deliberate, named, and re-affirmed every time
  the schedule is updated.

Two things the approval does **not** do: it does not grant the
run powers the `runAs` owner doesn't have (the flow still executes
through the tool gateway with the owner's live auth — every tool's
own permission check applies), and it does not bypass the
per-step audit (every write lands in the run's step log with
evidence, same as any run).

Practical rule: schedule read-only first, watch a few real ticks in
the kanban view, then — and only then — flip `confirmWrites` on
with the flow's write steps reviewed. The nightly drift check that
only *reports* drift should stay `false` forever; a routine that
*acts* on drift needs `true` and a named owner who stays an admin.

## Pause, resume, run-now

- **Pause** — `POST /schedules/:name/pause` (`schedules:manage`):
  sets `enabled: false`. The sweeper claims no ticks while paused;
  `nextRunAt` stays where it was.
- **Resume** — `POST /schedules/:name/resume`: sets
  `enabled: true` and **recomputes `nextRunAt` from now** — the
  next firing is the next tick on the clock, not the backlog that
  accumulated while paused. There is deliberately no catch-up.
- **Run-now** — `POST /schedules/:name/run-now`
  (`schedules:run`): fires the schedule immediately, outside the
  timetable — same target, inputs, `confirmWrites`, and `runAs`
  as a real tick, and the run carries a `scheduleRef` so it shows
  up in the schedule's run history. It does **not** move
  `nextRunAt`. Use it to test a new schedule (or to re-fire a
  skipped tick by hand) without disturbing the timetable.

Update (`PUT /schedules/:name`) changes title, target, trigger,
inputs, `confirmWrites`, `enabled`, and `runAsUserId`; changing the
cron or timezone recomputes `nextRunAt`. Delete
(`DELETE /schedules/:name`) removes the schedule — the flow runs
it already fired stay in `flow_runs` (history is never deleted
with the schedule), and the derived stats freeze at their last
values.

## Reading stats and run history

- `GET /schedules/:name/runs` — the runs this schedule fired,
  newest first (the `scheduleRef` filter over flow runs).
- `GET /schedules/:name/runs?status=blocked` — just the blocked
  ones: the overnight-failure triage view.
- `GET /schedules/:name/stats` — derived from `flow_runs`: run
  counts by status, `lastRunAt`, `lastSuccessAt`, `nextRunAt`,
  and the current `enabled` / `confirmWrites` posture.
- `GET /schedules/:name` — the full schedule: definition, trigger,
  `nextRunAt`, and a summary of the most recent run.

Stats are derived, not stored: they always reflect what is
actually in `flow_runs`, so they can never drift out of sync with
the run history they summarize.

### The kanban "what did the AI do today" connection

Every fired run carries `scheduleRef: { scheduleName, tickISO }`,
so scheduled runs are first-class citizens in `GET /flows/runs`
and the kanban board — they appear next to on-demand runs, with
the same status, step log, and evidence. The board's daily view
("what did the AI do today") is simply flow runs filtered to the
day, with `scheduleRef` identifying which ones the timetable
fired. `GET /schedules/:name/runs` is the per-schedule cut of the
same data.

## Troubleshooting

**Schedule not firing.** Work the list in order:

1. **Kill switch** — is `SCHEDULES_ENABLED=true`? When off, the
   endpoints return `403 FEATURE_DISABLED` and the sweeper claims
   nothing.
2. **Enabled** — `GET /schedules/:name` → is `enabled: true`? A
   paused schedule claims no ticks.
3. **runAs** — was the owner demoted or deactivated? Check the
   audit log for `SCHEDULE_TICK_SKIPPED` with reason
   `runas-invalid`. This is fail-closed by design: fix the owner
   (or point the schedule at a current admin), don't work around
   it.
4. **Flow has no live version** — a target with `alias: "live"`
   skips its ticks (`SCHEDULE_TICK_SKIPPED`, reason
   `no-live-version`) until someone publishes a version and moves
   the alias. `GET /flows/:name` shows the alias → version → hash
   chain.
5. **Sweeper cadence** — with the default 30s sweep interval, a
   tick becomes a run up to ~30s after its time. `nextRunAt` in
   the future is normal; `nextRunAt` far in the past with no runs
   means something above failed.
6. **DST gap** — a tick that fell in a spring-forward gap is
   skipped by design (see "Timezones and DST"), not a failure.

**Run fired but blocked.** `GET /schedules/:name/runs?status=blocked`
→ open the run → the step log names the step. The common cause is
the writes gate: `confirmWrites: false` on the schedule with a
destructive step in the flow. Either keep the schedule read-only
by design, or have an admin review the flow's write steps and set
`confirmWrites: true` (recorded in the audit event with their
identity).

**Stats look stale.** Stats derive from `flow_runs` — if no run
was created, there is nothing to count. Work the "not firing"
list above.

**`403 FORBIDDEN`.** The caller lacks `schedules:manage` (for
CRUD/pause/resume) or `schedules:run` (for list/view/run-now).
(Current posture: every role holds every permission; the checks
remain enforced.)

**Double-fires.** Each tick carries the idempotency key
`sched:<id>:<tickISO>` into run creation: a tick fires at most
once even if sweepers race. A genuine duplicate means the claim
machinery misbehaved — treat it as a bug report, not a retry.

## Enablement checklist for production

1. Set `SCHEDULES_ENABLED=true`; confirm
   `SCHEDULE_SWEEP_INTERVAL_MS` / `SCHEDULE_SWEEP_LIMIT` suit the
   fleet (defaults: 30s / 20 ticks per sweep).
2. Confirm the target flow is **published with a live alias**
   (or pin an exact version in the target). Schedules resolve the
   target at fire time — no live version means skipped ticks.
3. Set `runAsUserId` to an active Admin/AI Admin who will keep
   that role; plan for rotation, because demotion skips ticks by
   design.
4. Decide `confirmWrites`: review the flow's steps. Default
   `false` (read-only) is the safe start; flip to `true` only
   after watching real ticks and reviewing the write steps.
5. Test with `run-now` before enabling the timetable; confirm the
   run, its `scheduleRef`, and its audit trail.
6. Watch the first real tick via `GET /schedules/:name/runs` and
   the `SCHEDULE_*` audit events.
7. Keep `SCHEDULES_ENABLED=false` in lower environments until the
   schedule set has been reviewed — schedules are production
   machinery, not dev conveniences.

Related: ADR-023 (design decisions), `docs/flows.md` (the runbooks
schedules fire), `docs/api.md` (endpoint reference),
`docs/architecture.mmd` diagram (m) (request flow).
