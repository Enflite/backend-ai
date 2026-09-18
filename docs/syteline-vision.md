# SyteLine Agentic Diagnostics — Product Vision

**Status:** build target for Phase 5 (enterprise integrations) and the
SyteLine eval category in Phase 2. This document describes the flagship
use case the platform is built around.

## The idea

The AI doesn't just look things up in SyteLine — it investigates, like a
sharp analyst. A user asks a business question in plain language; the
assistant plans an investigation, chains dependent queries across ERP
entities, and delivers a synthesized, evidence-backed diagnosis.

## Canonical example

> **User:** Why is sales order 12345 late?

> **Assistant:** I'll trace the order lines, then check inventory and open
> supply for anything short. *(one or two lines of plan, then it works)*

Investigation trace (each step audited, each result cited):

1. `get_sales_order("12345")` → header, lines, promised dates, line statuses.
2. For each open line: `get_item_availability(item)` → on-hand, allocated,
   available-to-promise.
3. For short items: `get_open_purchase_orders(item)` → expected receipt
   dates; `get_work_orders(item)` → W/O status and completion estimates.
4. For manufactured items: `get_bom(item)` → explode components, check
   availability of each.
5. Synthesize:

> Line 2 (500× Widget X, promised Tuesday) is short 300 units. PO-789 for
> 400 units was due Tuesday and shows no receipt yet — the supplier is
> 3 days late. Lines 1 and 3 are covered. The delay is PO-789, not your
> shop floor. Want me to pull the supplier's contact and recent delivery
> history?

Every factual claim traces to a real returned record. If a step can't be
checked (denied, timed out), the assistant says so plainly and marks the
conclusion accordingly.

## Requirements

1. **Read-only tools.** No writes to SyteLine in this phase. (Write actions
   are a future phase and will require an explicit human approval workflow.)
2. **Externalized authorization.** Every tool call is authorized by
   application code against the caller's permissions — never by the model.
   All calls are audit-logged with tenant, user, tool, arguments, and
   result size.
3. **Dependent chaining.** The tool loop supports multi-step investigations
   where each query's results shape the next, within a bounded iteration
   budget and per-tool timeouts.
4. **Typed, parameterized, bounded tools.** Entity tools for sales orders,
   order lines, items, inventory availability, purchase orders and receipts,
   work orders, BOMs, and customers. No free-form SQL, no direct database
   access by the model — ever.
5. **Brief narration, evidence-backed synthesis.** The assistant states its
   plan in a line or two, works, then delivers the finding with citations
   to actual records. No raw table dumps; no invented records.
6. **Honest about gaps.** Anything it couldn't check is stated, not hidden.

## Evaluation

The Phase 2 eval framework includes a SyteLine diagnostic category with
fixtures spanning multiple entities. Cases are scored on:

- Correct root-cause identification
- Evidence cited for every material claim (real records only)
- No invented entities, numbers, or statuses
- Graceful handling of denied/failed steps

## Non-goals (this phase)

- Writing back to SyteLine (future phase, approval-gated).
- Arbitrary ERP queries outside the typed tool surface.
- Replacing the judgment of planners and buyers — the AI diagnoses and
  recommends; humans decide.

---

*Related: `docs/assistant-quality.md` (behavioral bar) · `docs/architecture.mmd`
(security architecture) · `TODO.md` Phase 5 (build tasks) · `docs/eval.md`
(measurement)*
