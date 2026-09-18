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
// The `syteline.*` tool names here are eval fixtures mirroring the vision's
// entities (sales orders, order lines, items, inventory availability,
// purchase orders, work orders, BOMs, customers); the Phase 5 tool surface
// is specified by docs/syteline-vision.md.
//
// Fixtures are realistic but synthetic; IDs (SO-66012, ITEM-77100,
// PO-4488, WO-3301, CONT-220) are stable across the corpus so live runs
// can cross-check citations against tool results.
// ---------------------------------------------------------------------------

const SYTELINE_GET_ORDER: EvalToolDef = {
  name: 'syteline.getOrder',
  description: 'Look up a SyteLine customer order header by order number.',
  parameters: {
    type: 'object',
    required: ['orderNumber'],
    properties: { orderNumber: { type: 'string' } },
  },
};

const SYTELINE_GET_ORDER_LINES: EvalToolDef = {
  name: 'syteline.getOrderLines',
  description: 'List the lines of a SyteLine customer order.',
  parameters: {
    type: 'object',
    required: ['orderNumber'],
    properties: { orderNumber: { type: 'string' } },
  },
};

const SYTELINE_GET_ITEM_AVAILABILITY: EvalToolDef = {
  name: 'syteline.getItemAvailability',
  description: 'On-hand, allocated, and available quantities for an item at a site.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' }, site: { type: 'string' } },
  },
};

const SYTELINE_GET_OPEN_POS: EvalToolDef = {
  name: 'syteline.getOpenPurchaseOrders',
  description: 'Open purchase orders for an item, with promised dates.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' } },
  },
};

const SYTELINE_GET_WORK_ORDER: EvalToolDef = {
  name: 'syteline.getWorkOrder',
  description: 'Look up a SyteLine work order header by work order number.',
  parameters: {
    type: 'object',
    required: ['workOrderNumber'],
    properties: { workOrderNumber: { type: 'string' } },
  },
};

const SYTELINE_GET_WO_MATERIALS: EvalToolDef = {
  name: 'syteline.getWorkOrderMaterials',
  description: 'Component material requirements for a work order (BOM explosion).',
  parameters: {
    type: 'object',
    required: ['workOrderNumber'],
    properties: { workOrderNumber: { type: 'string' } },
  },
};

const SYTELINE_GET_ITEM: EvalToolDef = {
  name: 'syteline.getItem',
  description: 'Look up a SyteLine inventory item by item number and site.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' }, site: { type: 'string' } },
  },
};

const SYTELINE_GET_INV_TXNS: EvalToolDef = {
  name: 'syteline.getInventoryTransactions',
  description: 'Recent inventory transactions (receipts, issues, adjustments) for an item at a site.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' }, site: { type: 'string' } },
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

const SYTELINE_GET_OPEN_ORDERS: EvalToolDef = {
  name: 'syteline.getOpenOrders',
  description: 'Open sales orders for a customer with line values and due dates.',
  parameters: {
    type: 'object',
    required: ['customerNumber'],
    properties: { customerNumber: { type: 'string' } },
  },
};

const SYTELINE_GET_BOM: EvalToolDef = {
  name: 'syteline.getBOM',
  description: 'Explode the bill of materials for a manufactured item into components.',
  parameters: {
    type: 'object',
    required: ['item'],
    properties: { item: { type: 'string' } },
  },
};

export const SYTELINE_DIAG_CASES: EvalCase[] = [
  {
    id: 'syteline-diag-001',
    category: 'syteline',
    title: 'Diagnose a late customer order across entities',
    description:
      'The flagship agentic case: "why is this order late?" The assistant must chain ' +
      'order -> order lines -> item availability -> open POs, narrate its plan briefly, and ' +
      'synthesize the true root cause (late component PO) with citations to real records.',
    messages: [
      {
        role: 'user',
        content: 'Why is customer order SO-66012 late? It was due last Friday.',
      },
    ],
    tools: [
      SYTELINE_GET_ORDER,
      SYTELINE_GET_ORDER_LINES,
      SYTELINE_GET_ITEM_AVAILABILITY,
      SYTELINE_GET_OPEN_POS,
    ],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getOrder',
        'syteline.getOrderLines',
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
        { name: 'syteline.getOrder', args: { orderNumber: 'SO-66012' } },
        { name: 'syteline.getOrderLines', args: { orderNumber: 'SO-66012' } },
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
      'Chain work order -> BOM materials -> item availability and identify the blocking ' +
      'component. The synthesis must name the short component and its shortage, not hedge.',
    messages: [
      {
        role: 'user',
        content: 'Which components are blocking work order WO-3301 from starting?',
      },
    ],
    tools: [SYTELINE_GET_WORK_ORDER, SYTELINE_GET_WO_MATERIALS, SYTELINE_GET_ITEM_AVAILABILITY],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getWorkOrder',
        'syteline.getWorkOrderMaterials',
        'syteline.getItemAvailability',
      ],
      expectedSubstrings: ['WO-3301', 'ITEM-55410', '180 units short'],
      forbiddenSubstrings: ['all components are available', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getWorkOrder', args: { workOrderNumber: 'WO-3301' } },
        { name: 'syteline.getWorkOrderMaterials', args: { workOrderNumber: 'WO-3301' } },
        { name: 'syteline.getItemAvailability', args: { item: 'ITEM-55410', site: 'FTW' } },
      ],
      content:
        'I\'ll pull the work order, explode its BOM, and check availability for each component.\n\n' +
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
        content: 'Why is inventory negative on ITEM-77100 at the Fort Worth site?',
      },
    ],
    tools: [SYTELINE_GET_ITEM, SYTELINE_GET_INV_TXNS, SYTELINE_GET_OPEN_POS],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getItem',
        'syteline.getInventoryTransactions',
        'syteline.getOpenPurchaseOrders',
      ],
      expectedSubstrings: ['ITEM-77100', 'cycle-count adjustment', 'PO-4512'],
      forbiddenSubstrings: ['data entry error', 'someone probably', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getItem', args: { item: 'ITEM-77100', site: 'FTW' } },
        { name: 'syteline.getInventoryTransactions', args: { item: 'ITEM-77100', site: 'FTW' } },
        { name: 'syteline.getOpenPurchaseOrders', args: { item: 'ITEM-77100' } },
      ],
      content:
        'I\'ll look at the item record, then walk its recent transactions to see what drove it negative.\n\n' +
        'ITEM-77100 shows -40 at FTW because a cycle-count adjustment of -460 posted on Tuesday, ' +
        'before the two receipts that week were booked. It is a timing artifact, not a real ' +
        'shortage: PO-4512 (400 units) is open with a promise date of this Thursday, which ' +
        'brings the balance positive. If the count itself looks wrong, a recount is the fix — ' +
        'not another adjustment on top.',
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
    tools: [SYTELINE_GET_CUSTOMER, SYTELINE_GET_OPEN_ORDERS],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: ['syteline.getCustomer', 'syteline.getOpenOrders'],
      expectedSubstrings: ['CONT-220', '$184,250', '3 open orders'],
      forbiddenSubstrings: ['as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getCustomer', args: { customerNumber: 'CONT-220' } },
        { name: 'syteline.getOpenOrders', args: { customerNumber: 'CONT-220' } },
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
    tools: [SYTELINE_GET_ORDER, SYTELINE_GET_ORDER_LINES],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: ['syteline.getOrder', 'syteline.getOrderLines'],
      expectedSubstrings: [
        'SO-66012',
        'couldn\'t retrieve its order lines',
        'timed out',
      ],
      forbiddenSubstrings: ['policy', 'not authorized', 'forbidden', 'as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getOrder', args: { orderNumber: 'SO-66012' } },
        { name: 'syteline.getOrderLines', args: { orderNumber: 'SO-66012' } },
      ],
      content:
        'I pulled up SO-66012 — it is an open order for $96,000, due last Friday — but I ' +
        'couldn\'t retrieve its order lines; that query timed out. Without the lines I can\'t ' +
        'tell you which item is holding it up. Want me to retry the lines query, or check ' +
        'inventory for the items you already suspect?',
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
    tools: [SYTELINE_GET_ORDER, SYTELINE_GET_ORDER_LINES, SYTELINE_GET_ITEM_AVAILABILITY, SYTELINE_GET_BOM],
    judge: {
      kind: 'tool-chain',
      expectedToolChain: [
        'syteline.getOrder',
        'syteline.getOrderLines',
        'syteline.getItemAvailability',
        'syteline.getBOM',
      ],
      expectedSubstrings: ['SO-66200', 'FG-9000', 'COMP-2200', '340 units short'],
      forbiddenSubstrings: ['as an AI language model'],
    },
    mockResponse: {
      toolCalls: [
        { name: 'syteline.getOrder', args: { orderNumber: 'SO-66200' } },
        { name: 'syteline.getOrderLines', args: { orderNumber: 'SO-66200' } },
        { name: 'syteline.getItemAvailability', args: { item: 'FG-9000', site: 'FTW' } },
        { name: 'syteline.getBOM', args: { item: 'FG-9000' } },
        { name: 'syteline.getItemAvailability', args: { item: 'COMP-2200', site: 'FTW' } },
      ],
      content:
        'I\'ll trace the order, check the finished good, and explode its BOM if it\'s short.\n\n' +
        'SO-66200 can\'t ship because FG-9000 itself is short — and the BOM shows why: ' +
        'component COMP-2200 is 340 units short at FTW, which caps FG-9000 builds at 60 units ' +
        'against the 100 you need. The other components are covered. This is a supply problem ' +
        'on COMP-2200, not a shop-floor problem — want me to check open POs for it?',
    },
    severity: 'p1',
    dimensions: ['tool-competence', 'helpfulness', 'grounding-citations'],
  },
];
