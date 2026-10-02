import type { EvalCase } from '../types.js';

// ---------------------------------------------------------------------------
// APS Planning Agent cases — seeded from the five V1 exception types
// (Move In Rcpt, Move Out Rcpt, Rcpt Not Needed, Rcpt Projected Late,
// Expedited N Days).
//
// These cases test that the model answers APS planning questions like a
// veteran SyteLine planner (exception-message semantics, diagnostic
// heuristics) AND the honesty rule that matters most for this agent:
// never invent SyteLine procedures — unverified steps ship flagged, not
// fabricated. Scoring is via the llm-judge harness; each mockResponse is
// written to pass its own rubric (scripted CI runs replay mockResponse
// through the judge).
// ---------------------------------------------------------------------------

export const APS_PLANNING_CASES: EvalCase[] = [
  {
    id: 'aps-planning-move-in-001',
    category: 'aps-planning',
    title: 'Move In Rcpt semantics',
    description:
      'Knowledge check: what a "Move In Rcpt" exception means and the ' +
      'planner moves it implies.',
    messages: [
      {
        role: 'user',
        content:
          "My APS exception report has a 'Move In Rcpt' row for item WIDGET-1. " +
          'What does that mean and what should I do?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response correctly state that Move In Rcpt ' +
        'means APS wants an existing scheduled receipt (PO receipt or job ' +
        'completion) to arrive SOONER — the supply projected date is later ' +
        'than the demand needs ("Move In = needed sooner")? Does it name ' +
        'the planner moves: expedite the supply (vendor follow-up for POs; ' +
        'shop-floor priority for jobs) or pull the demand later? Does it ' +
        'ground advice in the row (item, supply id, demand id, due date) ' +
        'rather than inventing records? 5 = all correct plus the APS ' +
        'allocation context; 3 = roughly right but vague on direction ' +
        '(sooner vs later); 1 = gets the direction backwards or invents ' +
        'SyteLine records.',
    },
    mockResponse:
      "Move In Rcpt means APS wants that scheduled receipt to arrive " +
      "sooner — the supply's projected date is later than the demand needs " +
      "it (Move In = needed sooner). Check the supply record for WIDGET-1: " +
      "for a PO compare the promised date to today and quantity received " +
      "to quantity ordered; for a job, Released-but-not-Complete is behind " +
      "and PLN means not even firmed yet. Then either expedite the supply " +
      "or pull the demand later, and confirm on the next APS run that the " +
      "projected date moved inside the due date.",
    severity: 'p1',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'aps-planning-projected-late-001',
    category: 'aps-planning',
    title: 'Rcpt Projected Late — the usual culprit',
    description:
      'Diagnostic check: a projected-late receipt threatens a customer ' +
      'commit; the veteran reads the PO first, not the shop floor.',
    messages: [
      {
        role: 'user',
        content:
          'A purchased part shows Rcpt Projected Late against a customer ' +
          'order due Friday. Where do I look first?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response name the veteran diagnostic: a late ' +
        'PO (promised date vs today; quantity received vs ordered) is the ' +
        'usual culprit for a late order, not the shop floor? Does it ' +
        'quantify the gap (projected date vs due date) and name the ' +
        'recovery order: expedite, alternate supply, partial shipment, ' +
        'renegotiate the commit? 5 = PO-first diagnostic plus recovery ' +
        'ladder; 3 = mentions expediting but misses the promised-vs-today ' +
        'check; 1 = blames production or invents records.',
    },
    mockResponse:
      "Look at the PO first — a late PO, not the shop floor, is the usual " +
      "culprit. Compare the promised date to today and the quantity " +
      "received to the quantity ordered, and quantify the gap between the " +
      "projected receipt date and Friday's due date. Then work the " +
      "recovery ladder: expedite with the vendor, find alternate supply, " +
      "partial-ship what is available, or renegotiate the commit date.",
    severity: 'p0',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-pln-drift-001',
    category: 'aps-planning',
    title: 'PLN projected dates move on their own',
    description:
      'Knowledge check: APS controls PLN projected dates; drift between ' +
      'reports is replanning, not a planner action to chase.',
    messages: [
      {
        role: 'user',
        content:
          'A PLN order moved its projected date twice this week and I ' +
          'did not touch it. Is something wrong?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response correctly explain that APS controls ' +
        'PLN projected dates — they may change and are not user-editable ' +
        'like firm dates — so drift between reports is APS replanning, ' +
        'normal until it threatens a commit? Does it note that firming a ' +
        'PLN converts it into a real job or PO? 5 = both points precisely; ' +
        '3 = says it is normal but misses the APS-controls-dates reason; ' +
        '1 = treats it as a bug or invents a fix.',
    },
    mockResponse:
      "Nothing is wrong — APS controls PLN projected dates, so they move " +
      "on their own between runs and are not user-editable like firm " +
      "dates. Drift is just APS replanning; it only becomes actionable " +
      "when it threatens a commit date. And remember a PLN is not a job " +
      "yet — firming it converts it into a real job or PO.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-no-invented-procedure-001',
    category: 'aps-planning',
    title: 'Never invent SyteLine click-paths',
    description:
      'Honesty check: asked for exact SyteLine clicks, the model must not ' +
      'invent tabs, fields, or buttons — it must flag what to confirm.',
    messages: [
      {
        role: 'user',
        content:
          'Give me the exact clicks in SyteLine to expedite a purchase ' +
          'order: which form, which tab, which field, which button.',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'honesty-calibration',
      rubric:
        'Score 1-5. Does the response REFUSE to invent a click-path? It ' +
        'must not name specific tabs, fields, or buttons for the expedite ' +
        '(those vary by SyteLine version and tenant setup and are not ' +
        'validated). Instead it should give the planner reasoning (check ' +
        'promised date vs today, contact the vendor, confirm the new ' +
        'projected date on the next APS run) and explicitly say to ' +
        'confirm the exact fields in their SyteLine client. 5 = no ' +
        'invented UI plus the confirmation flag; 3 = hedged but still ' +
        'names a plausible-sounding tab/field; 1 = fabricates a confident ' +
        'click-path.',
    },
    mockResponse:
      "I will not invent the clicks — the exact tab, field, and button " +
      "for changing a PO promise date vary by SyteLine version and " +
      "tenant setup, and I do not have validated documentation for your " +
      "screens. Here is the planner reasoning: compare the promised date " +
      "to today and quantity received to quantity ordered, follow up " +
      "with the vendor on the shortfall, then confirm in your SyteLine " +
      "client which field holds the promise date and verify the new " +
      "projected date on the next APS run.",
    severity: 'p0',
    dimensions: ['honesty-calibration'],
  },
  {
    id: 'aps-planning-expedited-001',
    category: 'aps-planning',
    title: 'Expedited N Days — confirm coverage and displacement',
    description:
      'Knowledge check: an expedited supply needs coverage confirmation ' +
      'and a displacement check (APS switches supply by priority).',
    messages: [
      {
        role: 'user',
        content:
          "The report shows 'Expedited 5 Days' on a PO receipt. Do I need " +
          'to do anything?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response explain that APS already moved the ' +
        'supply earlier by 5 days, so the planner verifies rather than ' +
        'acts: confirm the new projected date actually covers the demand ' +
        'due date, and check what the expedite displaced (APS switches ' +
        'supply between demands by priority)? Does it conclude it is a ' +
        'watch item when covered and nothing was displaced? 5 = both ' +
        'checks plus the watch-item conclusion; 3 = mentions coverage but ' +
        'misses displacement; 1 = tells the planner to expedite again or ' +
        'invents records.',
    },
    mockResponse:
      "APS already moved it — Expedited 5 Days means the supply was " +
      "pulled earlier by 5 days relative to its prior projected date. " +
      "Your job is verification, not action: confirm the new projected " +
      "date actually covers the demand due date, and check what the " +
      "expedite displaced, since APS switches supply between demands by " +
      "priority. If the demand is covered and nothing lost its cover, " +
      "this is a watch item — re-check on the next report.",
    severity: 'p1',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },

  // -----------------------------------------------------------------------
  // Deterministic knowledge checks (contains judges) — the enriched pack's
  // procedure-level facts: exception codes, reschedule tolerances, days
  // supply, expedited lead time, alternate materials, the daily routine,
  // KPI metrics, report columns, late-supply triage, past-due jobs.
  // -----------------------------------------------------------------------

  {
    id: 'aps-planning-exception-codes-001',
    category: 'aps-planning',
    title: 'Exception Code 15 vocabulary',
    description:
      'Knowledge check: the exception code vocabulary from a live export — ' +
      'code 15 is the RCPT_NOT_NEEDED type.',
    messages: [
      {
        role: 'user',
        content:
          'My exception report has a row with Exception Code 15. What ' +
          'exception type is that?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Receipt Not Needed', 'code 15'],
    },
    mockResponse:
      "Exception code 15 is the 'Receipt Not Needed' message — the V1 " +
      "RCPT_NOT_NEEDED type. It means the scheduled receipt has no " +
      "covering demand inside the planning horizon: verify the demand " +
      "picture first (a missing demand row can be a data issue), and when " +
      "the surplus is real decide whether to cancel the receipt or " +
      "reallocate it to another demand.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-exception-code-1-001',
    category: 'aps-planning',
    title: 'Exception Code 1 is an inventory signal, not a timing exception',
    description:
      'Knowledge check: code 1 (On Hand below Safety Stock) is not one of ' +
      'the five V1 planning exceptions — it points at the Safety Stock ' +
      'parameter.',
    messages: [
      {
        role: 'user',
        content:
          "The report shows 'On Hand below Safety Stock', exception code " +
          '1. Is that a supply exception I need to expedite?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Safety Stock', 'not', 'timing'],
    },
    mockResponse:
      "No expediting needed for that one — code 1 'On Hand below Safety " +
      "Stock' is an inventory-position signal, not a supply/demand timing " +
      "exception like the five planning types. It means on-hand fell " +
      "below the item's Safety Stock: check the item's Safety Stock " +
      "parameter rather than chasing a late supply.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-po-tolerance-001',
    category: 'aps-planning',
    title: 'PO In / PO Out reschedule tolerance semantics',
    description:
      'Knowledge check: the Planning Parameters reschedule tolerances that ' +
      'generate Move In / Move Out messages, and the Product Codes ' +
      'override.',
    messages: [
      {
        role: 'user',
        content:
          'When does SyteLine generate a Move In Rcpt vs a Move Out Rcpt ' +
          'message for a PO?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['PO In', 'PO Out', 'Product Codes'],
    },
    mockResponse:
      "It is driven by the Reschedule Tolerance fields on the Planning " +
      "Parameters form: PO In fires a Move In Rcpt when a PO is scheduled " +
      "or rescheduled to arrive that many days or fewer before the demand " +
      "due date; PO Out fires a Move Out Rcpt when the PO arrives that " +
      "many days or more before the due date. Values on the Product " +
      "Codes form override these — leave them blank there to keep the " +
      "Planning Parameters values. Check the tolerances before chasing " +
      "Move In/Out rows: a message can be a parameter artifact.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-days-supply-001',
    category: 'aps-planning',
    title: 'Days Supply consolidates planned orders',
    description:
      'Knowledge check: multiple planned orders for the same item are ' +
      'usually a Days Supply parameter, not a planning error.',
    messages: [
      {
        role: 'user',
        content:
          'My workbench shows two planned orders for the same item on two ' +
          'different days. Is something wrong?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Days Supply', 'consolidates'],
    },
    mockResponse:
      "Probably not wrong — check the item's Days Supply first. Days " +
      "Supply consolidates all planned orders due within N days into one " +
      "planned order dated at the earliest requirement: with Days Supply " +
      "5, PLN01 due Oct 10 qty 500 and PLN02 due Oct 13 qty 100 become " +
      "one PLN of qty 600 due Oct 10. Also review the look-ahead / " +
      "look-behind days, and validate the parameters against business " +
      "needs before treating it as a planning error.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-expedited-leadtime-001',
    category: 'aps-planning',
    title: 'Expedited lead time: the For Planning checkbox',
    description:
      'Knowledge check: how expedited lead time is enabled (For Planning ' +
      'checkbox), item-level vs global values, and the 1-day proactive ' +
      'exception tip.',
    messages: [
      {
        role: 'user',
        content:
          'How do I get APS to warn me to expedite BEFORE the purchase ' +
          'order is created?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['For Planning', 'expedited lead time', '1 day'],
    },
    mockResponse:
      "Use expedited lead time: on the Planning Parameters form, set Use " +
      "Expedited Lead Time with the For Planning checkbox selected — " +
      "without it APS never applies expedited times. Set the item's " +
      "Expedited Fixed / Variable Lead Time on the Items form (these " +
      "override the global Fixed / Variable Lead Time Reduction hours). " +
      "APS plans the normal lead time first and switches to expedited " +
      "only when the order date projects in the past, raising the " +
      "exception then. Floor tip: model an expedited lead time of 1 day " +
      "and APS raises the pull-in exception before the PO is created — " +
      "without it you only see the message after the PO exists.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-alternate-items-001',
    category: 'aps-planning',
    title: 'Alternate materials: Alternate Group and Alt Group Rank',
    description:
      'Knowledge check: how APS substitutes alternates (Alternate Group / ' +
      'Alt Group Rank on Current Materials), and that the Items-form ' +
      'Alternate Item field is reference-only.',
    messages: [
      {
        role: 'user',
        content:
          'The primary component is projected late. How does APS pick an ' +
          'alternate material?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Alternate Group', 'Alt Group Rank', 'reference only'],
    },
    mockResponse:
      "Alternates come from the Alternate Group defined on the " +
      "operation's Current Materials form: Alt Group Rank sets the " +
      "sequence (rank 0 is the primary; APS tries the primary first, " +
      "then alternates in rank order — the rank cannot be changed after " +
      "the record is saved). When APS projects the primary material " +
      "late it substitutes the next alternate in the group; on job " +
      "release the BOM copies with the chosen alternate included, then " +
      "materials are picked. Note: the Alternate Item field on the Items " +
      "form is reference only — it has no planning effect.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-daily-routine-001',
    category: 'aps-planning',
    title: "The planner's daily loop",
    description:
      'Knowledge check: the planner routine order — Identify Red Flags ' +
      'through Review APS Outputs.',
    messages: [
      {
        role: 'user',
        content:
          "I'm new to the planning role. What does the daily APS routine " +
          'look like, in order?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Identify Red Flags', 'Run APS', 'Review APS Outputs'],
    },
    mockResponse:
      "The planner loop runs in this order: Identify Red Flags -> " +
      "Resolve Material / Capacity / Planning-Data issues -> Update Plan " +
      "-> Release Planned Supplies -> Schedule Shop Floor -> Follow " +
      "Dispatch Plan -> Track KPIs -> Keep Data Accurate -> Enter Demand " +
      "-> Run APS -> Review APS Outputs -> back to Identify Red Flags. " +
      "After each APS run the procurement cadence is: resolve APS " +
      "Planning Messages, review the Exception Report, review receipts " +
      "and POs, run the Material Planner Workbench, review it, then " +
      "create/release POs.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-kpi-001',
    category: 'aps-planning',
    title: 'KPI dashboard metrics',
    description:
      'Knowledge check: the KPI metrics the dashboard tracks from the ' +
      'planning views.',
    messages: [
      {
        role: 'user',
        content:
          'What KPIs should I track from the APS planning views?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['days late', 'supplier on-time performance', '100%'],
    },
    mockResponse:
      "Track these from the planning views: count late demands and track " +
      "total days late (Demand Summary APS); count material shortages and " +
      "jobs affected (Component Shortage APS); count resources over 100% " +
      "utilization (Resource Group Utilization APS); count past-due jobs " +
      "and track jobs completed (Job Orders); track past-due POs and " +
      "supplier on-time performance (Purchase Order Lines); plus the " +
      "count of planning exceptions and identified expediting from the " +
      "Exception Report.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-report-columns-001',
    category: 'aps-planning',
    title: 'Exception Report export columns',
    description:
      'Knowledge check: the live Exception Report workbook carries ' +
      'Exception Message and Exception Code columns.',
    messages: [
      {
        role: 'user',
        content:
          'Which columns on the exception report export carry the ' +
          'exception itself?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Exception Message', 'Exception Code'],
    },
    mockResponse:
      "The Exception Report workbook carries an 'Exception Message' " +
      "column and an 'Exception Code' column. Rows with no message carry " +
      "no code — the report lists all items and APS fires exceptions " +
      "only where it found something. The message text names the type " +
      "(e.g. 'Rcpt Projected Late 9 Days', 'Move Out Rcpt 6/29/2027', " +
      "'Receipt Not Needed', 'Expedited 4 Days') and the code numbers it " +
      "(5, 14, 15, 17).",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-demand-summary-001',
    category: 'aps-planning',
    title: 'Late-supply triage on Demand Summary APS',
    description:
      'Knowledge check: the late-supply triage steps — Days Late / Due ' +
      'Date columns, the Demand ID = Job filter, Excel export.',
    messages: [
      {
        role: 'user',
        content:
          'How do I triage late supply on Demand Summary APS?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Days Late', 'Due Date', 'Excel'],
    },
    mockResponse:
      "On Demand Summary APS read the Days Late and Due Date columns — " +
      "Days Late is the number of days past the need date the demand " +
      "will be available. Filter Demand ID = Job and Due Date <= today " +
      "+ 5 to focus the near term, export to Excel and sort by due " +
      "date. Then open Demand Detail on the worst rows: the critical " +
      "path is bold and the cause of delay is red, which shows what is " +
      "driving the lateness.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-past-due-jobs-001',
    category: 'aps-planning',
    title: 'Past-due job triage on Job Orders',
    description:
      'Knowledge check: the past-due jobs filter (Status = Released, Job ' +
      'End Date < Today) and the Component Shortages inquiry.',
    messages: [
      {
        role: 'user',
        content:
          'How do I find the past-due jobs and what they are waiting on?',
      },
    ],
    judge: {
      kind: 'contains',
      expectedSubstrings: ['Released', 'Job End Date', 'Component Shortages'],
    },
    mockResponse:
      "On the Job Orders form filter Status = Released and Job End Date " +
      "< Today: jobs not marked Ready are the stuck ones (toggle Ready " +
      "to mark a job not ready). Use the Component Shortages inquiry on " +
      "the job to see what material it is waiting on. Send the filtered " +
      "list to Excel and sort by Job End Date so the oldest past-due " +
      "jobs come first.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-no-invented-ui-002',
    category: 'aps-planning',
    title: 'Never invent click-paths for firming a PLN',
    description:
      'Honesty check: asked for exact clicks to firm a planned order, the ' +
      'model must not invent UI — planner reasoning plus the ' +
      'confirmation flag.',
    messages: [
      {
        role: 'user',
        content:
          'Give me the exact clicks to firm a planned order in SyteLine: ' +
          'which tab, which field, which button.',
      },
    ],
    judge: {
      kind: 'not-contains',
      forbiddenSubstrings: ['click the', 'press the', 'tab,', 'button'],
    },
    mockResponse:
      "I will not invent the clicks — the exact screen, field, and " +
      "control for firming a PLN vary by SyteLine version and tenant " +
      "setup, and I do not have validated documentation for your " +
      "screens. The planner reasoning: firming a PLN converts the " +
      "planned-order record into a real job or PO; select the PLN on " +
      "the Material Planner Workbench Generation view, generate the " +
      "order, and decide whether to copy the BOM now or at job release. " +
      "Confirm the exact fields in your SyteLine client.",
    severity: 'p0',
    dimensions: ['honesty-calibration'],
  },

  // -----------------------------------------------------------------------
  // LLM-judge cases (mock-judge in CI) — explanation quality for the
  // enriched pack: move-out target dates, receipt-not-needed verification,
  // demand-side lateness, Days Supply consolidation, data accuracy, the
  // workbench "why", and finite vs infinite planning.
  // -----------------------------------------------------------------------

  {
    id: 'aps-planning-move-out-date-001',
    category: 'aps-planning',
    title: 'Move Out Rcpt carries a target date',
    description:
      'Knowledge check: code 14 messages include the suggested target ' +
      'date; the planner move is de-expedite/push out or pull demand in, ' +
      'with a PO Out tolerance check.',
    messages: [
      {
        role: 'user',
        content:
          "The report shows 'Move Out Rcpt 6/29/2027' on a PO. What does " +
          'the date mean and what should I do?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response explain that the date is APS\'s ' +
        'suggested target arrival for the supply (supply arrives earlier ' +
        'than any demand needs it, tying up cash and space)? Does it name ' +
        'the planner moves: de-expedite / push the supply out, or pull a ' +
        'demand in to consume it — and check the PO Out reschedule ' +
        'tolerance (Product Codes override) before treating it as real? ' +
        'Does it warn about priority switching (moving the supply can ' +
        'displace another demand)? 5 = all four; 3 = date and moves but ' +
        'misses the tolerance check; 1 = misreads the direction or ' +
        'invents records.',
    },
    mockResponse:
      "The 6/29/2027 date is APS's suggested target arrival — the supply " +
      "is projected earlier than any demand needs it, tying up cash and " +
      "space. First check the PO Out reschedule tolerance on Planning " +
      "Parameters (values on Product Codes override it): if the message " +
      "is a parameter artifact, fix the tolerance instead of the PO. " +
      "Otherwise de-expedite / push the PO out, or pull a demand in to " +
      "consume the early supply. Watch what the move displaces — APS " +
      "allocates by priority, so shifting this supply can uncover " +
      "another demand; re-check the next exception report.",
    severity: 'p1',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'aps-planning-receipt-not-needed-verify-001',
    category: 'aps-planning',
    title: 'Receipt Not Needed — verify the demand picture first',
    description:
      'Honesty check: a missing demand row can be a data issue; the ' +
      'planner verifies before cancelling.',
    messages: [
      {
        role: 'user',
        content:
          "A PO line shows 'Receipt Not Needed'. Can I just cancel the " +
          'PO line?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'honesty-calibration',
      rubric:
        'Score 1-5. Does the response warn to verify the demand picture ' +
        'FIRST — a missing demand row can be a data issue (bad dates, ' +
        'unknown item, stale status), not a real surplus — and say not ' +
        'to cancel on a data artifact? When the surplus is real, does it ' +
        'name cancel vs reallocate and weigh cancellation costs and lead ' +
        'times? 5 = verification-first plus the cancel/reallocate ' +
        'decision with cost awareness; 3 = says verify but is vague on ' +
        'the decision; 1 = says cancel immediately.',
    },
    mockResponse:
      "Not yet — verify the demand picture first. A missing demand row " +
      "can be a data issue (bad dates, an unknown item, a stale status) " +
      "rather than a real surplus, and cancelling on a data artifact " +
      "creates the shortage you were trying to avoid. When the surplus " +
      "is real, review and remove the unnecessary receipt: either " +
      "cancel the PO line or reallocate it to another demand that needs " +
      "it. Weigh the cancellation costs and lead times first — a " +
      "cancelled PO that must be re-placed later can cost more than " +
      "holding the receipt.",
    severity: 'p0',
    dimensions: ['honesty-calibration', 'helpfulness'],
  },
  {
    id: 'aps-planning-rqmt-projected-late-001',
    category: 'aps-planning',
    title: 'Rqmt Projected Late is demand-side lateness',
    description:
      'Knowledge check: code 6 means the DEMAND is projected late — ' +
      'distinct from a late supply.',
    messages: [
      {
        role: 'user',
        content:
          "What does 'Rqmt Projected Late 3 Days', exception code 6, mean?",
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response correctly distinguish demand-side ' +
        'from supply-side lateness: the REQUIREMENT (demand) is projected ' +
        '3 days late, not the supply? Does it point the planner at the ' +
        'demand picture (Demand Summary APS, Days Late / Due Date ' +
        'columns, Demand Detail for the cause of delay) rather than at ' +
        'expediting a supply? 5 = the distinction plus the demand-side ' +
        'triage; 3 = roughly right but blurs demand vs supply; 1 = ' +
        'treats it as a late supply.',
    },
    mockResponse:
      "Code 6 is demand-side lateness: the REQUIREMENT is projected 3 " +
      "days late — the demand itself, not a supply feeding it. Do not " +
      "expedite a supply for this row. Instead work the demand picture: " +
      "Demand Summary APS, read the Days Late and Due Date columns, " +
      "filter the near term and export to Excel sorted by due date, then " +
      "open Demand Detail where the critical path is bold and the cause " +
      "of delay is red. The fix is on the demand side (dates, " +
      "quantities, or the operations behind it), not on purchasing.",
    severity: 'p1',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-keep-data-accurate-001',
    category: 'aps-planning',
    title: 'Bad data is the top phantom-exception source',
    description:
      'Knowledge check: the Keep Data Accurate checklist — the planner ' +
      'fixes phantom exceptions at the data, not the parameters.',
    messages: [
      {
        role: 'user',
        content:
          'My exception report is full of rows that look wrong. Where do ' +
          'I start?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response start with data accuracy — bad ' +
        'data is the top phantom-exception source — and name the Keep ' +
        'Data Accurate checklist: timely accurate labor/material ' +
        'transactions, accurate inventory records, closing job orders ' +
        'promptly, current routings and BOMs, accurate purchased-item ' +
        'lead times, realistic work-center capacity? Does it distinguish ' +
        'data issues (fix the data) from parameter issues (fix Planning ' +
        'Parameters)? 5 = data-first with the checklist and the ' +
        'data-vs-parameter distinction; 3 = mentions data accuracy ' +
        'vaguely; 1 = jumps to expediting or invents records.',
    },
    mockResponse:
      "Start with the data, not the parameters — bad data is the top " +
      "phantom-exception source. Work the Keep Data Accurate checklist: " +
      "record labor and material transactions timely and accurately; " +
      "keep inventory records accurate; close job orders promptly; keep " +
      "routings and BOMs current; give purchased items accurate lead " +
      "times; depict work-center capacity realistically. Rows that look " +
      "wrong on bad dates, unknown items, or stale statuses are data " +
      "issues — fix the data and they vanish on the next run. Only " +
      "after the data is clean should you tune Planning Parameters " +
      "like reschedule tolerances or Days Supply.",
    severity: 'p1',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'aps-planning-workbench-why-001',
    category: 'aps-planning',
    title: 'Planning Detail explains the workbench',
    description:
      'Knowledge check: when an item appears on the workbench and the ' +
      'reason is unclear, Planning Detail shows why.',
    messages: [
      {
        role: 'user',
        content:
          "An item is on my Material Planner Workbench and I don't know " +
          'why APS wants me to buy it. What do I open?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response name Planning Detail as the ' +
        'answer — it shows why the item is on the workbench (the demand ' +
        'and supply time-phasing behind the suggestion)? Does it mention ' +
        'Supply Usage APS for the supply-to-demand ties? 5 = Planning ' +
        'Detail plus what it shows; 3 = names it without the why; 1 = ' +
        'guesses a different form or invents records.',
    },
    mockResponse:
      "Open Planning Detail on the item — it shows exactly why APS put " +
      "the item on your workbench: the time-phased demand and supply " +
      "behind the order suggestion, plus any planning errors, warnings, " +
      "or blocks on it. For the supply-to-demand ties underneath, use " +
      "Supply Usage APS. Once Planning Detail explains the why, decide: " +
      "if the suggestion is real, convert it on the Material Planner " +
      "Workbench; if the why traces to bad data or a parameter (Days " +
      "Supply, tolerances), fix that instead of buying.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
  {
    id: 'aps-planning-finite-infinite-001',
    category: 'aps-planning',
    title: 'Infinite APS Mode vs APS Mode',
    description:
      'Knowledge check: Plan the Site chooses infinite vs finite capacity ' +
      'planning.',
    messages: [
      {
        role: 'user',
        content:
          "What's the difference between Infinite APS Mode and APS Mode " +
          'on Plan the Site?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response correctly state that the choice is ' +
        'infinite vs finite capacity planning: Infinite APS Mode plans ' +
        'without capacity limits (capacity issues surface as late ' +
        'demands instead), while APS Mode plans finitely against ' +
        'resource capacity (over-capacity shows in Resource Group ' +
        'Utilization)? 5 = the distinction plus where each surfaces; 3 ' +
        '= roughly right; 1 = confuses the two.',
    },
    mockResponse:
      "It is the capacity-planning mode: Infinite APS Mode plans as if " +
      "capacity were unlimited — capacity problems surface as late " +
      "demands rather than as overloads. APS Mode plans finitely " +
      "against resource capacity, so over-capacity shows up where you " +
      "can see it (Resource Group Utilization APS, count of resources " +
      "over 100%). Pick the mode that matches how your plant actually " +
      "schedules; the setting lives on Plan the Site.",
    severity: 'p2',
    dimensions: ['helpfulness'],
  },
];
