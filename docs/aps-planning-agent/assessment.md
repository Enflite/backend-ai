# APS Planning Agent — Phase 0 Architecture Assessment

**Status:** assessment only. No feature code. Produced 2026-10-02 against `main` @ `93460da` (post-PR #57).
**Product:** APS Planning Agent — "Your AI planner for SyteLine APS." First-class agent inside Enflite AI, not a separate app. V1 is read-only vs SyteLine.
**Companion in-flight work (integrate, don't duplicate):** the exception-resolution flow being authored on the Flows platform; the Schedules API build.

---

## 1. Current architecture assessment

### Backend (`backend/src`, Fastify, `/api/v1`, MongoDB)

| Area | Maturity | Notes |
|---|---|---|
| HTTP/API | High | Fastify, zod-validated routes, versioned `/api/v1`, camelCase API shapes, `definition-of-done.md` merge bar enforced |
| Auth/Authz | High | JWT + OIDC + server-side sessions; `requireAuth`/`requirePermission`; classification lattice (PUBLIC→CUI); permissions seeded via migrations (`syteline:read/forms/ui` precedent) |
| AI gateway | High | `ai/gateway`: capability router (closed slots: `chat`, `syteline`, `coding`, `embeddings`), provider factory (Claude/OpenAI/Ollama), privacy routing (sensitive→local, fail-closed), per-user concurrency limits |
| Chat + agentic loop | High | `agenticLoop.ts`: bounded iterations, per-step audit (argument *keys* only), dependent chaining, approval-gated destructive tools, streaming honesty |
| Tools registry | High | `tools/gateway.ts` `toolRegistry`: `ToolDefinition` with permission, `destructive` flag, `secretParams` redaction; `POST /tools/:name/execute`; tool families: `syteline.*`, `syteline.forms.*`, `syteline.ui.*`, `syteline.task.*` |
| Documents/uploads | High | Multipart upload, classification, SHA-256, S3 storage, malware boundary (production hard gate: won't boot without a reachable scanner), ingestion queue; `extraction.ts` parses Excel via ExcelJS — but into **text sections**, not typed rows |
| Flows platform | Medium-High | `backend/src/flows` (PRs #54/#56): zod `FlowDefinition`, step kinds `tool`/`subflow`/`agent`/`condition`, versioning + `live` alias with If-Match, deterministic runner, 15 endpoints, fail-closed flags. No `.flow.json` files shipped yet; the Form AI Agent reconciliation and the APS exception flow are the first consumers |
| Product modules | Medium-High | `formAgent/` is the pattern: isolated module, narrow `index.ts` interface, own REST API, scheduler, declarative flow, `agentJudgment` escalation seam, versioned knowledge pack with docs-sync test |
| SyteLine task agents | Medium-High | `syteline/tasks`: queue, atomic claim, server-side runner, per-step audit + screenshot evidence, lifecycle `assigned→in_progress→awaiting_review→completed/blocked/cancelled`, completion reports to conversations |
| RAG/knowledge | Medium | `rag/` retrieval with grants; `sytelineExpertKnowledge.ts` pack injected on SyteLine turns (versioned, docs-mirrored, sync-tested). APS coverage in the pack is thin (a few paragraphs; no procedure-level detail) |
| Eval | Medium | Framework with categories, judges, corpus; `syteline` category exists. No APS cases |
| Learning/fine-tune | Medium | Flywheel exists; not relevant to V1 |
| Schedules | In flight | Branches `muse/schedules-*` exist; API not on main yet |

### Frontend (`frontend/src`, post-PR #57)

React + react-router with `AppShell` nav (Chat, Board, Form AI Agent, SyteLine), permission-aware nav items, per-domain API modules (`api/tasks.ts`, `api/formAgent.ts`, `api/syteline.ts`, `api/tools.ts`), `usePolling` hook, shared primitives (StatusBadge, ErrorState). Board unifies work items as cards with kinds `task`/`form` (+ `flow`/`schedule`/`batch` reserved as "coming soon"). Chat itself is mature (SSE, citations, model switching).

### Honest summary

The platform is genuinely ready for this agent: upload pipeline, deterministic flow runner, agent-escalation seam, audit, permissions, eval, and a frontend shell with a work-item board all exist. What's missing is everything APS-specific: structured Excel parsing, export-type adapters, the rules engine, the issue/snapshot model, APS procedure knowledge, and planner UI.

---

## 2. Existing agent architecture — how agents get added today

There is no single "Agent registry." Three coexisting patterns:

1. **Chat capability + tool family** (the SyteLine diagnostic pattern): `capabilityDetect.ts` routes a turn → capability slot → serving default; the agentic loop runs with an offered tool family; `sytelineExpertKnowledge.ts` pack shapes reasoning. Add-an-agent = new tool family + detection patterns + knowledge pack (+ optionally a new capability slot — the slot list is closed and validated).
2. **Product module** (the `formAgent/` pattern): isolated directory, narrow `index.ts` public surface, own REST API + scheduler + store, declarative flow definition, `agentJudgment` seam for LLM steps, versioned knowledge pack mirrored in docs with a sync test. This is the pattern for agents with their own lifecycle, UI, and API.
3. **Flows platform**: deterministic pipelines with `agent` steps for judgment. The in-flight exception-resolution flow is being authored here.

**Recommendation:** the APS Planning Agent is pattern #2 (product module `backend/src/apsPlanning/`) whose deterministic pipeline is authored as versioned flows on the platform (pattern #3), with chat access via pattern #1 (APS detection → offer `aps.*` tools). This mirrors exactly how the Form AI Agent was built, and reuses every seam.

---

## 3. Exact integration points (no duplicate abstractions)

| Need | Extend this — do not build new |
|---|---|
| Agent home | NEW `backend/src/apsPlanning/` module, following `formAgent/index.ts` narrow-interface pattern (routes, store, runner/scheduler, flow def, knowledge pack, version) |
| Deterministic pipeline | Flows platform (`backend/src/flows`): author `aps-exception-resolution` as `.flow.json` — the in-flight coordinator owns this; this assessment's slice must consume it, not fork it |
| Agent judgment steps | Flow `agent`-kind steps + the `agentJudgment` seam pattern from `formAgent/agentJudgment.ts` (bounded call, JSON-schema-validated output) |
| Tool surface | `backend/src/tools/apsPlanning.ts`: `aps.*` `ToolDefinition`s in the existing registry (permission `aps:plan`, `destructive: false` — V1 is read-only) |
| File upload | `documents/routes.ts` multipart pipeline (malware scan, classification, S3) — APS exports are documents; add export-type tagging, do NOT write a second uploader |
| Excel parsing | `documents/extraction.ts` has ExcelJS — add **structured row extraction** (typed rows + header map) alongside text sections; do not replace it |
| Knowledge | `backend/src/chat/apsPlanningKnowledge.ts` pack + `docs/aps-planning-knowledge.md` mirror + sync test (exact `sytelineExpertKnowledge.ts` pattern); APS rules glossary + exception-message semantics |
| Chat routing | `chat/capabilityDetect.ts`: APS patterns (exception report, "why is this job late", PO-#####, "move in") → offer `aps.*` tools on the `syteline` capability slot. New slot only if V1 proves the need |
| Permissions | `authz/permissions.ts` + migration `034_aps_planning.ts` seeding `aps:plan` (Admin/AI Admin, following `030/031/032` precedent) |
| Snapshots/issues persistence | New Mongo collections `aps_snapshots`, `aps_issues` via migration (same registry pattern as `032_syteline_tasks.ts`) |
| Audit | `audit/audit.ts` `recordAudit` — every parse/rule/analysis step audited like task-agent steps |
| Privacy | `ai/gateway/privacyRouting.ts` — uploaded exports carry supplier/pricing data: treat as proprietary/finance → **local model** unless tenant policy allows otherwise. This is a hard constraint on V1 LLM quality (CPU-only box) — see risks |
| Eval | `eval/` new category `aps-planning`; fixture-based cases |
| Frontend | New `views/ApsPlanningView.tsx` + nav item (permission `aps:plan`) + `api/apsPlanning.ts` module; board card kind `aps` (board types already reserve kinds — add real normalizer) |
| API docs | `docs/api.md` new section (follows `## SyteLine Form AI Agent` structure) |

**Do NOT touch:** the gateway's provider abstraction, the documents malware boundary, the flows runner core, auth primitives, migration runner mechanics.

---

## 4. Recommended file/module structure

```
backend/src/apsPlanning/
  index.ts            # narrow public interface (formAgent/index.ts pattern)
  version.ts          # APS_AGENT_VERSION
  types.ts            # Snapshot, Issue, Evidence, RootCause, Recommendation, SyteLineProcedure (zod)
  knowledge.ts        # APS knowledge pack (rules glossary, exception semantics)
  exports.ts          # export-type registry: adapters per SyteLine export
  excelParsing.ts     # structured row extraction (typed rows + header map)
  normalize.ts        # canonical planning model builder (deterministic)
  rules.ts            # deterministic rules engine (facts only)
  issues.ts           # issue object lifecycle (open/update/resolve/verify)
  snapshots.ts        # snapshot store + before/after comparison
  procedures.ts       # SyteLine procedure guidance (verified/unverified marking)
  agentJudgment.ts    # LLM seam: explain/correlate/prioritize/recommend (schema-validated)
  routes.ts           # /api/v1/aps/* REST
  store.ts            # Mongo access (aps_snapshots, aps_issues)
  scheduler.ts        # runner lifecycle (only if/when scheduled APS runs are wanted; V1: manual)
backend/src/tools/apsPlanning.ts   # aps.* tool definitions
backend/src/chat/apsPlanningKnowledge.ts
docs/aps-planning-agent/           # assessment.md (this file), roadmap, knowledge mirror
docs/api.md                        # new ## APS Planning Agent section
flows/aps-exception-resolution.flow.json  # owned by in-flight coordinator; consumed here
frontend/src/views/ApsPlanningView.tsx
frontend/src/api/apsPlanning.ts
frontend/src/board/               # add 'aps' card kind normalizer
backend/test/apsPlanning.*.test.ts
backend/test/fixtures/aps/        # golden .xlsx exports
```

---

## 5. Data model proposal

Adapted to repo conventions (zod schemas, tenant-scoped Mongo docs, camelCase API):

**Snapshot** (`aps_snapshots`): `{ id, tenantId, ownerId, sourceDocumentIds[], exportType: 'EXCEPTION_REPORT' (V1), uploadedAt, rowCount, normalizedHash, stats: { issueCounts by type/severity }, supersedesSnapshotId? }`

**Canonical planning model** (derived per snapshot, deterministic, stored alongside): indexes linking `demand → item → bom → component → supply[]` where supply ∈ `{ purchaseOrder, plannedOrder, job }`, plus `supplier`, `resourceGroup`, `workCenter`, `leadTimeDays`, `daysSupply`, `safetyStock`. Built by `normalize.ts` from typed rows — never by the LLM.

**Issue** (`aps_issues`), adapting Jake's example to repo shapes:
```ts
{
  issueId: 'APS-2026-000142',            // string, human-readable, unique per tenant
  snapshotId: string,                    // source snapshot
  type: 'RECEIPT_PROJECTED_LATE' | 'RESOURCE_OVER_CAPACITY' | 'COMPONENT_SHORTAGE'
      | 'POSSIBLE_PLN_CONSOLIDATION' | 'SUPPLY_NEEDS_TO_MOVE_EARLIER'
      | 'SUPPLY_MAY_BE_MOVED_LATER' | 'EXCESS_OR_UNNEEDED_SUPPLY' | 'EXPEDITE_INVESTIGATION',
  severity: 'critical' | 'high' | 'medium' | 'low',   // deterministic scoring, documented thresholds
  item?: string, demandId?: string, supplyId?: string,
  evidence: Record<string, string | number>,           // the facts the rule fired on
  rootCause: { category: 'supplier' | 'capacity' | 'planning-parameter' | 'data' | 'unknown',
               confidence: number, reasoning: string }, // category deterministic where possible; reasoning via LLM
  recommendedActions: string[],
  sytelineProcedure: { form?: string, steps: string[], verified: boolean,
                       needsConfirmation?: string },   // NEVER invented: verified=false → marked
  status: 'open' | 'resolved' | 'worsened' | 'stale',
  history: Array<{ at: Date, snapshotId: string, status: string, note: string }>,
  createdAt: Date, updatedAt: Date,
}
```

**Snapshot comparison**: match issues across snapshots by stable identity key (`type + item + supplyId + demandId`, with documented fallback rules); emit per-issue `resolved | still-open | worsened | new` by re-evaluating evidence — never by assumption.

---

## 6. First vertical slice implementation plan

**Scope: Exception Report → analysis → recommendation → verification.** Five exception types: Move In Rcpt, Move Out Rcpt, Rcpt Not Needed, Rcpt Projected Late, Expedited N Days.

1. **Upload**: reuse documents pipeline; tag `exportType: EXCEPTION_REPORT`; malware/classification as usual.
2. **Parse**: structured Excel rows via new `excelParsing.ts`; fixture-backed (golden `.xlsx` per SyteLine export layout).
3. **Validate**: required columns present (explicit column map per export type — see risks); missing-data and duplicate detection; 4xx with actionable errors.
4. **Normalize**: deterministic build of the canonical model subset needed for the five types (demand/supply/item/date links).
5. **Rules engine** (`rules.ts`, pure functions, unit-tested): the eight fact types Jake specified — `RECEIPT_PROJECTED_LATE`, `RESOURCE_OVER_CAPACITY`, `COMPONENT_SHORTAGE`, `POSSIBLE_PLN_CONSOLIDATION`, `SUPPLY_NEEDS_TO_MOVE_EARLIER`, `SUPPLY_MAY_BE_MOVED_LATER`, `EXCESS_OR_UNNEEDED_SUPPLY`, `EXPEDITE_INVESTIGATION`. Facts only — no prose.
6. **LLM layer** (`agentJudgment.ts`): explain, correlate across issues, assign root-cause categories + confidence, prioritize, generate recommendations and SyteLine steps. Schema-validated JSON out. Runs on the privacy-routed model (expect local on sensitive exports).
7. **Issue objects**: created per fired rule, shown in the planner work queue.
8. **SyteLine procedure guidance**: from the knowledge pack + Jake's APS workbooks where procedures are documented; anything else emitted with `verified: false` + `needsConfirmation` — never hallucinated forms/fields.
9. **Planner executes manually** (V1 read-only — no SyteLine writes, no UI automation for this agent).
10. **Re-upload → new snapshot → compare → verify**: per-issue `resolved/still-open/worsened` with evidence diff.
11. **Flow wiring**: steps 1–10 authored as the versioned `aps-exception-resolution` flow on the Flows platform (in-flight coordinator); the product module exposes it via REST + tools + chat.

---

## 7. UI changes required (mapped onto post-#57 frontend)

- **Nav**: new "APS Planning" item in `AppShell`, permission `aps:plan`.
- **Upload experience** (`/aps`): export-type picker (V1: Exception Report only), file drop (reuse documents upload UX patterns), column-map confirmation when headers don't match the known layout, validation errors inline.
- **Work queue** (`/aps/queue`): prioritized issue list — severity ordering with counts (the 🔴🟠🟡 summary), each row: issue id, type, item/supply, days-late or key evidence, [Start]/[Review]/[Investigate] actions.
- **Issue detail** (`/aps/issues/:id`): WHAT IS WRONG / WHY IT MATTERS / EVIDENCE / LIKELY ROOT CAUSE (+confidence) / RECOMMENDED ACTION / SYTELINE STEPS (verified badge or "needs confirmation") / EXPECTED RESULT / VERIFY. Link to snapshot.
- **Snapshot compare** (`/aps/snapshots/:id/compare`): before/after counts, per-issue resolved/still-open/worsened/new with evidence diff.
- **Board integration**: `aps` card kind (analyses appear on the kanban like tasks/forms).
- **Chat**: "Analyze today's APS exceptions" / "What should I work on first?" / "I fixed the PO — did it resolve?" work via `aps.*` tools + the detail views for evidence.

---

## 8. Test strategy

- **Unit tests per deterministic rule** (`rules.test.ts`): table-driven — input rows → expected fired facts; every threshold documented in the test name.
- **Fixture-based Excel parsing tests**: golden `.xlsx` fixtures in `backend/test/fixtures/aps/` (one per supported export layout); assert typed rows + header map + validation errors on a corrupted fixture.
- **Normalization tests**: fixture rows → expected canonical links (demand→item→supply).
- **Snapshot comparison tests**: two fixture snapshots → expected resolved/still-open/worsened/new verdicts, including a key-change case.
- **Slice end-to-end test**: upload fixture → issues created → re-upload second fixture → verification verdicts; gateway mocked (follow the repo's mock-judge/test-seam precedents); labeled honestly per the definition of done.
- **Knowledge sync test**: pack ↔ docs mirror anchor-phrase test (the `sytelineExpertKnowledge` pattern).
- **Eval**: new `aps-planning` eval category; seed cases from the fixtures; LLM-judge only for the explanation/recommendation layer, deterministic assertions for facts.

---

## 9. Risks / unknowns (blunt)

1. **Excel format variance is the #1 risk.** SyteLine export layouts differ by version, site, and tenant customization. A hardcoded column layout *will* break. Mitigation: explicit per-export-type column maps, a column-map confirmation step in the UI, and strict validation errors — not silent guessing.
2. **Snapshot identity matching is fragile.** PO/job keys can change between exports (releases, splits). Naive key matching produces false "resolved" verdicts — the worst failure mode for a verification product. The matching rules need their own tests and a documented fallback chain.
3. **SyteLine procedure knowledge is thin.** The repo's knowledge pack has form vocabulary, not step-by-step procedures. Until Jake's APS workbooks are distilled into a procedure source, most `sytelineProcedure`s must ship `verified: false`. Inventing a button is worse than saying "confirm."
4. **Privacy routing constrains V1 quality.** Exports contain supplier/pricing data → proprietary/finance → local model on a CPU-only box (8B ceiling). The deterministic engine carries V1; the LLM layer will be weaker than Claude until the tenant explicitly allows cloud routing for planning data. Say this upfront.
5. **Overlap with the in-flight exception flow.** Two coordinators must not build two pipelines. This assessment's slice consumes the Flows-platform flow; the module owns tools/REST/UI/knowledge.
6. **Scope discipline.** The spec lists 15 datasets and 5 phases. V1 is one export type, five exception types, read-only. Everything else is an adapter or a phase, not a V1 feature.
7. **No SyteLine write path in V1** — by design, but the "Planner Executes" step depends on the human; the verification loop only works if planners actually re-export. Adoption risk, not a code risk.

**V1 explicitly will NOT:** modify SyteLine, use UI automation or stored SyteLine logins, support export types beyond Exception Report, do historical trending, schedule automatic runs (Schedules API can add this later), or send export data to cloud models against privacy policy.

---

## 10. Phased roadmap (reshaped to repo reality)

- **Phase 0 — Assessment** (this document). Done.
- **Phase 1 — Domain foundation**: `apsPlanning/` module skeleton, zod types, export-type registry + Exception Report adapter, structured Excel parsing, normalization, the 8-rule deterministic engine, issue model, `aps:plan` permission + migration, unit + fixture tests. No LLM, no UI.
- **Phase 2 — Vertical slice**: knowledge pack, `agentJudgment` LLM layer, `aps.*` tools, `/api/v1/aps/*` REST, snapshot store + comparison, integration with the in-flight `aps-exception-resolution` flow, chat detection patterns, minimal UI (upload → queue → detail → re-upload → verify). Eval category seeded.
- **Phase 3 — Planner UI**: full work queue, snapshot compare view, board `aps` cards, procedure verified/unverified UX.
- **Phase 4 — Additional datasets**: one adapter per dataset (Material Planner Workbench, Planning Detail, …), each with fixtures + rules; canonical model extended incrementally.
- **Phase 5 — Planning Intelligence**: snapshot series, recurring-pattern detection (supplier lateness, repeated shortages, capacity trends), KPI trends. Schedules API drives the daily runs.

---

## Appendix: smallest shippable slice (scope, not hours)

**In:** single Exception Report layout (explicit column map + confirmation UI on mismatch) → parse → validate → normalize → 8 deterministic rules → issue objects → LLM explanation/recommendation/SyteLine steps (verified/unverified marked) → snapshot store → re-upload → compare → resolved/still-open/worsened verdicts → minimal UI (upload, queue, detail, compare) → chat Q&A over the snapshot → tests + eval seeds + docs.

**Out:** other 14 datasets, multi-file uploads, historical intelligence, scheduled runs, SyteLine writes, procedure DB beyond the 5 exception types, cloud-model analysis of sensitive exports (privacy policy decides).

**Touches:** NEW `backend/src/apsPlanning/` (+ `tools/apsPlanning.ts`, `chat/apsPlanningKnowledge.ts`), migration `034`, `flows/aps-exception-resolution.flow.json` (in-flight), `docs/aps-planning-agent/*`, `docs/api.md`, frontend `views/ApsPlanningView.tsx` + `api/apsPlanning.ts` + nav + board kind. Nothing else.
