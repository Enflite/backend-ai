# APS Exception-Resolution Flows — Operator Guide

Two versioned flows implement Jake's APS exception-resolution flowchart
as config-as-code in `flows/`, converged via `POST /flows/ensure`:

- **`aps-exception-analysis`** (`flows/aps-exception-analysis.flow.json`) —
  the main pipeline: parse the uploaded exception report, classify,
  gather facts, apply APS rules, root-cause, recommend, write grounded
  SyteLine procedure steps, record a snapshot.
- **`aps-exception-verify`** (`flows/aps-exception-verify.flow.json`) —
  the verification loop: parse the new report, compare against the
  baseline snapshot, close the issue when resolved, otherwise run one
  bounded re-analysis.

> **Honesty note:** the flow JSON, lifecycle, and both branch behaviors
> are **VALIDATED IN CI** (`backend/test/apsExceptionFlows.test.ts`,
> mocked tools/agents). The `aps.*` tools themselves
> (`backend/src/aps/`, parallel build) and any run against live
> SyteLine, the documents service, or the model gateway
> **REQUIRE REAL INFRASTRUCTURE** and are not exercised here.

## Why two flows (not one)

The flowchart's "Planner Executes" node is a **human run boundary**,
not a flow step. The platform has no pause/await primitive, and we do
not fake one: `aps-exception-analysis` completes at `record-snapshot`;
the planner takes the SyteLine steps (via `aps.getIssue` or the run
view), executes them by hand in SyteLine, uploads a new exception
report, then starts `aps-exception-verify` with the new report's
document id. One flow per side of the human handoff keeps every run
fully auditable and every version immutable.

## Flowchart → steps mapping

| Flowchart node | Flow step(s) | Kind |
|---|---|---|
| Upload Exception Report | run input `exceptionReportDocumentId` (the upload happens before the run) | input |
| Parse Excel | `parse-excel` → `aps.parseExceptionReport` | `tool` |
| Normalize Rows | `normalize-rows` → `aps.normalizeExceptionRows` | `tool` |
| Classify Exception | `classify-exception` — bounded agent step; APS primer (Move In/Move Out, PLN projected dates, status lifecycle) + rows JSON; schema-boxed classifications | `agent` |
| Find Related Supply | `find-related-supply` → `aps.collectSupplyFacts` (read-only, 5 min timeout) | `tool` |
| Find Related Demand | `find-related-demand` → `aps.collectDemandFacts` (read-only, 5 min timeout) | `tool` |
| Evaluate Due Dates | `evaluate-due-dates` → `aps.evaluateDueDates` (read-only, 5 min timeout) | `tool` |
| Apply APS Rules | `apply-aps-rules` → `aps.applyRules` (deterministic rules engine: facts in, findings out) | `tool` |
| Determine Root Cause | `determine-root-cause` — agent correlates classifications + facts + findings; evidence must cite records | `agent` |
| Generate Recommendation | `generate-recommendation` — agent writes concrete actions with p0/p1/p2 priority | `agent` |
| Generate SyteLine Steps | `generate-syteline-steps` — agent writes the planner's procedure. **Never invents SyteLine UI procedures**: only forms/procedures established in planning knowledge; ungroundable steps get `"form": ""` and say so in `details` | `agent` |
| Planner Executes | **run boundary** — human executes the SyteLine steps in SyteLine, uploads a new report | human |
| Upload New Exception Report | run input `newReportDocumentId` on the verify flow | input |
| Compare Results | `compare-results` → `aps.compareSnapshots` (baseline snapshot vs new issues) | `tool` |
| Resolved? | `resolved` — `when: {{steps.compare-results.output.resolved}} == 'true'`, then `close-issue`, else `reanalyze` | `condition` |
| Close Issue | `close-issue` → `aps.closeIssue` — **last step** (see fall-through design below) | `tool` |
| (No →) Determine Root Cause | `reanalyze` — subflow `aps-exception-analysis` at the `live` alias | `subflow` |

## Input contract

Analysis (`aps-exception-analysis`):

| Input | Type | Notes |
|---|---|---|
| `exceptionReportDocumentId` | string, required | Document id of the uploaded exception-report workbook |
| `site` | string, required | SyteLine site for the report and all fact lookups |
| `issueId` | string, required | Planning issue id; pass `""` to create a new issue (required because strict templates cannot reference absent inputs) |

Verify (`aps-exception-verify`):

| Input | Type | Notes |
|---|---|---|
| `issueId` | string, required | Issue id from the analysis run |
| `newReportDocumentId` | string, required | Document id of the new report uploaded after the planner executed the steps |
| `site` | string, required | Same site as the analysis run |

Declared `outputs` on both flows are documentary (the runner does not
resolve declared outputs — known schema gap, same as other flows).

## The human handoff

`aps-exception-analysis` ends at `record-snapshot`. The run's result
is the snapshot: classifications, rule findings, root causes,
recommendations, and the ordered SyteLine procedure steps. The
planner works from those steps in SyteLine — the flow performs no
writes to SyteLine; V1 of the APS work is read-only and the planner
executes. When the planner is done, they upload a fresh exception
report and start `aps-exception-verify`. The Schedules build (the
next of the "big four") will trigger these flows on a clock; the
flows are schedule-ready but schedules themselves are not built here.

## Loop bound

The verification loop is bounded, not recursive:

- At most **one** automatic re-analysis per verify run. `reanalyze`
  calls `aps-exception-analysis` once; if the new snapshot still
  shows exceptions, the *planner* decides whether to upload another
  report and start another verify run. Repeated cycles are separate
  runs, each fully audited.
- Subflow depth is 2 (verify → analysis) against the platform max of
  5. The analysis flow never calls back into verify, so there is no
  cycle.

## Fall-through-safe close-issue

The runner executes steps in order and **falls through after a taken
condition branch**, which is why step order in the verify flow is
load-bearing:

```
parse-excel → normalize-rows → compare-results → resolved
  ├─ true  → jump forward to close-issue (reanalyze marked skipped)
  └─ false → reanalyze, then fall through into close-issue
close-issue   ← LAST step
```

`aps.closeIssue` is fall-through-safe by design: called with
`resolved=false` it performs **no state change** — the issue stays
open and the run still completes. This lets one linear step order
serve both branches without a join jump: resolved=true closes via the
then-branch; resolved=false re-analyzes and then harmlessly passes
through close-issue.

## Condition-template gotcha (flow authors, read this)

The `resolved` condition uses the **unquoted-LHS** form:

```json
"when": "{{steps.compare-results.output.resolved}} == 'true'"
```

The quoted form `'{{…}}' == 'true'` does **not** work for this
grammar: interpolation keeps the literal quotes on the left side, so
the resolved text is `'true' == 'true'`, the comparison sees LHS
`'true'` (with quotes) against literal `true`, and the branch is
false on both sides. Verified against `template.ts`
`evaluateCondition`. Use a bare template for truthiness or an
unquoted LHS with a quoted literal for comparisons.

## Product rules encoded

- Deterministic code computes facts (the `aps.*` tools and the
  rules engine); the model explains, correlates, and prioritizes
  inside schema-boxed agent steps. The model never invents records.
- Canonical planning model: issues, facts, findings, snapshots —
  no spreadsheet-guessing.
- Snapshots + before/after verification: every analysis records a
  snapshot; every verify compares against it.
- Never invent SyteLine UI procedures: the `generate-syteline-steps`
  prompt requires grounding in established forms/procedures (named in
  SQL Tables / IDO terms — never "Application Studio"), and forces
  `"form": ""` plus an explicit flag when a step cannot be grounded.
- Read-only vs SyteLine: the fact-collection tools are read-only;
  the planner executes all writes.

## Running

```
POST /api/v1/flows/aps-exception-analysis/runs
{ "inputs": { "exceptionReportDocumentId": "doc-1", "site": "01", "issueId": "" } }
→ 202 { "runId": "…" }   # ends at record-snapshot; planner executes the SyteLine steps

POST /api/v1/flows/aps-exception-verify/runs
{ "inputs": { "issueId": "issue-1", "newReportDocumentId": "doc-2", "site": "01" } }
→ 202 { "runId": "…" }   # closes the issue, or re-analyzes once
```

`aps.closeIssue` needs no `confirmWrites`: it is not destructive on
the false path (no state change), and closing a resolved issue is the
flow's terminal bookkeeping, not a SyteLine write.

Related: `docs/flows.md` (operator guide), ADR-022 (design),
`docs/syteline-expert.md` (APS planning concepts grounding the agent
prompts). The broader APS Planning Agent assessment
(`docs/aps-planning-agent/assessment.md`, in flight separately) will
integrate with these flows rather than duplicate them.
