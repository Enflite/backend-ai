import type { EvalCase } from '../types.js';

// ---------------------------------------------------------------------------
// SyteLine domain-knowledge cases — pure knowledge Q&A, no tools required.
//
// These cases test that the model answers SyteLine product questions like a
// veteran practitioner (data model, status lifecycle, workflows, diagnostic
// heuristics), drawing on the domain-expertise knowledge pack injected on
// SyteLine turns (backend/src/chat/sytelineExpertKnowledge.ts). Scoring is
// via the llm-judge harness: each case carries a rubric describing a 5/3/1
// answer, and each mockResponse is written to pass its own rubric (scripted
// CI runs replay mockResponse through the judge).
//
// Category is 'syteline' so these roll up with the diagnostic cases in
// reporting; they exercise helpfulness + honesty-calibration rather than
// tool-competence.
// ---------------------------------------------------------------------------

export const SYTELINE_KNOWLEDGE_CASES: EvalCase[] = [
  {
    id: 'syteline-knowledge-atp-001',
    category: 'syteline',
    title: 'On-hand vs allocated vs available',
    description:
      'Knowledge check: the three quantity buckets on an item-warehouse ' +
      'record and what a negative available quantity means.',
    messages: [
      {
        role: 'user',
        content:
          "In SyteLine, what's the difference between on-hand, allocated, " +
          'and available quantity for an item?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response correctly distinguish the three ' +
        'buckets: on-hand is physical quantity, allocated is reserved by ' +
        'open demand (order lines, job materials), available = on-hand ' +
        'minus allocated? Does it state that available CAN go negative ' +
        'and read it by cause: with non-negative on-hand, negative ' +
        'available means allocated demand exceeds physical supply (the ' +
        'diagnostic signal — report honestly, never clamp); with ' +
        'negative on-hand and little allocation, the negative comes ' +
        'from on-hand itself (the Neg Flag / serialized rules)? ' +
        '5 = all three defined precisely plus the by-cause reading; ' +
        '3 = roughly right but vague on the formula or silent on the ' +
        'on-hand-negative case; 1 = conflates the buckets or invents a ' +
        'different formula.',
    },
    mockResponse:
      'Three different buckets on the item-warehouse record. On-hand is ' +
      'physical quantity in the warehouse. Allocated is quantity already ' +
      'reserved by open demand — customer order lines and job material ' +
      'requirements. Available (ATP) = on-hand minus allocated, i.e. what ' +
      'you can still promise. And yes, available can go negative — read ' +
      'it by cause. With non-negative on-hand, negative available means ' +
      'allocated demand exceeds physical supply: that is the signal, not ' +
      'a bug — never clamp it, investigate what is consuming it. With ' +
      'negative on-hand and little or no allocation, the negative comes ' +
      'from on-hand itself (check the On Hand Neg Flag; serialized items ' +
      'are the red-flag case).',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-negative-002',
    category: 'syteline',
    title: 'Negative available quantity: bug or feature',
    description:
      'Knowledge check: negative AVAILABLE (allocated exceeding on-hand) ' +
      'is a planning signal distinct from negative ON-HAND; the On Hand ' +
      'Neg Flag and serialized rule govern on-hand, not available.',
    messages: [
      {
        role: 'user',
        content:
          'An item is showing negative available quantity, but its on-hand ' +
          'is still positive. Is our inventory data corrupt?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response keep negative AVAILABLE separate ' +
        'from negative ON-HAND: available = on-hand minus allocated, so ' +
        'available goes negative when allocated demand exceeds on-hand ' +
        'even with positive on-hand? Does it explain that negative ' +
        'available is a planning signal (demand over-promised against ' +
        'supply), not corruption, and point at what is allocated (open ' +
        'customer-order lines, job material requirements)? Does it note ' +
        'that the On Hand Neg Flag and the serialized-inventory rule ' +
        'govern on-hand quantity, and only become relevant if on-hand ' +
        'itself goes negative? 5 = all of the above with the two ' +
        'quantities cleanly separated; 3 = explains available correctly ' +
        'but conflates the Neg Flag; 1 = declares it corruption or ' +
        'treats negative available as a data-integrity red flag.',
    },
    mockResponse:
      'No — and the distinction matters. Available = on-hand minus ' +
      'allocated, so available goes negative whenever allocated demand ' +
      'exceeds on-hand, even with positive on-hand. That is a planning ' +
      'signal, not corruption: you have promised (or reserved for jobs) ' +
      'more than you physically hold. Look at what is allocated — open ' +
      'customer-order lines and job material requirements — and work the ' +
      'supply side (expedite POs, firm planned orders) or the demand ' +
      'side. The On Hand Neg Flag and the "serialized inventory cannot ' +
      'go negative" rule govern on-hand quantity, not available; they ' +
      'only become relevant if on-hand itself goes negative.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-firm-003',
    category: 'syteline',
    title: 'Firm planned order vs released job',
    description:
      'Knowledge check: PLN is a planned-order record (not a job status); ' +
      'firming converts it into a job, releasing authorizes shop-floor ' +
      'execution, close is explicit.',
    messages: [
      {
        role: 'user',
        content:
          'What is the difference between a firm planned order and a ' +
          'released job in SyteLine?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response distinguish PLN planned orders ' +
        '(records created by MRP/APS planning) from jobs, whose standard ' +
        'statuses are Firm -> Released -> Complete -> History (with ' +
        'Stopped available to halt a job)? Does it explain that firming a ' +
        'PLN planned order converts it into a real job or PO, that ' +
        'Released authorizes shop-floor execution (material issues, labor ' +
        'reporting), and that close is explicit — set Status to Complete ' +
        'or complete via a job transaction — never a side effect of ' +
        'receiving everything? Does it avoid listing "Scheduled" as a job ' +
        'status? 5 = full lifecycle correct with the firm/release ' +
        'distinction precise; 3 = roughly right but muddles firm vs ' +
        'release or omits Stopped; 1 = calls PLN a job status, lists ' +
        'Scheduled as a job status, or claims jobs close themselves.',
    },
    mockResponse:
      'Different records, different steps. A PLN planned order is a ' +
      'planning record created by MRP or APS — a suggestion, not a job. ' +
      'The planner FIRMS it, converting it into a real job or PO. Jobs ' +
      'then move through their own statuses: Firm (the default for a new ' +
      'job) -> Released -> Complete -> History, with Stopped available ' +
      'to halt a job. Releasing authorizes shop-floor execution — ' +
      'material issues, labor reporting. And close is explicit: set ' +
      'Status to Complete on the Job Orders form, or complete the job ' +
      'through a job transaction. A job never closes itself as a side ' +
      'effect of receiving everything into stock.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-backflush-004',
    category: 'syteline',
    title: 'Backflushing mechanics',
    description:
      'Knowledge check: what backflushing is, when it fires, where the ' +
      'default lives, and the audit trail.',
    messages: [
      { role: 'user', content: 'What is backflushing in SyteLine?' },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response define backflushing as the automatic ' +
        'issuing of job materials when an operation or job is completed, ' +
        'based on completed quantity? Does it state the default is set at ' +
        'the item level and can be overridden per Job Materials record ' +
        '(backflush / bflush_loc fields)? Does it name matltran as the ' +
        'audit trail for every material transaction? 5 = all three; ' +
        '3 = definition right but misses the override level or the audit ' +
        'trail; 1 = wrong definition (e.g. confuses with lot tracking) or ' +
        'invented fields.',
    },
    mockResponse:
      'Backflushing is automatic material issuing: when you complete an ' +
      'operation or a job, SyteLine issues the operation\'s materials for ' +
      'you based on the completed quantity, instead of someone manually ' +
      'issuing each component. The default is set at the item level, and ' +
      'you can override it per material on the Job Materials record ' +
      '(the backflush flag and bflush_loc fields). Every backflush posts ' +
      'a material transaction, so matltran is the audit trail if the ' +
      'numbers ever look wrong — over-reported completions are the ' +
      'classic cause of backflush-driven inventory surprises.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-dates-005',
    category: 'syteline',
    title: 'Promise date vs due date on order lines',
    description:
      'Knowledge check: due_date, promise_date, release_date are distinct ' +
      'fields with distinct meanings; blank promise falls back to due.',
    messages: [
      {
        role: 'user',
        content:
          'A customer order line shows a due date of Monday and a promise ' +
          'date of Friday. Which date did we commit to the customer?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response state that due_date, promise_date, ' +
        'and release_date are three distinct fields on the order line and ' +
        'must not be conflated? Does it identify promise_date as the ' +
        'customer commitment (Friday) and note that when promise date is ' +
        'blank, due date is used? 5 = precise field-level answer with the ' +
        'fallback rule; 3 = picks promise date but vague on fields; ' +
        '1 = picks the wrong date or invents semantics.',
    },
    mockResponse:
      'Friday — the promise date. On a SyteLine order line, due_date, ' +
      'promise_date, and release_date are three separate fields; the ' +
      'promise date is the commitment to the customer. (If promise date ' +
      'is blank, SyteLine falls back to the due date — but here it is ' +
      'populated, so Friday is the committed date.) If the line cannot ' +
      'make Friday, that is a promise-date problem to work with planning, ' +
      'not a due-date technicality.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-credit-006',
    category: 'syteline',
    title: 'Line saved as Planned instead of Ordered',
    description:
      'Knowledge check: the credit-check behavior on Planned -> Ordered ' +
      'transition and its financial consequences.',
    messages: [
      {
        role: 'user',
        content:
          'I entered a customer order line as Ordered but SyteLine saved ' +
          'it as Planned. Why?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response explain that switching a line to ' +
        'Ordered fires the credit check, and exceeding the credit limit ' +
        'saves the line as Planned instead? Does it explain the ' +
        'consequence (Planned does not update the customer\'s On Order ' +
        'Balance) and the multi-site nuance (the originating site controls ' +
        'the order\'s credit-hold status)? 5 = mechanism plus consequence ' +
        'plus the multi-site note; 3 = credit check identified but ' +
        'consequences vague; 1 = invents a different cause.',
    },
    mockResponse:
      'That is the credit check doing its job. Moving a line from ' +
      'Planned to Ordered fires the credit check, and when the customer ' +
      'is over their limit SyteLine saves the line as Planned instead of ' +
      'Ordered. It matters financially: Planned lines do not update the ' +
      'customer\'s On Order Balance, and an order stuck in Planned never ' +
      'ships. Check the customer\'s credit status — and in multi-site, ' +
      'remember the originating site controls the order\'s credit-hold ' +
      'status, so look there first.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-jobclose-007',
    category: 'syteline',
    title: 'Job still open after completion',
    description:
      'Knowledge check: close is an explicit act (status change or job ' +
      'transaction); finishing work does not close a job by itself.',
    messages: [
      {
        role: 'user',
        content:
          'We finished all the work on job 1042 and received everything ' +
          'into stock, but the job still shows as open. How do I close it?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response state plainly that close is an ' +
        'explicit act — set the job Status to Complete on the Job Orders ' +
        'form, or complete the job through a job transaction — and that ' +
        'finishing the work does not close the job by itself? Does it ' +
        'mention that old completed jobs move to History status (year-end ' +
        'purge candidates)? 5 = both, stated directly; 3 = explicit close ' +
        'mentioned but History omitted; 1 = suggests the system closes ' +
        'the job automatically on receipt or invents a close wizard.',
    },
    mockResponse:
      'Nothing is stuck — a SyteLine job does not close itself when the ' +
      'work is done. Close is an explicit act: open the job on the Job ' +
      'Orders form and set its Status to Complete (or complete the job ' +
      'through a job transaction). That is the close. Completed jobs ' +
      'accumulate until the year-end utilities move them to History ' +
      'status, which is the purge candidate — so "open but finished" is ' +
      'the normal state for a job nobody has explicitly completed yet.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
  {
    id: 'syteline-knowledge-mrp-aps-008',
    category: 'syteline',
    title: 'MRP vs APS planning',
    description:
      'Knowledge check: the practical difference between MRP and APS in ' +
      'SyteLine planning.',
    messages: [
      {
        role: 'user',
        content: 'Should we be planning with MRP or APS in SyteLine?',
      },
    ],
    judge: {
      kind: 'llm-judge',
      dimension: 'helpfulness',
      rubric:
        'Score 1-5. Does the response explain MRP as net-requirements ' +
        'planning (independent demand -> net against on-hand and scheduled ' +
        'receipts -> planned orders -> BOM explosion into dependent ' +
        'demand, planner firms PLN orders) and APS as priority-based ' +
        'allocation of on-hand and planned supply to demands (with a ' +
        'supply-usage tolerance, Move In/Move Out exception messages, and ' +
        'APS-controlled PLN projected dates that may change)? Does it give ' +
        'a practical framing (APS when you need prioritized allocation ' +
        'across competing demands; MRP when straight net-requirements ' +
        'planning suffices) without pretending the choice is one-size? ' +
        '5 = both mechanisms precise plus practical framing; 3 = roughly ' +
        'right but thin on the APS allocation behavior; 1 = conflates them ' +
        'or invents planning modes.',
    },
    mockResponse:
      'Depends on what your planning problem is. MRP is net-requirements ' +
      'planning: take independent demand (forecasts, customer orders), ' +
      'net it against on-hand and scheduled receipts, create planned ' +
      'orders for the net requirements, and explode those through the BOM ' +
      'into dependent component demand. The planner then firms PLN orders ' +
      'into jobs or POs, guided by the Order Action Report. APS does all ' +
      'of that and additionally allocates on-hand and planned supply to ' +
      'demands by priority, with a supply-usage tolerance — it will switch ' +
      'supply between demands and tell you via Move In/Move Out exception ' +
      'messages. Note APS controls PLN projected dates; they can move and ' +
      'are not user-editable like firm dates. Rule of thumb: APS when ' +
      'you have competing demands fighting over the same supply and need ' +
      'priority-based allocation; MRP when straightforward ' +
      'net-requirements planning is enough. Either way, put the Net ' +
      'Change flag on stable items to keep replanning scope sane.',
    severity: 'p2',
    dimensions: ['helpfulness', 'honesty-calibration'],
  },
];
