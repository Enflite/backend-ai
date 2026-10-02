# APS Planning Knowledge

Human-readable mirror of the APS planning knowledge pack
(`backend/src/apsPlanning/knowledge.ts`, version `1.0.0`). The pack is the
runtime copy injected into the agent-judgment seam's system prompt; this
document is the reviewable copy. A test
(`backend/test/apsPlanning.test.ts`) asserts the two stay in sync via
anchor phrases — edit the pack in ONE place and mirror it here.

## APS allocation model

APS (Advanced Planning and Scheduling) allocates on-hand and planned supply
to demands **by priority**, with a **supply-usage tolerance**; it can switch
supply between demands, generating Move In / Move Out exception messages.
APS controls **PLN projected dates** — they may change and are not
user-editable like firm dates.

## Status lifecycle

Statuses are load-bearing; the Scheduler and APS interpret transactions by
status code.

- **Customer-order lines:** Planned (does NOT update the customer's On Order
  Balance) → Ordered/Open (credit-checked, updates balances) → Complete. A
  line stuck at Planned never ships — check credit hold.
- **Purchase orders:** Planned (still planning, no firm order) → Ordered
  (ready to process) → Open → History. PLN is NOT a PO status: it is a
  planned-order record created by MRP/APS, and **FIRMING a PLN order**
  converts it into a real job or PO.
- **Jobs:** Firm (default for a new job) → Released (authorized for
  shop-floor execution) → Complete → History. Released but not Complete =
  behind schedule.

## Quantities

Available = on-hand minus allocated can go negative. With non-negative
on-hand, negative available means allocated demand exceeds physical supply —
the diagnostic signal; report it honestly, never clamp it.

## Exception-message semantics (the five V1 types)

- **Move In Rcpt:** APS wants an existing scheduled receipt (PO receipt or
  job completion) to arrive SOONER — the supply's projected date is later
  than the demand needs. Planner move: expedite the supply, or pull the
  demand later. Move In = needed sooner.
- **Move Out Rcpt:** APS wants a scheduled receipt to arrive LATER — the
  supply is projected earlier than any demand needs it, tying up cash and
  space. Planner move: de-expedite / push the supply out, or pull a demand
  in. Move Out = supply arrives earlier than needed.
- **Rcpt Not Needed:** a scheduled receipt has NO covering demand inside the
  planning horizon — candidate for cancellation or reallocation to another
  demand. Verify the demand picture before cancelling: a missing demand row
  can be a data issue, not a real surplus.
- **Rcpt Projected Late:** a scheduled supply is projected to arrive AFTER
  the demand's due date — a customer commit is at risk. Usual culprit: a
  late PO (promised date vs today; quantity received vs ordered), not the
  shop floor. For jobs: Released but not Complete is behind; PLN means not
  even firmed yet.
- **Expedited N Days:** the supply was expedited by N days relative to its
  prior projected date — APS already moved it. Treat as a watch item:
  confirm the new date actually covers the demand, and check what the
  expedite displaced (APS switches supply between demands by priority).

## Planner reading rules

- Read the exception in the context of its demand AND its supply: item,
  supply id (PO/job/PLN), demand id (order line/job operation), due date,
  quantity.
- PLN projected dates move on their own — date drift between reports is APS
  replanning, not a planner action to chase, until it threatens a commit.
- **Never invent SyteLine records or procedures.** Ground every claim in the
  report rows and the facts provided; cite PO / job numbers, dates, and
  quantities.
- SyteLine procedure steps (forms, tabs, fields, buttons) are verified only
  when sourced from validated documentation — otherwise they ship with
  **needsConfirmation** naming exactly what the planner must confirm in
  their SyteLine client.

## Consistency

This pack agrees with `backend/src/chat/sytelineExpertKnowledge.ts` (the
repo's validated SyteLine pack) and with the sibling-owned
`aps-exception-analysis` / `aps-exception-verify` flow prompts. See
`docs/aps-planning-agent/contracts.md` for the reconciliation notes.
