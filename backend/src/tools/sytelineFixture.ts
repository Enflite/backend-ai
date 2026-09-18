/**
 * sytelineFixture.ts — deterministic mock SyteLine dataset for evals and tests.
 *
 * Implements the SyteLineAdapter interface with a fixed, realistic
 * multi-entity dataset matching docs/syteline-vision.md's diagnostic
 * scenarios. Every record ID cited by the eval corpus's mock responses
 * (SO-66012, ITEM-77100, PO-4488, WO-3301, FG-9000, COMP-2200, CONT-220,
 * …) exists here with the exact numbers the corpus asserts — a
 * fixture-consistency test replays each syteline eval case's expected tool
 * chain against this fixture and fails if a cited record is missing or
 * contradicts the case, which is how "zero invented records" is enforced
 * deterministically in CI.
 *
 * Dates are fixed around the week of 2026-09-17 (the corpus's "today"):
 * last Friday = 2026-09-11, "6 days ago" = 2026-09-11, this Thursday =
 * 2026-09-17. Each diagnostic scenario owns its records so scenarios never
 * collide on the same (entity, key): SO-66012/ITEM-77100/PO-4488 (late
 * order → late PO), WO-3301/ITEM-55410 (BOM blocker), ITEM-77900/PO-4520
 * (negative-inventory forensics), SO-66200/FG-9000/COMP-2200 (manufactured
 * shortage → component), CONT-220 backlog aggregation, SO-66300/WO-3350
 * (late order → behind work order, not supply).
 */

import type {
  BomResult,
  CustomerResult,
  ItemAvailabilityResult,
  PurchaseOrdersResult,
  SalesOrderResult,
  SyteLineAdapter,
  WorkOrdersResult,
} from './syteline.js';

const FTW = 'FTW';

const SALES_ORDERS: Record<string, SalesOrderResult> = {
  'SO-66012': {
    orderNumber: 'SO-66012',
    customerNumber: 'CONT-220',
    customerName: 'Continental Dynamics',
    site: FTW,
    orderDate: '2026-08-28',
    dueDate: '2026-09-11',
    promisedDate: '2026-09-11',
    status: 'open',
    totalValue: 96000,
    currency: 'USD',
    lines: [
      { lineNumber: 1, item: 'ITEM-77000', description: 'Bracket assembly', quantityOrdered: 200, quantityShipped: 200, unitPrice: 120, promisedDate: '2026-09-11', status: 'shipped' },
      { lineNumber: 2, item: 'ITEM-77100', description: 'Precision shaft', quantityOrdered: 500, quantityShipped: 0, unitPrice: 96, promisedDate: '2026-09-11', status: 'open' },
      { lineNumber: 3, item: 'ITEM-77300', description: 'Seal kit', quantityOrdered: 50, quantityShipped: 50, unitPrice: 240, promisedDate: '2026-09-11', status: 'shipped' },
    ],
  },
  'SO-66107': {
    orderNumber: 'SO-66107',
    customerNumber: 'CONT-220',
    customerName: 'Continental Dynamics',
    site: FTW,
    orderDate: '2026-09-02',
    dueDate: '2026-09-17',
    status: 'open',
    totalValue: 58250,
    currency: 'USD',
    lines: [
      { lineNumber: 1, item: 'ITEM-77000', description: 'Bracket assembly', quantityOrdered: 350, quantityShipped: 0, unitPrice: 120, promisedDate: '2026-09-17', status: 'open' },
      { lineNumber: 2, item: 'ITEM-77400', description: 'Gasket set', quantityOrdered: 325, quantityShipped: 0, unitPrice: 50, promisedDate: '2026-09-17', status: 'open' },
    ],
  },
  'SO-66119': {
    orderNumber: 'SO-66119',
    customerNumber: 'CONT-220',
    customerName: 'Continental Dynamics',
    site: FTW,
    orderDate: '2026-09-09',
    dueDate: '2026-10-17',
    status: 'open',
    totalValue: 30000,
    currency: 'USD',
    lines: [
      { lineNumber: 1, item: 'ITEM-77500', description: 'Mounting plate', quantityOrdered: 150, quantityShipped: 0, unitPrice: 200, promisedDate: '2026-10-17', status: 'open' },
    ],
  },
  'SO-66200': {
    orderNumber: 'SO-66200',
    customerNumber: 'CONT-221',
    customerName: 'Meridian Tooling',
    site: FTW,
    orderDate: '2026-09-04',
    dueDate: '2026-09-18',
    status: 'open',
    totalValue: 45000,
    currency: 'USD',
    lines: [
      { lineNumber: 1, item: 'FG-9000', description: 'Gearbox assembly', quantityOrdered: 100, quantityShipped: 0, unitPrice: 450, promisedDate: '2026-09-18', status: 'open' },
    ],
  },
  'SO-66300': {
    orderNumber: 'SO-66300',
    customerNumber: 'CONT-222',
    customerName: 'Blue River Mfg',
    site: FTW,
    orderDate: '2026-09-01',
    dueDate: '2026-09-16',
    status: 'open',
    totalValue: 62000,
    currency: 'USD',
    lines: [
      { lineNumber: 1, item: 'FG-9200', description: 'Pump housing', quantityOrdered: 200, quantityShipped: 0, unitPrice: 310, promisedDate: '2026-09-16', status: 'open' },
    ],
  },
};

const AVAILABILITY: Record<string, ItemAvailabilityResult> = {
  'ITEM-77100': {
    item: 'ITEM-77100', site: FTW, description: 'Precision shaft',
    onHand: 220, allocated: 40, available: 180, unitOfMeasure: 'EA',
  },
  'ITEM-77000': {
    item: 'ITEM-77000', site: FTW, description: 'Bracket assembly',
    onHand: 1200, allocated: 350, available: 850, unitOfMeasure: 'EA',
  },
  'ITEM-77300': {
    item: 'ITEM-77300', site: FTW, description: 'Seal kit',
    onHand: 400, allocated: 50, available: 350, unitOfMeasure: 'EA',
  },
  'ITEM-55410': {
    item: 'ITEM-55410', site: FTW, description: 'Bearing race',
    onHand: 60, allocated: 0, available: 60, unitOfMeasure: 'EA',
  },
  'FG-9000': {
    item: 'FG-9000', site: FTW, description: 'Gearbox assembly',
    onHand: 0, allocated: 0, available: 0, unitOfMeasure: 'EA',
  },
  'COMP-2200': {
    item: 'COMP-2200', site: FTW, description: 'Pinion gear',
    onHand: 60, allocated: 0, available: 60, unitOfMeasure: 'EA',
  },
  'FG-9200': {
    item: 'FG-9200', site: FTW, description: 'Pump housing',
    onHand: 0, allocated: 0, available: 0, unitOfMeasure: 'EA',
  },
  // syteline-diag-005 evidence: FG-9200's BOM components are all covered
  // for a 200-unit build (1/1/2 per unit → 200/200/400 needed), which is
  // what lets that case rule out supply and pivot to the work order.
  'COMP-2300': {
    item: 'COMP-2300', site: FTW, description: 'Volute casing',
    onHand: 900, allocated: 200, available: 700, unitOfMeasure: 'EA',
  },
  'COMP-2301': {
    item: 'COMP-2301', site: FTW, description: 'Impeller',
    onHand: 600, allocated: 200, available: 400, unitOfMeasure: 'EA',
  },
  'COMP-2302': {
    item: 'COMP-2302', site: FTW, description: 'Wear ring',
    onHand: 1400, allocated: 400, available: 1000, unitOfMeasure: 'EA',
  },
  // Negative-inventory forensics scenario: the -460 cycle-count adjustment
  // posted Tuesday before the week's receipts were booked, driving on-hand
  // negative; the transaction trail tells the story, not a guess.
  'ITEM-77900': {
    item: 'ITEM-77900', site: FTW, description: 'Coupling insert',
    onHand: -40, allocated: 0, available: -40, unitOfMeasure: 'EA',
    recentTransactions: [
      { transactionDate: '2026-09-16', type: 'issue', quantity: -80, reference: 'WO-3301', note: 'Material issue to work order' },
      { transactionDate: '2026-09-16', type: 'receipt', quantity: 300, reference: 'PO-4520', note: 'Partial receipt against PO-4520' },
      { transactionDate: '2026-09-15', type: 'adjustment', quantity: -460, reference: 'CC-8812', note: 'Cycle-count adjustment' },
    ],
  },
};

const PURCHASE_ORDERS: PurchaseOrdersResult[] = [
  {
    item: 'ITEM-77100', site: FTW,
    purchaseOrders: [
      {
        poNumber: 'PO-4488', item: 'ITEM-77100', site: FTW,
        quantityOrdered: 500, quantityReceived: 0,
        promisedDate: '2026-09-11', status: 'open',
        supplierNumber: 'SUP-100', supplierName: 'Acme Metals',
      },
    ],
  },
  {
    item: 'ITEM-77900', site: FTW,
    purchaseOrders: [
      {
        poNumber: 'PO-4520', item: 'ITEM-77900', site: FTW,
        quantityOrdered: 400, quantityReceived: 300,
        promisedDate: '2026-09-17', status: 'open',
        supplierNumber: 'SUP-104', supplierName: 'Brazos Supply',
      },
    ],
  },
];

const WORK_ORDERS: WorkOrdersResult = {
  workOrders: [
    {
      workOrderNumber: 'WO-3301', item: 'FG-9100', site: FTW,
      quantityOrdered: 240, quantityCompleted: 0, status: 'released',
      scheduledStart: '2026-09-14', scheduledComplete: '2026-09-18',
    },
    {
      workOrderNumber: 'WO-3350', item: 'FG-9200', site: FTW,
      quantityOrdered: 200, quantityCompleted: 60, status: 'in-progress',
      scheduledStart: '2026-09-08', scheduledComplete: '2026-09-15',
      estimatedCompletion: '2026-09-20',
    },
  ],
};

function coveredComponents(items: Array<[string, string, number]>): BomResult['components'] {
  return items.map(([item, description, quantityPer], index) => ({
    item, description, quantityPer, unitOfMeasure: 'EA', level: 1, leadTimeDays: 5 + index,
  }));
}

const BOMS: Record<string, BomResult> = {
  // WO-3301 builds FG-9100: 15 components, only ITEM-55410 is short
  // (240 needed, 60 available → 180 short).
  'FG-9100': {
    item: 'FG-9100', site: FTW, levels: 1,
    components: [
      { item: 'ITEM-55410', description: 'Bearing race', quantityPer: 1, unitOfMeasure: 'EA', level: 1, leadTimeDays: 21 },
      ...coveredComponents([
        ['ITEM-55411', 'Bearing cage', 1],
        ['ITEM-55412', 'Retaining ring', 2],
        ['ITEM-55413', 'Spacer sleeve', 1],
        ['ITEM-55414', 'End cap', 1],
        ['ITEM-55415', 'Fastener kit', 8],
        ['ITEM-55416', 'Lubricant tube', 1],
        ['ITEM-55417', 'Nameplate', 1],
        ['ITEM-55418', 'Gasket', 2],
        ['ITEM-55419', 'Snap ring', 4],
        ['ITEM-55420', 'Washer set', 6],
        ['ITEM-55421', 'Thread insert', 4],
        ['ITEM-55422', 'Packaging', 1],
        ['ITEM-55423', 'Desiccant', 2],
        ['ITEM-55424', 'Label', 1],
      ]),
    ],
  },
  // SO-66200's FG-9000: COMP-2200 ×4 per unit caps builds at 60 units
  // against the 100 needed (340 units short).
  'FG-9000': {
    item: 'FG-9000', site: FTW, levels: 1,
    components: [
      { item: 'COMP-2200', description: 'Pinion gear', quantityPer: 4, unitOfMeasure: 'EA', level: 1, leadTimeDays: 30 },
      ...coveredComponents([
        ['COMP-2201', 'Gear housing', 1],
        ['COMP-2202', 'Output shaft', 1],
        ['COMP-2203', 'Bearing set', 2],
      ]),
    ],
  },
  'FG-9200': {
    item: 'FG-9200', site: FTW, levels: 1,
    components: coveredComponents([
      ['COMP-2300', 'Volute casing', 1],
      ['COMP-2301', 'Impeller', 1],
      ['COMP-2302', 'Wear ring', 2],
    ]),
  },
};

const CUSTOMERS: Record<string, CustomerResult> = {
  'CONT-220': { customerNumber: 'CONT-220', name: 'Continental Dynamics', status: 'active', creditHold: false, site: FTW },
  'CONT-221': { customerNumber: 'CONT-221', name: 'Meridian Tooling', status: 'active', creditHold: false, site: FTW },
  'CONT-222': { customerNumber: 'CONT-222', name: 'Blue River Mfg', status: 'active', creditHold: false, site: FTW },
};

const ITEMS: Record<string, { item: string; site: string; description: string; itemType: string }> = {
  'ITEM-77100': { item: 'ITEM-77100', site: FTW, description: 'Precision shaft', itemType: 'purchased' },
  'ITEM-77900': { item: 'ITEM-77900', site: FTW, description: 'Coupling insert', itemType: 'purchased' },
  'FG-9000': { item: 'FG-9000', site: FTW, description: 'Gearbox assembly', itemType: 'manufactured' },
};

export class MockSyteLineAdapter implements SyteLineAdapter {
  async getItem(input: { item: string; site: string }, _signal: AbortSignal): Promise<unknown> {
    const record = ITEMS[input.item];
    // Never invent fixture records: an unknown item is SYTELINE_NOT_FOUND,
    // exactly like the real adapter's not-found path.
    if (!record) throw Object.assign(new Error(`Item ${input.item} not found`), { code: 'SYTELINE_NOT_FOUND' });
    return record;
  }

  async getSalesOrder(input: { orderNumber?: string; customerNumber?: string; site?: string; status?: string }, _signal: AbortSignal): Promise<SalesOrderResult> {
    if (input.orderNumber) {
      const order = SALES_ORDERS[input.orderNumber];
      if (!order) throw Object.assign(new Error(`Sales order ${input.orderNumber} not found`), { code: 'SYTELINE_NOT_FOUND' });
      return order;
    }
    const orders = Object.values(SALES_ORDERS).filter(
      (o) =>
        (!input.customerNumber || o.customerNumber === input.customerNumber) &&
        (!input.status || input.status === 'all' || o.status === input.status) &&
        (!input.site || o.site === input.site)
    );
    const header = orders[0];
    return {
      orderNumber: input.customerNumber ?? '',
      customerNumber: input.customerNumber,
      customerName: header?.customerName,
      site: input.site,
      status: input.status ?? 'open',
      orders: orders.map(({ lines: _lines, ...rest }) => rest),
      lines: [],
    };
  }

  async getItemAvailability(input: { item: string; site: string }, _signal: AbortSignal): Promise<ItemAvailabilityResult> {
    const record = AVAILABILITY[input.item];
    if (!record) throw Object.assign(new Error(`Item ${input.item} not found at ${input.site}`), { code: 'SYTELINE_NOT_FOUND' });
    return record;
  }

  async getOpenPurchaseOrders(input: { item: string; site?: string }, _signal: AbortSignal): Promise<PurchaseOrdersResult> {
    const found = PURCHASE_ORDERS.find((po) => po.item === input.item && (!input.site || po.site === input.site));
    return found ?? { item: input.item, site: input.site, purchaseOrders: [] };
  }

  async getWorkOrders(input: { workOrderNumber?: string; item?: string; site?: string; status?: string }, _signal: AbortSignal): Promise<WorkOrdersResult> {
    const workOrders = WORK_ORDERS.workOrders.filter(
      (wo) =>
        (!input.workOrderNumber || wo.workOrderNumber === input.workOrderNumber) &&
        (!input.item || wo.item === input.item) &&
        (!input.site || wo.site === input.site) &&
        (!input.status || wo.status === input.status)
    );
    return { workOrders };
  }

  async getBom(input: { item: string; site?: string; levels?: number }, _signal: AbortSignal): Promise<BomResult> {
    const bom = BOMS[input.item];
    if (!bom) throw Object.assign(new Error(`BOM for item ${input.item} not found`), { code: 'SYTELINE_NOT_FOUND' });
    return { ...bom, levels: input.levels ?? bom.levels };
  }

  async getCustomer(input: { customerNumber: string }, _signal: AbortSignal): Promise<CustomerResult> {
    const customer = CUSTOMERS[input.customerNumber];
    if (!customer) throw Object.assign(new Error(`Customer ${input.customerNumber} not found`), { code: 'SYTELINE_NOT_FOUND' });
    return customer;
  }
}
