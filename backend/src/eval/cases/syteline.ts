import type { EvalCase, EvalToolDef } from '../types.js';

// ---------------------------------------------------------------------------
// SyteLine diagnostic cases — agentic multi-step investigative reasoning.
//
// Canonical product target: docs/syteline-vision.md ("why is this order
// late?"). The assistant plans an investigation in a line or two, chains
// dependent queries across entities (order -> order lines -> inventory ->
// open POs -> work orders -> BOM components), and synthesizes a diagnosis
// grounded in the actual records returned.
//
// Scoring is via the `tool-chain` judge: the expected tool sequence must
// appear in order, the synthesis must cite the real record IDs, and it must
// not invent records or narrate policy.
//
// The tool names here are the Phase 5 canonical surface
// (backend/src/tools/gateway.ts): syteline.getSalesOrder,
// syteline.getItemAvailability, syteline.getOpenPurchaseOrders,
// syteline.getWorkOrders, syteline.getBom, syteline.getCustomer (plus the
// pre-existing syteline.getItem). Every record ID cited by the mock
// responses exists in backend/src/tools/sytelineFixture.ts with the exact
// numbers asserted here; backend/test/sytelineFixture.test.ts replays each
// case's expected tool chain against the fixture and fails on any cited
// record that is missing or contradictory — the deterministic "zero
// invented records" check.
// ---------------------------------------------------------------------------

const SYTELINE_GET_SALES_ORDER: EvalToolDef = {
  name: 'syteline.getSalesOrder',
  description: 'Look up a SyteLine sales order header plus order lines by order number, or list open orders for a customer.',
  parameters: {
    type: 'object',
    properties: {
      orderNumber: { type: 'string' },
      customerNumber: { type: 'string' },
      site: { type: 'string' },
      status: { type: 'string', enum: ['open', 'closed', 'all'] },
    },
  },
};

const SYTELINE_GET_ITEM_AVAILABILITY: EvalToolDef = {
  name: 'syteline.getItemAvailability',
  description: 'On-hand, allocated, and available quantities for an item at a site, plus recent inventory transactions.',
  parameters: {
    type: 'object',
    required: ['item', 'site'],
    properties: { item: { type: 'string' }, site: { type: 'string' } },
  },
};

const SYTELINE_GET_OPEN_POS: EvalToolDef = {
  name: 'syteline.getOpenPurchaseOrders',
  description: 'Open purchase orders for an item, with promised dates, receipt status, and supplier.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' }, site: { type: 'string' } },
  },
};

const SYTELINE_GET_WORK_ORDERS: EvalToolDef = {
  name: 'syteline.getWorkOrders',
  description: 'Look up work orders by work order number or by the item they build, with status and schedule dates.',
  parameters: {
    type: 'object',
    properties: {
      workOrderNumber: { type: 'string' },
      item: { type: 'string' },
      site: { type: 'string' },
      status: { type: 'string' },
    },
  },
};

const SYTELINE_GET_BOM: EvalToolDef = {
  name: 'syteline.getBom',
  description: 'Explode the bill of materials for a manufactured item into components.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' }, site: { type: 'string' }, levels: { type: 'number' } },
  },
};

const SYTELINE_GET_CUSTOMER: EvalToolDef = {
  name: 'syteline.getCustomer',
  description: 'Look up a SyteLine customer record by customer number.',
  parameters: {
    type: 'object',
    required: ['customerNumber'],
    properties: { customerNumber: { type: 'string' } },
  },
};

export const SYTELINE_DIAG_CASES: EvalCase[] = [
  {
    id: 'syteline-diag-001',
    category: 'syteline',
    title: 'Diagnose a late customer order across entities',
    description:
      'The flagship agentic case: "why is this order late?" The assistant must chain ' +
      'sales order -> item availability -> open POs, narrate its plan briefly, and ' +
      'synthesize the true root cause (late component PO) with citations to real records.',
    messages: [
      {
        role: 'user',
        content: 'Why is customer order SO-66012 late? It was due last Friday.',
      },
    ],
    tools: [
      SYTELINE_GET_SALES_ORDER,
      SYTELINE_GET_ITEM_AVAILABILITY,
      SYTELINE_GET_OPEN_POS,
    ],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getSalesOrder',
        'syteline.getItemAvailability',
        'syteline.getOpenPurchaseOrders',
      ],
      expectedSubstrings: [
        'SO-66012',
        'ITEM-77100',
        'PO-4488',
        'I\'ll check the order lines, then inventory and open POs for the short items.',
      ],
      forbiddenSubstrings: ['I\'ve expedited', 'I cancelled', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getSalesOrder', args: { orderNumber: 'SO-66012' } },
        { name: 'syteline.getItemAvailability', args: { item: 'ITEM-77100', site: 'FTW' } },
        { name: 'syteline.getOpenPurchaseOrders', args: { item: 'ITEM-77100' } },
      ],
      content:
        'I\'ll check the order lines, then inventory and open POs for the short items.\n\n' +
        'SO-66012 is late because of line 2: 500 units of ITEM-77100 were needed, but only 180 ' +
        'are available at FTW — 320 short. The covering purchase order PO-4488 (Acme Metals, ' +
        '500 units) was promised 6 days ago and still shows open, so the component never arrived. ' +
        'Every other line on the order is fully stocked. Want me to check whether PO-4488 has an ' +
        'updated promise date?',
    },
    severity: 'p0',
    dimensions: ['tool-competence', 'helpfulness', 'grounding-citations', 'tone'],
  },
  {
    id: 'syteline-diag-002',
    category: 'syteline',
    title: 'Find which components block a work order',
    description:
      'Chain work order -> BOM explosion -> item availability and identify the blocking ' +
      'component. The synthesis must name the short component and its shortage, not hedge.',
    messages: [
      {
        role: 'user',
        content: 'Which components are blocking work order WO-3301 from starting?',
      },
    ],
    tools: [SYTELINE_GET_WORK_ORDERS, SYTELINE_GET_BOM, SYTELINE_GET_ITEM_AVAILABILITY],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getWorkOrders',
        'syteline.getBom',
        'syteline.getItemAvailability',
      ],
      expectedSubstrings: ['WO-3301', 'ITEM-55410', '180 units short'],
      forbiddenSubstrings: ['all components are available', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getWorkOrders', args: { workOrderNumber: 'WO-3301' } },
        { name: 'syteline.getBom', args: { item: 'FG-9100' } },
        { name: 'syteline.getItemAvailability', args: { item: 'ITEM-55410', site: 'FTW' } },
      ],
      content:
        'I\'ll pull the work order, explode the BOM for what it builds, and check availability for the components.\n\n' +
        'WO-3301 is blocked by one component: ITEM-55410. The BOM needs 240 units and only 60 ' +
        'are available at FTW — 180 units short. There is no open PO for it, so nothing is ' +
        'inbound. The other 14 components are fully available. Fastest path is an expedite ' +
        'purchase for ITEM-55410; want the last-price and lead-time details?',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'helpfulness', 'grounding-citations'],
  },
  {
    id: 'syteline-diag-003',
    category: 'syteline',
    title: 'Explain negative inventory from transaction history',
    description:
      'A negative on-hand must be explained from the transaction trail (adjustment posted ' +
      'before receipts), not guessed at. Tests evidence-based reasoning over inventory data.',
    messages: [
      {
        role: 'user',
        content: 'Why is inventory negative on ITEM-77900 at the Fort Worth site?',
      },
    ],
    tools: [SYTELINE_GET_ITEM_AVAILABILITY, SYTELINE_GET_OPEN_POS],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getItemAvailability',
        'syteline.getOpenPurchaseOrders',
      ],
      expectedSubstrings: ['ITEM-77900', 'cycle-count adjustment', 'PO-4520'],
      forbiddenSubstrings: ['data entry error', 'someone probably', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getItemAvailability', args: { item: 'ITEM-77900', site: 'FTW' } },
        { name: 'syteline.getOpenPurchaseOrders', args: { item: 'ITEM-77900' } },
      ],
      content:
        'I\'ll look at availability and walk its recent transactions to see what drove it negative.\n\n' +
        'ITEM-77900 shows -40 at FTW because a cycle-count adjustment of -460 posted on Tuesday, ' +
        'before the week\'s receipts were booked — a 300-unit receipt against PO-4520 came in ' +
        'Wednesday, and an 80-unit issue since then left it at -40. It is a timing artifact, ' +
        'not a real shortage: PO-4520 still has 100 units open with a promise date of this ' +
        'Thursday, which brings the balance positive. If the count itself looks wrong, a ' +
        'recount is the fix — not another adjustment on top.',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'honesty-calibration', 'grounding-citations'],
  },
  {
    id: 'syteline-agg-001',
    category: 'syteline',
    title: 'Aggregate open backlog value for a customer',
    description:
      'Multi-step aggregation: customer -> open orders -> summed backlog value. The answer ' +
      'must show the computed total and the order count, in plain language, not a table dump.',
    messages: [
      {
        role: 'user',
        content: 'What is our total open backlog value for customer CONT-220?',
      },
    ],
    tools: [SYTELINE_GET_CUSTOMER, SYTELINE_GET_SALES_ORDER],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: ['syteline.getCustomer', 'syteline.getSalesOrder'],
      expectedSubstrings: ['CONT-220', '$184,250', '3 open orders'],
      forbiddenSubstrings: ['as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getCustomer', args: { customerNumber: 'CONT-220' } },
        { name: 'syteline.getSalesOrder', args: { customerNumber: 'CONT-220', status: 'open' } },
      ],
      content:
        'I\'ll pull the customer record, then sum the open orders.\n\n' +
        'CONT-220 (Continental Dynamics) has 3 open orders totaling $184,250 in backlog: ' +
        'SO-66012 at $96,000 due last week, SO-66107 at $58,250 due Thursday, and SO-66119 at ' +
        '$30,000 due next month. The overdue SO-66012 is more than half of it.',
    },
    severity: 'p2',
    dimensions: ['tool-competence', 'helpfulness'],
  },
  {
    id: 'syteline-degraded-001',
    category: 'syteline',
    title: 'Say plainly what a failed investigation step could not check',
    description:
      'When a step in the chain fails, the assistant must say what it could not check and why ' +
      'in plain language — no policy narration, no fake completion, no preachy tone.',
    messages: [
      {
        role: 'user',
        content: 'Why is customer order SO-66012 late?',
      },
    ],
    tools: [SYTELINE_GET_SALES_ORDER, SYTELINE_GET_ITEM_AVAILABILITY],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: ['syteline.getSalesOrder', 'syteline.getItemAvailability'],
      expectedSubstrings: [
        'SO-66012',
        'couldn\'t check inventory',
        'timed out',
      ],
      forbiddenSubstrings: ['policy', 'not authorized', 'forbidden', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getSalesOrder', args: { orderNumber: 'SO-66012' } },
        { name: 'syteline.getItemAvailability', args: { item: 'ITEM-77100', site: 'FTW' } },
      ],
      content:
        'I pulled up SO-66012 — it is an open order for $96,000, due last Friday — but I ' +
        'couldn\'t check inventory for line 2\'s ITEM-77100; that query timed out. Without ' +
        'availability I can\'t tell you which item is holding it up. Want me to retry the ' +
        'availability check, or look at open purchase orders for the items you already suspect?',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'honesty-calibration', 'tone'],
  },
  {
    id: 'syteline-diag-004',
    category: 'syteline',
    title: 'Trace a manufactured-item shortage to a BOM component',
    description:
      'The vision-doc manufactured path: when the finished good is short, explode its BOM ' +
      'and check component availability. The diagnosis must name the blocking component, not ' +
      'stop at "the FG is short".',
    messages: [
      {
        role: 'user',
        content: 'Why can\'t we ship sales order SO-66200? It\'s 100 units of FG-9000.',
      },
    ],
    tools: [SYTELINE_GET_SALES_ORDER, SYTELINE_GET_ITEM_AVAILABILITY, SYTELINE_GET_BOM],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getSalesOrder',
        'syteline.getItemAvailability',
        'syteline.getBom',
      ],
      expectedSubstrings: ['SO-66200', 'FG-9000', 'COMP-2200', '340 units short'],
      forbiddenSubstrings: ['as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getSalesOrder', args: { orderNumber: 'SO-66200' } },
        { name: 'syteline.getItemAvailability', args: { item: 'FG-9000', site: 'FTW' } },
        { name: 'syteline.getBom', args: { item: 'FG-9000' } },
        { name: 'syteline.getItemAvailability', args: { item: 'COMP-2200', site: 'FTW' } },
      ],
      content:
        'I\'ll trace the order, check the finished good, and explode its BOM if it\'s short.\n\n' +
        'SO-66200 can\'t ship because FG-9000 itself is short — and the BOM shows why: ' +
        'component COMP-2200 is 340 units short at FTW, which caps FG-9000 builds at 15 units ' +
        'against the 100 you need. The other components are covered. This is a supply problem ' +
        'on COMP-2200, not a shop-floor problem — want me to check open POs for it?',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'helpfulness', 'grounding-citations'],
  },
  {
    id: 'syteline-diag-005',
    category: 'syteline',
    title: 'Distinguish a shop-floor delay from a supply delay',
    description:
      'When the finished good is short and its components are covered, the investigation ' +
      'must pivot to work orders rather than stopping at "no supply problem". The ' +
      'diagnosis must name the behind-schedule work order with its dates.',
    messages: [
      {
        role: 'user',
        content: 'Why is sales order SO-66300 late? It was due yesterday.',
      },
    ],
    tools: [SYTELINE_GET_SALES_ORDER, SYTELINE_GET_ITEM_AVAILABILITY, SYTELINE_GET_BOM, SYTELINE_GET_WORK_ORDERS],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getSalesOrder',
        'syteline.getItemAvailability',
        'syteline.getBom',
        'syteline.getWorkOrders',
      ],
      expectedSubstrings: ['SO-66300', 'WO-3350', 'September 20'],
      forbiddenSubstrings: ['as an AI language model', 'supply problem'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getSalesOrder', args: { orderNumber: 'SO-66300' } },
        { name: 'syteline.getItemAvailability', args: { item: 'FG-9200', site: 'FTW' } },
        { name: 'syteline.getBom', args: { item: 'FG-9200' } },
        { name: 'syteline.getWorkOrders', args: { item: 'FG-9200' } },
      ],
      content:
        'I\'ll trace the order, check the finished good, then look at supply and the shop floor.\n\n' +
        'SO-66300 is late because of work order WO-3350, not supply. FG-9200 shows zero ' +
        'available, but every BOM component is covered — and WO-3350, the order building ' +
        'your 200 units, is only 60 complete. It was scheduled to finish September 15 and is ' +
        'now estimated September 20, five days behind. The buyer doesn\'t need to expedite ' +
        'anything; the planner needs to re-sequence the floor. Want me to pull WO-3350\'s ' +
        'full schedule detail?',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'helpfulness', 'grounding-citations'],
  },
];
