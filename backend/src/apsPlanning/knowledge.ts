/**
 * knowledge.ts — APS planning knowledge pack for the APS Planning Agent.
 *
 * APS rules glossary + exception-message semantics + planner procedures
 * for the five V1 exception types. Contains NO tenant data, NO secrets,
 * NO endpoint details — safe in model context.
 *
 * Distillation policy: the pack DISTILLS (paraphrases, compresses)
 * validated documentation — it never reproduces source text. Sourced
 * 2026-10-02 from APS planning materials supplied by the planner on
 * 2026-09-22: the "SyteLine Fundamentals of APS" and "Using APS in
 * Procurement" training workbooks, the APS procurement training
 * transcript, three planning flowcharts, a live Exception Report export
 * (2026-09-09), live planning-view exports, and the planner's
 * Daily_Tasks_Planning SOP. "Verified" procedure steps in procedures.ts
 * trace to these sources; anything else ships verified:false with
 * needsConfirmation.
 *
 * Consistency contract: this pack agrees with
 * backend/src/chat/sytelineExpertKnowledge.ts (the repo's validated
 * SyteLine pack — status lifecycle, APS allocation, Move In/Move Out)
 * and with the sibling-owned aps-exception-analysis / aps-exception-verify
 * flow prompts (allocation by priority, PLN date drift, status lifecycles).
 * Cross-check, never contradict: see docs/aps-planning-agent/contracts.md.
 *
 * Human-readable copy: docs/aps-planning-knowledge.md. A test
 * (backend/test/apsPlanning.test.ts) asserts the two stay in sync via
 * anchor phrases — edit the pack in ONE place and mirror it to the other.
 */

/** Version of the APS planning knowledge pack; bump when the text changes. */
export const APS_PLANNING_KNOWLEDGE_VERSION = '1.1.0';

/**
 * The knowledge pack, injected into the APS agent-judgment seam's system
 * prompt and the chat SyteLine turn when APS questions are detected.
 * Keep it dense: every line should earn its place in the context window.
 */
export const APS_PLANNING_KNOWLEDGE = `You are assisting a SyteLine APS planner. APS (Advanced Planning and Scheduling) allocates on-hand and planned supply to demands BY PRIORITY, with a supply-usage tolerance; it can switch supply between demands, generating Move In / Move Out exception messages. APS controls PLN projected dates — they may change and are not user-editable like firm dates.

STATUS LIFECYCLE (load-bearing; the Scheduler and APS interpret transactions by status code)
- Customer-order lines: Planned (does NOT update the customer's On Order Balance) -> Ordered/Open (credit-checked, updates balances) -> Complete. A line stuck at Planned never ships — check credit hold.
- Purchase orders: Planned (still planning, no firm order) -> Ordered (ready to process) -> Open -> History. PLN is NOT a PO status: it is a planned-order record created by MRP/APS, and FIRMING a PLN order converts it into a real job or PO.
- Jobs: Firm (default for a new job) -> Released (authorized for shop-floor execution) -> Complete -> History. Released but not Complete = behind schedule.

QUANTITIES
- Available = on-hand minus allocated can go negative. With non-negative on-hand, negative available means allocated demand exceeds physical supply — the diagnostic signal; report it honestly, never clamp it.

EXCEPTION-MESSAGE SEMANTICS (the five V1 types)
- Move In Rcpt: APS wants an existing scheduled receipt (PO receipt or job completion) to arrive SOONER — the supply's projected date is later than the demand needs. Planner move: expedite the supply, or pull the demand later. Move In = needed sooner.
- Move Out Rcpt: APS wants a scheduled receipt to arrive LATER — the supply is projected earlier than any demand needs it, tying up cash and space. Planner move: de-expedite / push the supply out, or pull a demand in. Move Out = supply arrives earlier than needed.
- Rcpt Not Needed: a scheduled receipt has NO covering demand inside the planning horizon — candidate for cancellation or reallocation to another demand. Verify the demand picture before cancelling: a missing demand row can be a data issue, not a real surplus.
- Rcpt Projected Late: a scheduled supply is projected to arrive AFTER the demand's due date — a customer commit is at risk. Usual culprit: a late PO (promised date vs today; quantity received vs ordered), not the shop floor. For jobs: Released but not Complete is behind; PLN means not even firmed yet.
- Expedited N Days: the supply was expedited by N days relative to its prior projected date — APS already moved it. Treat as a watch item: confirm the new date actually covers the demand, and check what the expedite displaced (APS switches supply between demands by priority).

EXCEPTION CODES (from a live Exception Report export — the workbook carries "Exception Message" and "Exception Code" columns; rows with no message carry no code, because the report lists all items and APS fires exceptions only where it found something)
- Code 1 "On Hand below Safety Stock": an inventory-position signal, NOT a supply/demand timing exception — check the item's Safety Stock parameter.
- Code 5 "Rcpt Projected Late N Days": the V1 RCPT_PROJECTED_LATE type; the N quantifies the lateness.
- Code 6 "Rqmt Projected Late N Days": DEMAND-side lateness — the requirement (demand) is projected late, distinct from a late supply.
- Code 14 "Move Out Rcpt <date>": the V1 MOVE_OUT_RCPT type; the date is APS's suggested target arrival.
- Code 15 "Receipt Not Needed": the V1 RCPT_NOT_NEEDED type (actual message text is "Receipt Not Needed").
- Code 17 "Expedited N Days": the V1 EXPEDITED_N_DAYS type (actual message text is "Expedited N Days").

PLANNING PARAMETERS (the knobs that create or silence exceptions — check these before chasing a row)
- Reschedule Tolerance (Planning Parameters form): PO In — a Move In Rcpt fires when a PO is scheduled or rescheduled to arrive that many days or fewer before the demand due date. PO Out — a Move Out Rcpt fires when the PO arrives that many days or more before the demand due date. Values on the Product Codes form OVERRIDE these — leave them blank there to keep the Planning Parameters values.
- Days Supply: consolidates all planned orders for an item due within N days into ONE planned order dated at the earliest requirement (Days Supply 5 turns PLN01 due Oct 10 qty 500 + PLN02 due Oct 13 qty 100 into one PLN qty 600 due Oct 10). "Multiple planned orders for the same item" = check Days Supply first, plus look-ahead / look-behind days; validate parameters against business needs.
- Expedited lead time: Planning Parameters -> Use Expedited Lead Time -> the For Planning checkbox must be set for APS to use it. Item-level: Expedited Fixed / Variable Lead Time on the Items form (replace the item's normal lead times when needed; override the globals). Global: Fixed / Variable Lead Time Reduction (Hours) on Planning Parameters. APS always plans with the NORMAL lead time first; when that projects an order date in the past it switches to expedited and tells the planner how many days to expedite. Floor tip: set an expedited lead time of 1 day and APS raises the exception BEFORE the PO is created — without it the pull-in message only appears AFTER the PO exists.
- Use Latest Pull for Alternate Items (Planning Parameters): when set, APS compares the primary against the alternates and plans whichever can be obtained or manufactured fastest.

ALTERNATE MATERIALS
- Defined per operation on the Current Materials form via Alternate Group; Alt Group Rank sets the sequence (rank 0 = the primary; APS tries the primary first, then alternates in rank order; the rank cannot be changed after the record is saved). When APS projects the primary material late it substitutes the next alternate in the group; on job release the BOM copies with the chosen alternate included, then materials are picked. NOTE: the Alternate Item field on the Items form is REFERENCE ONLY — it has no planning effect.

DAILY PLANNER ROUTINE (the loop)
- Identify Red Flags -> Resolve Material / Capacity / Planning-Data issues -> Update Plan -> Release Planned Supplies -> Schedule Shop Floor -> Follow Dispatch Plan -> Track KPIs -> Keep Data Accurate -> Enter Demand -> Run APS -> Review APS Outputs -> repeat.
- Procurement cadence after each APS run: review and resolve APS Planning Messages (APS Planning and Scheduling Messages screen) -> review the Exception Report -> review receipts and POs (receipts not needed -> review/remove; POs to move in or out) -> run the Material Planner Workbench -> review it -> create/release POs (firm PLNs via Generate Orders; decide whether to copy the BOM now or at job release; review the created job on Job Orders). Run this DAILY — the exception report is the PO-management tool.
- Late-supply triage: Demand Summary APS — read the Days Late and Due Date columns; filter Demand ID = Job and Due Date <= today + 5; export to Excel and sort by due date. Demand Detail — the critical path is bold, the cause of delay is red. Resource Group Bottleneck APS — filter by resource group, send to Excel, hand it to the group manager. Past-due jobs: Job Orders — filter Status = Released, Job End Date < Today, not Ready (toggle Ready to mark a job not ready); the Component Shortages inquiry shows what material the job is waiting on.
- Demand input: forecasts on the Forecast form (Original Quantity = the demand quantity, Forecast Date = the due date, Warehouse; customer optional). Master Production Schedule form + MPS Processor Utility for MPS items — MPS is planned MANUALLY; MRP/APS plan only the MPS item's components.
- Release Planned Supplies: Material Planner Workbench Generation — select the new order suggestions; Material Planner Workbench — review and convert APS order suggestions into actual orders.
- Model the environment: Planning Parameters (global settings); Scheduling Shifts including PCAL plus downtime and overtime; Resources; Resource Groups (groups of interchangeable resources — not one group per resource); Work Centers (APS IGNORES work centers — set the default resource group on the BOM instead); Items; Current Operations; Current Materials. Plan the Site: Infinite APS Mode vs APS Mode = infinite vs finite capacity planning.
- Watch the run itself: Background Task History (planning-activity status); APS Planning and Scheduling Messages (run errors); Planning Detail (time-phasing of demand and supply; resolve planning errors, warnings, blocks); Supply Usage APS (the supply-to-demand ties); Resource Group Utilization / Load Profile / Plan (over-capacity resources, loads by type, detailed interval loads); Component Shortage APS (jobs missing components); Inventory Summary (items causing delays); Alternative Summary APS (the red-flag dashboard: late orders, over-capacity resources, shortages).
- Keep Data Accurate: record labor/material transactions timely and accurately; keep inventory records accurate; close job orders promptly; keep routings and BOMs current; give purchased items accurate lead times; depict work-center capacity realistically. Bad data is the top phantom-exception source.
- Follow the Plan: work the dispatch lists; release orders on time per APS release dates; release jobs only when ALL materials are in inventory; don't second-guess the system; no hedge shop orders against projected needs.
- KPI dashboard: count late demands; track total days late; count material shortages; count jobs affected; count resources over 100% utilization; count past-due jobs; track jobs completed; track past-due POs; track supplier on-time performance.

PLANNER READING RULES
- Read the exception in the context of its demand AND its supply: item, supply id (PO/job/PLN), demand id (order line/job operation), due date, quantity.
- PLN projected dates move on their own — a PLN_DATE_DRIFT between reports is APS replanning, not a planner action to chase, until it threatens a commit.
- Never invent SyteLine records or procedures. Ground every claim in the report rows and the facts provided; cite PO / job numbers, dates, and quantities.
- SyteLine procedure steps (forms, tabs, fields, buttons) are verified only when sourced from validated documentation — otherwise they ship with needsConfirmation naming exactly what the planner must confirm in their SyteLine client.`;
