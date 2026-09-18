# ADR-008: Model promotion gated on evaluations

**Status:** Accepted

## Context

Approving a model for production use on vibes is how regressions ship. The
platform already measures quality (Phase 2 eval framework: deterministic
judges, LLM-judge harness, 100+ case corpus); the lifecycle must actually
listen to it.

## Decision

- Model lifecycle is a database-enforced state machine (migration
  `017_model_lifecycle.sql`):
  `REGISTERED → DOWNLOADING → VALIDATING → EVALUATING → PENDING_APPROVAL →
  APPROVED → CANARY → ACTIVE → DEPRECATED → RETIRED` (plus `DISABLED`).
- Transitions happen only through `POST /api/v1/admin/models/:id/transition`
  (`model:manage` permission), are audited, and record
  `approved_by` / `approved_at` on the `PENDING_APPROVAL → APPROVED` step.
- The `PENDING_APPROVAL → APPROVED` transition requires the eval promotion
  gate to pass: `getPromotionGate(modelId)` (`backend/src/eval/compare.ts`)
  checks the latest eval run; `last_eval_run_id` on the model row points at
  the run that cleared it. Failed required evaluations block promotion —
  there is no override flag.
- `GET /api/v1/admin/eval/promotion-gate?modelId=…` exposes the gate state
  so admins see *why* a model is blocked.

## Consequences

- No model reaches users without measured quality and a named human
  approver; both are on the record.
- Eval regressions block promotion automatically — the gate is code, not
  process.
- Deterministic evals run in CI; LLM-judge cases are versioned and labeled
  as requiring a judge model, never silently skipped into a pass.
