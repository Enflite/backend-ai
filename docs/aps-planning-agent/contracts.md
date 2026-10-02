# APS Planning Agent — Substrate Contracts

**Status:** backend Phase 1 (this PR). The sibling coordinator's
deterministic pipeline **landed on main (PR #64)** before this PR, so
the seam below is imported directly, not mocked. This module consumes
the pipeline by contract through `backend/src/apsPlanning/substrate.ts`
— it never rebuilds it.

## What the sibling owns (do not rebuild)

| Piece | Location (landed, PR #64) | Notes |
|---|---|---|
| Deterministic rules engine | `backend/src/aps/rules.ts` | Pure functions; fact types `PAST_DUE_OPEN_ORDER`, `LATE_INBOUND_SUPPLY`, `MATERIAL_SHORTAGE`, `UNCOVERED_DEMAND`, `EXCESS_SUPPLY` |
| Issue store | `backend/src/aps/issues.ts` | `aps_issues` collection; `ApsIssueDoc = { _id, tenantId, site, reportDocumentId, status: 'open'\|'closed', snapshots: [{ snapshotId, createdAt, issues, classifications?, findings?, rootCause?, recommendation?, sytelineSteps? }], createdAt, updatedAt }` — imported directly by `substrate.ts` |
| 10 flow-substrate tools | `backend/src/aps/apsTools.ts`, registered in `backend/src/tools/gateway.ts` | `aps.parseExceptionReport`, `aps.normalizeExceptionRows`, `aps.collectSupplyFacts`, `aps.collectDemandFacts`, `aps.evaluateDueDates`, `aps.applyRules`, `aps.recordSnapshot`, `aps.compareSnapshots`, `aps.closeIssue`, `aps.getIssue` |
| Flow definitions | `flows/aps-exception-analysis.flow.json`, `flows/aps-exception-verify.flow.json` | Tool steps + four schema-validated agent steps (classify, root-cause, recommendation, syteline-steps); 'Planner Executes' is a human boundary, not a flow step |

## What this module owns

| Piece | Location (this PR) | Notes |
|---|---|---|
| Product surface | `backend/src/apsPlanning/` | Narrow `index.ts`; `/api/v1/aps/*` REST; `agentJudgment` chat-context seam; versioned knowledge pack; procedure guidance |
| Analysis intake records | `aps_analyses` collection (`store.ts`) | The sibling lacks intake records; snapshots/issues are the sibling's |
| Permission | `aps:plan` (migration 037 seeds + grants to all roles) | Sibling tools use `document:read` / `syteline:read`; the product surface uses `aps:plan` |
| Snapshot compare (row-level) | `GET /aps/snapshots/compare` | Per-row verdicts; see "Issue identity" below |

## Tool delta (this phase): none

The sibling's 10 `aps.*` tools already cover the flow substrate. This
module defines **no new tool definitions** in this phase — the chat
surface reaches APS through the sibling's `aps.*` family once it lands
(capability detection offers them on the `syteline` capability slot).
If a future phase needs module-side tools (e.g. analysis-scoped
wrappers), they will be named to avoid the 10 above and recorded here.

## The seam (`substrate.ts`)

The module calls the pipeline only through `SubstrateClient`:

- `invokeAnalysisFlow(auth, { exceptionReportDocumentId, issueId, site })`
  → `createRun(auth, 'aps-exception-analysis', { inputs }, clearance)`
  (the Flows platform — real on main). The live alias resolves the
  sibling's published version.
- `invokeVerifyFlow(auth, { issueId, newReportDocumentId, site })`
  → `createRun(auth, 'aps-exception-verify', …)`.
- `getIssue(tenantId, issueId)` → the sibling's issue store. **Not
  landed:** the default client throws `SubstrateUnavailableError`
  (importing `../aps/issues.js` now would break the build — the file does
  not exist on main).
- `getFlowRunStatus(tenantId, runId)` → `flowStore.getRun` (real on main);
  the REST layer uses it to advance analysis statuses.

Absent-flow handling: `createRun` raising `FLOW_NOT_FOUND` /
`NO_LIVE_VERSION` / `FLOW_VERSION_NOT_FOUND` maps to
`SubstrateUnavailableError`, and the REST layer is honest about it:
intake → `202` with status `pending-substrate`; substrate-dependent
endpoints → `409 SUBSTRATE_UNAVAILABLE`. Nothing pretends the pipeline
ran. (The .flow.json definitions ship in the repo, but flows are tenant
data — they must be published with a live alias on each tenant before
invocation works.)

## Reconciliation: agentJudgment vs the flow's agent steps

**System of record for the pipeline: the flow's four agent steps**
(classify, root-cause, recommendation, syteline-steps). They run inside
the versioned flow with the pipeline's evidence in context.

**This module's `agentJudgment.ts` is the standalone/chat-context seam:**
explaining, correlating, and prioritizing APS findings OUTSIDE a flow
run (e.g. "what should I work on first?" over an already-recorded
analysis). It does not duplicate the pipeline prompts — the flow owns
the pipeline prompts; this module owns the chat-context prompts
(`aps-explain`, `aps-prioritize`, `aps-recommend`).

Consistency rules (both sides):
- Same knowledge pack (`APS_PLANNING_KNOWLEDGE`): allocation by
  priority, Move In/Out semantics, PLN date drift, status lifecycles.
- Same honesty rules: never invent SyteLine records or procedures;
  unverified procedure steps ship flagged with `needsConfirmation`.
- Privacy: prompts carry aggregates only — never full report rows to
  cloud models (uploaded exports carry supplier/pricing data).

## Reconciliation: knowledge pack vs flow prompts

`knowledge.ts` was cross-checked against the sibling's agent prompts and
does not contradict them:
- Allocation by priority + supply-usage tolerance + Move In/Out
  generation: matches the classify prompt.
- PLN projected dates move on their own; firming converts PLN → job/PO:
  matches the root-cause prompt's lifecycle notes.
- Status lifecycles (CO lines Planned/Ordered/Open; POs
  Planned/Ordered/Open; jobs Firm/Released/Complete): match.
- "Never invent SyteLine records or procedures": matches the
  syteline-steps prompt's hard constraint verbatim.
- The pack adds the five V1 exception types' message semantics, which the
  flow prompts assume but do not spell out — additive, not conflicting.

## Issue identity: compare-endpoint mapping

Two identity schemes coexist; the mapping is explicit:

- **Sibling (`aps.compareSnapshots`):** issue-level, for the verify
  loop. Composite key `item|orderNumber|workOrderNumber|dueDate`
  (lowercased). Answers: "is every baseline row gone from the new
  report?" → `{ resolved: boolean, resolvedCount, unresolvedCount, … }`.
- **This module (`GET /aps/snapshots/compare`):** row-level, across any
  two RECORDED snapshots of one issue. Stable key
  `type|item|supplyId|demandId` (lowercased), with documented fallback:
  (1) primary key when ≥2 segments are non-empty; (2) the sibling's
  composite key (prefixed `sibling:`); (3) `rowIndex` (prefixed `row:`);
  empty key = unmatchable, reported as `new`, never dropped. Answers per
  row: `resolved | still-open | worsened | new`, where `worsened` fires
  on a severity-rank rise or a growing `daysLate` evidence field.

The endpoint builds on the same snapshots the sibling's tool reads
(the issue's recorded snapshot list) — no second snapshot store.

## Snapshot endpoints and the sibling's store

Snapshots live INSIDE the sibling's issue documents, so the snapshot
endpoints require `issueId`:
- `GET /aps/snapshots?issueId=` — the issue's snapshots, newest first.
- `GET /aps/snapshots/:snapshotId?issueId=` — one snapshot.
- `GET /aps/snapshots/compare?base=&other=&issueId=` — row-level
  verdicts between two recorded snapshots.

All three go through `SubstrateClient.getIssue`, which now calls the
sibling's store directly (mocked in tests via `overrideSubstrateClient`).

## Known limitations (this phase)

- `pending-substrate` analyses are retried via
  `POST /aps/analyses/:id/retry` (idempotent, atomic claim, audited) —
  run it after publishing the flows (see
  `docs/aps-planning-agent/enablement.md`). There is still no scheduler
  that auto-starts them when the pipeline lands.
- The agent-judgment seam (`agentJudgment.ts`) now has its REST trigger:
  `POST /aps/issues/:issueId/judgment` (explain/prioritize/recommend,
  aggregates-only, schema-validated). It serves the chat/context path —
  it does not duplicate the flow's pipeline agent steps.
- Chat reaches APS through the sibling's 10 `aps.*` tools (landed, PR
  #64), offered on the `syteline` capability slot when APS patterns
  match.
