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
];
