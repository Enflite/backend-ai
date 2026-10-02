/**
 * rules.ts — PURE deterministic APS rules engine for the exception-resolution
 * flow. No I/O, no dates from the clock (asOfDate is a parameter for
 * testability), no throws on partial input: a rule that cannot be evaluated
 * for a row because its facts are missing is skipped for that row.
 *
 * Pipeline position: the planner uploads an exception report →
 * aps.parseExceptionReport / aps.normalizeExceptionRows → the
 * aps.collect*Facts tools fetch SyteLine evidence → applyRules computes
 * deterministic findings (what the rules can prove). An LLM step then
 * explains, correlates, and prioritizes — but it never invents findings
 * the rules did not emit (Jake's product rule: deterministic rules compute
 * facts, the LLM explains).
 *
 * Rule set (each rule documents its own intent below):
 *   PAST_DUE_OPEN_ORDER — dueDate < asOfDate and the order is still open (critical)
 *   LATE_INBOUND_SUPPLY — an inbound PO is promised after the demand due date (high)
 *   MATERIAL_SHORTAGE   — ATP < required and inbound does not cover the shortfall (high)
 *   UNCOVERED_DEMAND    — a demand row with no supply records at all (medium)
 *   EXCESS_SUPPLY       — on-hand > 3x open demand, flagged for review (low)
 */

export type ApsSeverity = 'critical' | 'high' | 'medium' | 'low';

export type ApsRuleCode =
  | 'PAST_DUE_OPEN_ORDER'
  | 'LATE_INBOUND_SUPPLY'
  | 'MATERIAL_SHORTAGE'
  | 'UNCOVERED_DEMAND'
  | 'EXCESS_SUPPLY';

/** One deterministic finding: what fired, where, how bad, and why. */
export interface ApsFinding {
  /** Position of the exception row in the normalized issues array. */
  rowIndex: number;
  ruleCode: ApsRuleCode;
  severity: ApsSeverity;
  detail: string;
}

/** Normalized exception row (output of aps.normalizeExceptionRows). */
export interface NormalizedIssue {
  rowIndex?: number;
  item?: string;
  orderNumber?: string;
  customerNumber?: string;
  workOrderNumber?: string;
  dueDate?: string;
  quantity?: number;
  exceptionText?: string;
  [key: string]: unknown;
}

/** Per-row evidence from aps.collectSupplyFacts. */
export interface SupplyFact {
  rowIndex: number;
  item?: string;
  availability?: {
    onHand?: number;
    allocated?: number;
    available?: number;
  };
  openPOs?: Array<{
    poNumber?: string;
    promisedDate?: string;
    quantityOrdered?: number;
    quantityReceived?: number;
  }>;
  error?: string;
}

/** Per-row evidence from aps.collectDemandFacts. */
export interface DemandFact {
  rowIndex: number;
  orderNumber?: string;
  customerNumber?: string;
  /** Raw SyteLine sales-order payload (shape varies by adapter; read defensively). */
  salesOrder?: unknown;
  note?: string;
  error?: string;
}

/** Per-row evidence from aps.evaluateDueDates. */
export interface DueDateFact {
  rowIndex: number;
  workOrders?: Array<{
    workOrderNumber?: string;
    status?: string;
    scheduledComplete?: string;
    quantityOrdered?: number;
    quantityCompleted?: number;
  }>;
  note?: string;
  error?: string;
}

/** Read a finite number from a value that may be a number or a numeric string. */
function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize a date-ish value to YYYY-MM-DD. Accepts YYYY-MM-DD (prefix
 * match, so ISO datetimes work), and anything the Date constructor parses
 * (interpreted as UTC). Returns undefined when unparseable — callers skip
 * the rule for that row instead of throwing.
 */
export function normalizeDateToISO(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return undefined;
    const prefix = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (prefix) return `${prefix[1]}-${prefix[2]}-${prefix[3]}`;
  }
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** True when a sales-order-ish status string means the order is no longer actionable. */
function isTerminalOrderStatus(status: unknown): boolean {
  return /closed|cancel|complete|ship/i.test(String(status ?? ''));
}

/** Read an order status from the adapter's sales-order payload without assuming its shape. */
function salesOrderStatus(salesOrder: unknown): string | undefined {
  if (salesOrder === null || typeof salesOrder !== 'object') return undefined;
  const so = salesOrder as Record<string, unknown>;
  const candidates = [
    so.status,
    so.orderStatus,
    (so.header as Record<string, unknown> | undefined)?.status,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '') return candidate;
  }
  return undefined;
}

/**
 * Apply the deterministic APS rules to normalized issues + collected facts.
 *
 * @param issues normalized exception rows (rowIndex defaults to array position)
 * @param supplyFacts evidence keyed by rowIndex from aps.collectSupplyFacts
 * @param demandFacts evidence keyed by rowIndex from aps.collectDemandFacts
 * @param dueDateFacts evidence keyed by rowIndex from aps.evaluateDueDates
 * @param asOfDate evaluation date, YYYY-MM-DD — a parameter (not the clock) so runs are reproducible and testable
 */
export function applyRules(
  issues: NormalizedIssue[],
  supplyFacts: SupplyFact[],
  demandFacts: DemandFact[],
  dueDateFacts: DueDateFact[],
  asOfDate: string,
): ApsFinding[] {
  const findings: ApsFinding[] = [];
  const asOf = normalizeDateToISO(asOfDate);

  const supplyByRow = new Map<number, SupplyFact>();
  for (const fact of supplyFacts) {
    if (fact && typeof fact.rowIndex === 'number') supplyByRow.set(fact.rowIndex, fact);
  }
  const demandByRow = new Map<number, DemandFact>();
  for (const fact of demandFacts) {
    if (fact && typeof fact.rowIndex === 'number') demandByRow.set(fact.rowIndex, fact);
  }
  const dueDateByRow = new Map<number, DueDateFact>();
  for (const fact of dueDateFacts) {
    if (fact && typeof fact.rowIndex === 'number') dueDateByRow.set(fact.rowIndex, fact);
  }

  issues.forEach((issue, index) => {
    if (!issue || typeof issue !== 'object') return;
    const rowIndex = typeof issue.rowIndex === 'number' ? issue.rowIndex : index;
    const supply = supplyByRow.get(rowIndex);
    const demand = demandByRow.get(rowIndex);
    const dueDates = dueDateByRow.get(rowIndex);

    // --- PAST_DUE_OPEN_ORDER (critical) ---------------------------------
    // A demand row whose due date is already behind us and whose order or
    // work order is still actionable. The planner's most urgent queue: a
    // past-due line that is still open is a customer impact in progress.
    // "Still open" is proven from evidence — a demand fact whose sales order
    // is not in a terminal status, or a due-date fact with a non-terminal
    // work order. Rows with no usable evidence are skipped, never assumed.
    if (asOf) {
      const due = normalizeDateToISO(issue.dueDate);
      if (due && due < asOf) {
        if (issue.orderNumber && demand && !demand.error && demand.salesOrder !== undefined) {
          const status = salesOrderStatus(demand.salesOrder);
          // Absent status means "not known closed" — treat as open, since a
          // fetched order record is evidence the order exists; terminal
          // statuses are explicit.
          if (status === undefined || !isTerminalOrderStatus(status)) {
            findings.push({
              rowIndex,
              ruleCode: 'PAST_DUE_OPEN_ORDER',
              severity: 'critical',
              detail:
                `Order ${issue.orderNumber} for item ${issue.item ?? 'unknown'} ` +
                `was due ${due} (as of ${asOf}) and is still open`,
            });
          }
        } else if (issue.workOrderNumber && dueDates && !dueDates.error && dueDates.workOrders?.length) {
          const openWo = dueDates.workOrders.find((wo) => !isTerminalOrderStatus(wo?.status));
          if (openWo) {
            findings.push({
              rowIndex,
              ruleCode: 'PAST_DUE_OPEN_ORDER',
              severity: 'critical',
              detail:
                `Work order ${issue.workOrderNumber} for item ${issue.item ?? 'unknown'} ` +
                `was due ${due} (as of ${asOf}) and is still open (status: ${openWo.status ?? 'unknown'})`,
            });
          }
        }
      }
    }

    // --- LATE_INBOUND_SUPPLY (high) -------------------------------------
    // An open PO that is supposed to cover this demand is itself promised
    // after the demand's due date. The plan says "covered"; the calendar
    // says the coverage arrives late. One finding per late PO.
    {
      const due = normalizeDateToISO(issue.dueDate);
      const pos = supply?.openPOs ?? [];
      if (due && !supply?.error && pos.length > 0) {
        for (const po of pos) {
          const promised = normalizeDateToISO(po?.promisedDate);
          if (!promised) continue;
          if (promised > due) {
            findings.push({
              rowIndex,
              ruleCode: 'LATE_INBOUND_SUPPLY',
              severity: 'high',
              detail:
                `PO ${po?.poNumber ?? 'unknown'} for item ${issue.item ?? supply?.item ?? 'unknown'} ` +
                `is promised ${promised}, after the demand due date ${due}`,
            });
          }
        }
      }
    }

    // --- MATERIAL_SHORTAGE (high) ---------------------------------------
    // Available-to-promise is below the required quantity and inbound
    // purchase orders do not close the gap. Fires only when both the
    // requirement (issue quantity) and the evidence (ATP + open POs) are
    // present — a missing quantity or missing availability skips the rule.
    {
      const required = toNumber(issue.quantity);
      const availability = !supply?.error ? supply?.availability : undefined;
      if (required !== undefined && required > 0 && availability) {
        let atp = toNumber(availability.available);
        if (atp === undefined) {
          const onHand = toNumber(availability.onHand);
          const allocated = toNumber(availability.allocated);
          if (onHand !== undefined && allocated !== undefined) atp = onHand - allocated;
        }
        if (atp !== undefined && atp < required) {
          const shortfall = required - atp;
          let inbound = 0;
          for (const po of supply?.openPOs ?? []) {
            const ordered = toNumber(po?.quantityOrdered) ?? 0;
            const received = toNumber(po?.quantityReceived) ?? 0;
            inbound += Math.max(0, ordered - received);
          }
          if (inbound < shortfall) {
            findings.push({
              rowIndex,
              ruleCode: 'MATERIAL_SHORTAGE',
              severity: 'high',
              detail:
                `Item ${issue.item ?? supply?.item ?? 'unknown'}: ATP ${atp} ` +
                `is below required ${required}; inbound ${inbound} does not cover the shortfall of ${shortfall}`,
            });
          }
        }
      }
    }

    // --- UNCOVERED_DEMAND (medium) ---------------------------------------
    // A confirmed demand record (sales order fetched) whose item has no
    // supply records at all — the adapter returned no availability, or the
    // lookup errored. Distinct from MATERIAL_SHORTAGE: there the item is
    // known and short; here there is nothing to even measure against.
    {
      const hasDemandRef = issue.orderNumber !== undefined || issue.customerNumber !== undefined;
      if (hasDemandRef && demand && !demand.error && demand.salesOrder !== undefined) {
        const noSupplyRecords = !supply || supply.error !== undefined || supply.availability === undefined;
        if (noSupplyRecords) {
          findings.push({
            rowIndex,
            ruleCode: 'UNCOVERED_DEMAND',
            severity: 'medium',
            detail:
              `Demand on ${issue.orderNumber ?? issue.customerNumber} ` +
              `has no supply records for item ${issue.item ?? supply?.item ?? 'unknown'}`,
          });
        }
      }
    }

    // --- EXCESS_SUPPLY (low) --------------------------------------------
    // On-hand exceeds 3x the open demand quantity. Not a fire — flagged for
    // review (overstock, mis-allocated demand, or demand booked against the
    // wrong site). Low severity by design: the planner decides whether it
    // matters.
    {
      const required = toNumber(issue.quantity);
      const availability = !supply?.error ? supply?.availability : undefined;
      const onHand = availability ? toNumber(availability.onHand) : undefined;
      if (required !== undefined && required > 0 && onHand !== undefined && onHand > 3 * required) {
        findings.push({
          rowIndex,
          ruleCode: 'EXCESS_SUPPLY',
          severity: 'low',
          detail:
            `Item ${issue.item ?? supply?.item ?? 'unknown'}: on-hand ${onHand} ` +
            `exceeds 3x open demand ${required} — review for overstock`,
        });
      }
    }
  });

  return findings;
}
