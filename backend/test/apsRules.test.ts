/**
 * apsRules.test.ts — the pure deterministic APS rules engine.
 *
 * Every case runs against a fixed asOfDate (no clock). Missing facts skip
 * the rule for that row — never throw. VALIDATED IN CI; SyteLine evidence
 * here is hand-built (no live ERP).
 */
import { describe, expect, it } from 'vitest';
import {
  applyRules,
  type DemandFact,
  type DueDateFact,
  type NormalizedIssue,
  type SupplyFact,
} from '../src/aps/rules.js';

const AS_OF = '2026-10-02';

const issue = (overrides: Partial<NormalizedIssue> = {}): NormalizedIssue => ({
  rowIndex: 0,
  item: 'WIDGET-1',
  orderNumber: 'SO-100',
  dueDate: '2026-09-15',
  quantity: 100,
  ...overrides,
});

const supply = (overrides: Partial<SupplyFact> = {}): SupplyFact => ({
  rowIndex: 0,
  item: 'WIDGET-1',
  availability: { onHand: 1000, allocated: 0, available: 1000 },
  openPOs: [],
  ...overrides,
});

const demand = (overrides: Partial<DemandFact> = {}): DemandFact => ({
  rowIndex: 0,
  orderNumber: 'SO-100',
  salesOrder: { orderNumber: 'SO-100', status: 'Open' },
  ...overrides,
});

const dueDates = (overrides: Partial<DueDateFact> = {}): DueDateFact => ({
  rowIndex: 0,
  workOrders: [],
  ...overrides,
});

describe('PAST_DUE_OPEN_ORDER', () => {
  it('fires with critical severity when an open order is past due', () => {
    const findings = applyRules([issue()], [supply()], [demand()], [dueDates()], AS_OF);
    const hit = findings.find((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('critical');
    expect(hit!.rowIndex).toBe(0);
    expect(hit!.detail).toContain('SO-100');
  });

  it('fires when the order status is absent (fetched order, not known closed)', () => {
    const findings = applyRules(
      [issue()],
      [supply()],
      [demand({ salesOrder: { orderNumber: 'SO-100' } })],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(true);
  });

  it('does not fire when the due date is today or in the future', () => {
    const today = applyRules(
      [issue({ dueDate: '2026-10-02' })],
      [supply()],
      [demand()],
      [dueDates()],
      AS_OF,
    );
    const future = applyRules(
      [issue({ dueDate: '2026-11-01' })],
      [supply()],
      [demand()],
      [dueDates()],
      AS_OF,
    );
    expect(today.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
    expect(future.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
  });

  it('does not fire when the sales order is closed', () => {
    const findings = applyRules(
      [issue()],
      [supply()],
      [demand({ salesOrder: { orderNumber: 'SO-100', status: 'Closed' } })],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
  });

  it('skips when there are no demand facts for the row', () => {
    const findings = applyRules([issue()], [supply()], [], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
  });

  it('skips when the demand lookup errored', () => {
    const findings = applyRules(
      [issue()],
      [supply()],
      [demand({ error: 'timeout', salesOrder: undefined })],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
  });

  it('fires for an open work order past its due date', () => {
    const woIssue = issue({ orderNumber: undefined, workOrderNumber: 'WO-9', item: 'FG-1' });
    const findings = applyRules(
      [woIssue],
      [supply()],
      [],
      [dueDates({ workOrders: [{ workOrderNumber: 'WO-9', status: 'Released' }] })],
      AS_OF,
    );
    const hit = findings.find((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER');
    expect(hit).toBeDefined();
    expect(hit!.detail).toContain('WO-9');
  });

  it('does not fire when the work order is complete', () => {
    const woIssue = issue({ orderNumber: undefined, workOrderNumber: 'WO-9', item: 'FG-1' });
    const findings = applyRules(
      [woIssue],
      [supply()],
      [],
      [dueDates({ workOrders: [{ workOrderNumber: 'WO-9', status: 'Complete' }] })],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER')).toBe(false);
  });
});

describe('LATE_INBOUND_SUPPLY', () => {
  const latePo = supply({
    availability: { onHand: 0, allocated: 0, available: 0 },
    openPOs: [{ poNumber: 'PO-1', promisedDate: '2026-10-20', quantityOrdered: 100, quantityReceived: 0 }],
  });

  it('fires with high severity when a PO is promised after the demand due date', () => {
    const findings = applyRules([issue()], [latePo], [demand()], [dueDates()], AS_OF);
    const hit = findings.find((f) => f.ruleCode === 'LATE_INBOUND_SUPPLY');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.detail).toContain('PO-1');
  });

  it('does not fire when the PO is promised on or before the due date', () => {
    const onTime = supply({
      openPOs: [{ poNumber: 'PO-2', promisedDate: '2026-09-10', quantityOrdered: 100, quantityReceived: 0 }],
    });
    const findings = applyRules([issue()], [onTime], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'LATE_INBOUND_SUPPLY')).toBe(false);
  });

  it('skips POs with no parseable promised date', () => {
    const noDate = supply({
      openPOs: [{ poNumber: 'PO-3', quantityOrdered: 100, quantityReceived: 0 }],
    });
    const findings = applyRules([issue()], [noDate], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'LATE_INBOUND_SUPPLY')).toBe(false);
  });

  it('skips when the issue has no due date', () => {
    const findings = applyRules(
      [issue({ dueDate: undefined })],
      [latePo],
      [demand()],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'LATE_INBOUND_SUPPLY')).toBe(false);
  });
});

describe('MATERIAL_SHORTAGE', () => {
  it('fires with high severity when ATP is short and inbound does not cover it', () => {
    const short = supply({ availability: { onHand: 20, allocated: 0, available: 20 }, openPOs: [] });
    const findings = applyRules([issue({ quantity: 100 })], [short], [demand()], [dueDates()], AS_OF);
    const hit = findings.find((f) => f.ruleCode === 'MATERIAL_SHORTAGE');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('high');
    expect(hit!.detail).toContain('shortfall');
  });

  it('does not fire when ATP covers the requirement', () => {
    const covered = supply({ availability: { onHand: 500, allocated: 0, available: 500 } });
    const findings = applyRules([issue({ quantity: 100 })], [covered], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'MATERIAL_SHORTAGE')).toBe(false);
  });

  it('does not fire when inbound POs cover the shortfall', () => {
    const inboundCovers = supply({
      availability: { onHand: 20, allocated: 0, available: 20 },
      openPOs: [{ poNumber: 'PO-9', promisedDate: '2026-09-01', quantityOrdered: 200, quantityReceived: 0 }],
    });
    const findings = applyRules([issue({ quantity: 100 })], [inboundCovers], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'MATERIAL_SHORTAGE')).toBe(false);
  });

  it('derives ATP from on-hand minus allocated when available is missing', () => {
    const derived = supply({ availability: { onHand: 50, allocated: 40 } });
    const findings = applyRules([issue({ quantity: 100 })], [derived], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'MATERIAL_SHORTAGE')).toBe(true);
  });

  it('skips when the issue has no quantity', () => {
    const short = supply({ availability: { onHand: 1, allocated: 0, available: 1 } });
    const findings = applyRules([issue({ quantity: undefined })], [short], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'MATERIAL_SHORTAGE')).toBe(false);
  });

  it('skips when availability facts are missing', () => {
    const findings = applyRules([issue({ quantity: 100 })], [], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'MATERIAL_SHORTAGE')).toBe(false);
  });
});

describe('UNCOVERED_DEMAND', () => {
  it('fires with medium severity when demand exists but no supply records do', () => {
    const findings = applyRules([issue()], [], [demand()], [dueDates()], AS_OF);
    const hit = findings.find((f) => f.ruleCode === 'UNCOVERED_DEMAND');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('medium');
  });

  it('fires when the supply lookup errored', () => {
    const findings = applyRules(
      [issue()],
      [supply({ error: 'adapter down', availability: undefined })],
      [demand()],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'UNCOVERED_DEMAND')).toBe(true);
  });

  it('does not fire when supply records exist', () => {
    const findings = applyRules([issue()], [supply()], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'UNCOVERED_DEMAND')).toBe(false);
  });

  it('does not fire for rows with no demand reference', () => {
    const noRef = issue({ orderNumber: undefined, customerNumber: undefined });
    const findings = applyRules([noRef], [], [], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'UNCOVERED_DEMAND')).toBe(false);
  });

  it('fires for customerNumber demand rows with no supply', () => {
    const custIssue = issue({ orderNumber: undefined, customerNumber: 'CUST-7' });
    const findings = applyRules(
      [custIssue],
      [],
      [demand({ orderNumber: undefined, customerNumber: 'CUST-7' })],
      [dueDates()],
      AS_OF,
    );
    expect(findings.some((f) => f.ruleCode === 'UNCOVERED_DEMAND')).toBe(true);
  });
});

describe('EXCESS_SUPPLY', () => {
  it('fires with low severity when on-hand exceeds 3x demand', () => {
    const excess = supply({ availability: { onHand: 500, allocated: 0, available: 500 } });
    const findings = applyRules([issue({ quantity: 100 })], [excess], [demand()], [dueDates()], AS_OF);
    const hit = findings.find((f) => f.ruleCode === 'EXCESS_SUPPLY');
    expect(hit).toBeDefined();
    expect(hit!.severity).toBe('low');
    expect(hit!.detail).toContain('3x');
  });

  it('does not fire at exactly 3x demand', () => {
    const exact = supply({ availability: { onHand: 300, allocated: 0, available: 300 } });
    const findings = applyRules([issue({ quantity: 100 })], [exact], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'EXCESS_SUPPLY')).toBe(false);
  });

  it('skips when quantity is missing', () => {
    const excess = supply({ availability: { onHand: 9999, allocated: 0, available: 9999 } });
    const findings = applyRules([issue({ quantity: undefined })], [excess], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'EXCESS_SUPPLY')).toBe(false);
  });
});

describe('engine defensiveness', () => {
  it('never throws on malformed rows or missing everything', () => {
    expect(() =>
      applyRules(
        [null as unknown as NormalizedIssue, {} as NormalizedIssue, issue({ dueDate: 'not-a-date' })],
        [],
        [],
        [],
        AS_OF,
      ),
    ).not.toThrow();
  });

  it('rowIndex defaults to the array position when absent', () => {
    const rows = [issue({ rowIndex: undefined }), issue({ rowIndex: undefined })];
    const findings = applyRules(rows, [supply({ rowIndex: 1 })], [demand({ rowIndex: 1 })], [], AS_OF);
    for (const finding of findings) {
      expect(finding.rowIndex).toBe(1);
    }
  });

  it('maps facts by rowIndex, not array position', () => {
    const rows = [issue({ rowIndex: 7, dueDate: '2026-09-01' })];
    const findings = applyRules(
      rows,
      [],
      [demand({ rowIndex: 7 })],
      [],
      AS_OF,
    );
    const hit = findings.find((f) => f.ruleCode === 'PAST_DUE_OPEN_ORDER');
    expect(hit?.rowIndex).toBe(7);
  });

  it('accepts ISO datetime promised dates', () => {
    const po = supply({
      openPOs: [{ poNumber: 'PO-ISO', promisedDate: '2026-11-02T00:00:00Z', quantityOrdered: 5, quantityReceived: 0 }],
    });
    const findings = applyRules([issue()], [po], [demand()], [dueDates()], AS_OF);
    expect(findings.some((f) => f.ruleCode === 'LATE_INBOUND_SUPPLY')).toBe(true);
  });
});
