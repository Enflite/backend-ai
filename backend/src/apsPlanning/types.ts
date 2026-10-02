/**
 * types.ts — data model and request validation for the APS Planning Agent
 * product surface (`/api/v1/aps/*`).
 *
 * V1 scope (assessment §6/§10): ONE export type (Exception Report), FIVE
 * exception types, read-only vs SyteLine. The deterministic pipeline
 * (rules engine, issue store, flows) is owned by the sibling coordinator
 * and is NOT rebuilt here — the shapes below that mirror the sibling's
 * are labeled as contract copies; see docs/aps-planning-agent/contracts.md
 * for the seam and the rebase plan.
 *
 * Analysis lifecycle:
 *   intake → analyzing → awaiting-planner → verifying → resolved | still-open
 *                                        ↘ blocked (flow failed)
 *   intake → pending-substrate (the aps-exception-analysis flow is not
 *            published on this tenant yet — the sibling's work has not
 *            landed; the analysis waits honestly instead of pretending)
 *   (any non-terminal) → cancelled
 */

import { z } from 'zod';
import { APS_PLANNING_VERSION, PRODUCT_NAME } from './version.js';

// ---------------------------------------------------------------------------
// V1 vocabulary
// ---------------------------------------------------------------------------

/** The five V1 exception types (assessment §6). */
export const EXCEPTION_TYPES = [
  'MOVE_IN_RCPT',
  'MOVE_OUT_RCPT',
  'RCPT_NOT_NEEDED',
  'RCPT_PROJECTED_LATE',
  'EXPEDITED_N_DAYS',
] as const;

export type ExceptionType = (typeof EXCEPTION_TYPES)[number];

/** Human labels for the five exception types (as they appear in SyteLine). */
export const EXCEPTION_TYPE_LABELS: Record<ExceptionType, string> = {
  MOVE_IN_RCPT: 'Move In Rcpt',
  MOVE_OUT_RCPT: 'Move Out Rcpt',
  RCPT_NOT_NEEDED: 'Rcpt Not Needed',
  RCPT_PROJECTED_LATE: 'Rcpt Projected Late',
  EXPEDITED_N_DAYS: 'Expedited N Days',
};

export const EXPORT_TYPES = ['EXCEPTION_REPORT'] as const;
export type ExportType = (typeof EXPORT_TYPES)[number];

export const ANALYSIS_STATUSES = [
  'intake',
  'pending-substrate',
  'analyzing',
  'awaiting-planner',
  'verifying',
  'resolved',
  'still-open',
  'blocked',
  'cancelled',
] as const;

export type AnalysisStatus = (typeof ANALYSIS_STATUSES)[number];

export const TERMINAL_ANALYSIS_STATUSES: readonly AnalysisStatus[] = [
  'resolved',
  'still-open',
  'blocked',
  'cancelled',
];

export const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type Severity = (typeof SEVERITIES)[number];

/** Severity rank for worsened/still-open comparison (higher = worse). */
export const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/** Cross-snapshot verdicts for one planning row. */
export const COMPARISON_VERDICTS = ['resolved', 'still-open', 'worsened', 'new'] as const;
export type ComparisonVerdict = (typeof COMPARISON_VERDICTS)[number];

// ---------------------------------------------------------------------------
// Planning rows (normalized exception rows)
//
// Structural superset of the sibling's normalized rows: the sibling's
// aps.normalizeExceptionRows emits { rowIndex, item, orderNumber,
// customerNumber, workOrderNumber, dueDate, quantity, exceptionText }.
// The product module additionally understands type / supplyId / demandId
// when present (the stable identity key below prefers them).
// ---------------------------------------------------------------------------

export const planningRowSchema = z
  .object({
    rowIndex: z.number().int().nonnegative().optional(),
    type: z.enum(EXCEPTION_TYPES).optional(),
    item: z.string().trim().min(1).max(80).optional(),
    /** Supplying record: PO number, job number, or PLN order. */
    supplyId: z.string().trim().min(1).max(40).optional(),
    /** Demanding record: customer-order line, job operation, etc. */
    demandId: z.string().trim().min(1).max(40).optional(),
    orderNumber: z.string().trim().min(1).max(40).optional(),
    workOrderNumber: z.string().trim().min(1).max(40).optional(),
    dueDate: z.string().trim().min(1).max(40).optional(),
    quantity: z.number().finite().optional(),
    severity: z.enum(SEVERITIES).optional(),
    exceptionText: z.string().trim().min(1).max(2000).optional(),
    /** The deterministic facts the rule fired on. */
    evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  })
  .catchall(z.unknown());

export type PlanningRow = z.infer<typeof planningRowSchema>;

/** Tolerantly coerce a sibling snapshot row into a PlanningRow (never throws). */
export function toPlanningRow(raw: unknown): PlanningRow {
  if (raw && typeof raw === 'object') {
    const parsed = planningRowSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return raw as PlanningRow;
  }
  return {};
}

function keyPart(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = String(value).trim().toLowerCase();
  return text === '' ? '' : text;
}

/**
 * Stable identity key for one planning row across snapshots.
 *
 * Primary: `type|item|supplyId|demandId` (lowercased, blanks kept as
 * empty segments so two rows that are both blank in a segment still
 * match on the segments that ARE populated).
 *
 * Documented fallback chain (assessment risk #2 — key fragility):
 *  1. primary key when at least TWO of the four segments are non-empty;
 *  2. the sibling's composite key `item|orderNumber|workOrderNumber|dueDate`
 *     (the key aps.compareSnapshots uses — same normalization);
 *  3. `rowIndex` when nothing else identifies the row (positional, weakest).
 *
 * A fully-empty row yields the empty key: callers must treat it as
 * unmatchable (it can neither resolve nor reopen anything).
 */
export function issueIdentityKey(row: PlanningRow): string {
  const primary = [row.type, row.item, row.supplyId, row.demandId].map(keyPart);
  if (primary.filter((p) => p !== '').length >= 2) return primary.join('|');
  const siblingKey = [row.item, row.orderNumber, row.workOrderNumber, row.dueDate].map(keyPart).join('|');
  if (siblingKey.replace(/\|/g, '') !== '') return `sibling:${siblingKey}`;
  if (row.rowIndex !== undefined) return `row:${row.rowIndex}`;
  return '';
}

/** One row's verdict in a cross-snapshot comparison. */
export const rowVerdictSchema = z.object({
  key: z.string(),
  verdict: z.enum(COMPARISON_VERDICTS),
  baseRow: planningRowSchema.optional(),
  otherRow: planningRowSchema.optional(),
  /** Why this verdict: severity change, evidence diff, or key absence. */
  reason: z.string().max(500),
});

export type RowVerdict = z.infer<typeof rowVerdictSchema>;

export const snapshotComparisonSchema = z.object({
  baseSnapshotId: z.string(),
  otherSnapshotId: z.string(),
  rows: z.array(rowVerdictSchema),
  summary: z.object({
    resolved: z.number().int().nonnegative(),
    stillOpen: z.number().int().nonnegative(),
    worsened: z.number().int().nonnegative(),
    new: z.number().int().nonnegative(),
  }),
});

export type SnapshotComparison = z.infer<typeof snapshotComparisonSchema>;

function numericEvidence(row: PlanningRow | undefined, field: string): number | null {
  const value = row?.evidence?.[field];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Compare two snapshots row-by-row (pure, deterministic, unit-tested).
 *
 * Matching uses issueIdentityKey; rows with an empty key are unmatchable
 * and are reported as `new` (other-only) — never silently dropped.
 * - base-only key → `resolved`
 * - other-only key → `new`
 * - both → `still-open`, or `worsened` when the severity rank rose or a
 *   numeric `daysLate` evidence field grew (the two deterministic
 *   worsening signals V1 understands).
 */
export function compareSnapshots(
  baseSnapshotId: string,
  otherSnapshotId: string,
  baseRows: PlanningRow[],
  otherRows: PlanningRow[],
): SnapshotComparison {
  const baseByKey = new Map<string, PlanningRow>();
  for (const row of baseRows) {
    const key = issueIdentityKey(row);
    if (key !== '' && !baseByKey.has(key)) baseByKey.set(key, row);
  }
  const otherByKey = new Map<string, PlanningRow>();
  for (const row of otherRows) {
    const key = issueIdentityKey(row);
    if (key !== '' && !otherByKey.has(key)) otherByKey.set(key, row);
  }

  const rows: RowVerdict[] = [];
  for (const [key, baseRow] of baseByKey) {
    const otherRow = otherByKey.get(key);
    if (!otherRow) {
      rows.push({
        key,
        verdict: 'resolved',
        baseRow,
        reason: 'Row identity absent from the newer snapshot',
      });
      continue;
    }
    const baseRank = baseRow.severity !== undefined ? SEVERITY_RANK[baseRow.severity] : null;
    const otherRank = otherRow.severity !== undefined ? SEVERITY_RANK[otherRow.severity] : null;
    const baseLate = numericEvidence(baseRow, 'daysLate');
    const otherLate = numericEvidence(otherRow, 'daysLate');
    const worsened =
      (baseRank !== null && otherRank !== null && otherRank > baseRank) ||
      (baseLate !== null && otherLate !== null && otherLate > baseLate);
    rows.push({
      key,
      verdict: worsened ? 'worsened' : 'still-open',
      baseRow,
      otherRow,
      reason: worsened
        ? 'Severity rank rose or daysLate grew between snapshots'
        : 'Row identity present in both snapshots with no worsening signal',
    });
  }
  for (const [key, otherRow] of otherByKey) {
    if (!baseByKey.has(key)) {
      rows.push({ key, verdict: 'new', otherRow, reason: 'Row identity absent from the baseline snapshot' });
    }
  }
  // Unmatchable other-rows (empty key): surfaced as `new`, never dropped.
  for (const row of otherRows) {
    if (issueIdentityKey(row) === '') {
      rows.push({ key: '', verdict: 'new', otherRow: row, reason: 'Row has no stable identity; cannot be matched' });
    }
  }

  const summary = {
    resolved: rows.filter((r) => r.verdict === 'resolved').length,
    stillOpen: rows.filter((r) => r.verdict === 'still-open').length,
    worsened: rows.filter((r) => r.verdict === 'worsened').length,
    new: rows.filter((r) => r.verdict === 'new').length,
  };
  return { baseSnapshotId, otherSnapshotId, rows, summary };
}

// ---------------------------------------------------------------------------
// Agent judgment outputs (explain / correlate / prioritize / recommend)
// ---------------------------------------------------------------------------

/** The deterministic facts a rule fired on. */
export const evidenceSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
export type Evidence = z.infer<typeof evidenceSchema>;

export const rootCauseSchema = z.object({
  category: z.enum(['supplier', 'capacity', 'planning-parameter', 'data', 'unknown']),
  confidence: z.enum(['high', 'medium', 'low']),
  reasoning: z.string().trim().min(1).max(2000),
});
export type RootCause = z.infer<typeof rootCauseSchema>;

export const recommendationSchema = z.object({
  action: z.string().trim().min(1).max(1000),
  priority: z.enum(['p0', 'p1', 'p2']),
  expectedImpact: z.string().trim().min(1).max(1000),
});
export type Recommendation = z.infer<typeof recommendationSchema>;

/**
 * SyteLine procedure guidance. `verified` is false by default: anything
 * not sourced from validated documentation ships with `needsConfirmation`
 * text naming exactly what the planner must confirm in their SyteLine
 * client. The module NEVER invents a form, tab, field, button, or
 * workflow — see procedures.ts.
 */
export const sytelineProcedureSchema = z.object({
  /** SyteLine form name, when the step is grounded in known procedure. */
  form: z.string().trim().min(1).max(80).optional(),
  steps: z.array(z.string().trim().min(1).max(1000)).min(1).max(20),
  verified: z.boolean(),
  needsConfirmation: z.string().trim().min(1).max(1000).optional(),
});
export type SyteLineProcedure = z.infer<typeof sytelineProcedureSchema>;

// ---------------------------------------------------------------------------
// Column mapping (assessment risk #1: Excel layout variance)
//
// The Exception Report layout differs by SyteLine version/site, so the
// module never hardcodes headers: it maps CANONICAL_COLUMNS to the
// workbook's actual headers, confirmed per upload. Only `item` and
// `exceptionText` are required for a usable map (identity + the exception
// message the five types are classified from); everything else is
// optional enrichment.
// ---------------------------------------------------------------------------

export const CANONICAL_COLUMNS = [
  'type',
  'item',
  'supplyId',
  'demandId',
  'orderNumber',
  'workOrderNumber',
  'dueDate',
  'quantity',
  'exceptionText',
  'severity',
] as const;

export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

/** Canonical columns the module needs to do anything useful. */
export const REQUIRED_CANONICAL_COLUMNS: readonly CanonicalColumn[] = ['item', 'exceptionText'];

export const columnMapSchema = z
  .object({
    /** Canonical column name → actual header cell in the uploaded workbook. */
    columns: z.record(z.string(), z.string().trim().min(1).max(200)),
    /** The planner confirmed (or overrode) the detected mapping. */
    confirmed: z.boolean(),
  })
  .strict()
  .refine(
    (map) => REQUIRED_CANONICAL_COLUMNS.every((c) => map.columns[c] !== undefined),
    { message: `Column map must include: ${REQUIRED_CANONICAL_COLUMNS.join(', ')}` },
  );

export type ColumnMap = z.infer<typeof columnMapSchema>;

// ---------------------------------------------------------------------------
// Snapshot — API shape for the /aps/snapshots endpoints.
//
// Contract copy of the sibling's ApsSnapshot (backend/src/aps/issues.ts,
// unlanded): { snapshotId, createdAt, issues, classifications?,
// findings?, rootCause?, recommendation?, sytelineSteps? }. This module
// reads these through the substrate seam; it never writes them.
// ---------------------------------------------------------------------------

export const snapshotSchema = z.object({
  snapshotId: z.string().min(1).max(120),
  createdAt: z.string(),
  issues: z.array(planningRowSchema),
  classifications: z.unknown().optional(),
  findings: z.unknown().optional(),
  rootCause: z.unknown().optional(),
  recommendation: z.unknown().optional(),
  sytelineSteps: z.unknown().optional(),
});

export type Snapshot = z.infer<typeof snapshotSchema>;

// ---------------------------------------------------------------------------
// Analysis (the `aps_analyses` document)
// ---------------------------------------------------------------------------

const analysisIdParam = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, 'id must be a 1-64 char identifier');

export const createAnalysisInput = z
  .object({
    /** Document id of an already-uploaded exception report (documents pipeline). */
    documentId: z.string().trim().min(1).max(120).optional(),
    /** SyteLine site the report and all lookups apply to. */
    site: z.string().trim().min(1).max(40).optional(),
    /** Existing planning issue id to append this analysis to (verify path). */
    issueId: z.string().trim().min(1).max(120).optional(),
  })
  .strict()
  .refine((v) => v.documentId !== undefined || v.site !== undefined || v.issueId !== undefined, {
    message: 'Provide at least a documentId (JSON) or upload the workbook (multipart)',
  });

export type CreateAnalysisInput = z.infer<typeof createAnalysisInput>;

export interface ApsAnalysisDoc {
  _id: string;
  tenantId: string;
  requesterUserId: string;
  exportType: ExportType;
  sourceDocumentIds: string[];
  site?: string;
  status: AnalysisStatus;
  /** Human-readable status detail (e.g. why pending-substrate). */
  statusNote?: string;
  flowName?: string;
  flowRunId?: string;
  /** Planning issue id, set when the analysis flow records the issue. */
  issueId?: string;
  baselineSnapshotId?: string;
  columnMap?: { columns: Record<string, string>; confirmed: boolean; confirmedAt?: Date };
  /**
   * Internal retry-claim marker: set while a POST
   * /aps/analyses/:id/retry owns the pending-substrate → analyzing
   * transition. Never part of the public API views.
   */
  retryInFlight?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export const analysisIdParamSchema = z.object({ id: analysisIdParam }).strict();
export const snapshotIdParamSchema = z.object({ snapshotId: z.string().regex(/^[A-Za-z0-9_-]{1,120}$/) }).strict();

/** Issue id param (sibling's aps_issues docs are read through the substrate seam). */
export const issueIdParamSchema = z.object({ issueId: analysisIdParam }).strict();

// ---------------------------------------------------------------------------
// Issue-scoped agent judgment trigger
//
// The flow's four agent steps (classify, root-cause, recommendation,
// syteline-steps) are the pipeline's system of record. The standalone
// agentJudgment seam (agentJudgment.ts) explains, correlates, and
// prioritizes findings OUTSIDE a flow run — e.g. "what should I work on
// first?" over an already-recorded analysis. POST
// /aps/issues/:issueId/judgment is its REST trigger: schema-validated,
// aggregates-only (the privacy hard rule from agentJudgment.ts applies —
// prompts carry per-issue summaries, never full report rows).
// ---------------------------------------------------------------------------

/** The judgment kinds the standalone seam offers (the flow owns pipeline prompts). */
export const JUDGMENT_KINDS = ['explain', 'prioritize', 'recommend'] as const;
export type JudgmentKind = (typeof JUDGMENT_KINDS)[number];

/** Aggregate per-issue summary: the most detail a judgment prompt may carry. */
export const issueSummarySchema = z.object({
  id: z.string().max(120),
  type: z.string().max(40),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  item: z.string().max(80).optional(),
  daysLate: z.number().optional(),
});

export type IssueSummary = z.infer<typeof issueSummarySchema>;

/** POST /aps/issues/:issueId/judgment body. Omit `summaries` to derive them from the issue's latest recorded snapshot. */
export const apsJudgmentInputSchema = z
  .object({
    kind: z.enum(JUDGMENT_KINDS),
    summaries: z.array(issueSummarySchema).min(1).max(200).optional(),
  })
  .strict();

export type ApsJudgmentInput = z.infer<typeof apsJudgmentInputSchema>;

export const listAnalysesQuery = z
  .object({
    status: z.enum(ANALYSIS_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const compareSnapshotsQuery = z
  .object({
    base: z.string().trim().min(1).max(120),
    other: z.string().trim().min(1).max(120),
    /** Issue id the snapshots belong to (snapshots live inside issue docs). */
    issueId: z.string().trim().min(1).max(120).optional(),
  })
  .strict();

export const snapshotsQuery = z
  .object({
    /** Issue id: snapshots live inside the sibling's issue documents. */
    issueId: z.string().trim().min(1).max(120),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

/** Max bytes for one uploaded exception-report workbook (≤ 10 MB). */
export const MAX_REPORT_PART_BYTES = 10 * 1024 * 1024;

function iso(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

export function productInfo(): { name: string; version: string } {
  return { name: PRODUCT_NAME, version: APS_PLANNING_VERSION };
}

/** Public list item. */
export function publicAnalysisListItem(doc: ApsAnalysisDoc): Record<string, unknown> {
  return {
    id: doc._id,
    status: doc.status,
    exportType: doc.exportType,
    ...(doc.site ? { site: doc.site } : {}),
    ...(doc.issueId ? { issueId: doc.issueId } : {}),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

/** Public detail view: the full analysis record minus runner plumbing. */
export function publicAnalysisDetailView(doc: ApsAnalysisDoc): Record<string, unknown> {
  return {
    id: doc._id,
    status: doc.status,
    ...(doc.statusNote ? { statusNote: doc.statusNote } : {}),
    exportType: doc.exportType,
    sourceDocumentIds: doc.sourceDocumentIds,
    ...(doc.site ? { site: doc.site } : {}),
    ...(doc.flowName ? { flowName: doc.flowName } : {}),
    ...(doc.flowRunId ? { flowRunId: doc.flowRunId } : {}),
    ...(doc.issueId ? { issueId: doc.issueId } : {}),
    ...(doc.baselineSnapshotId ? { baselineSnapshotId: doc.baselineSnapshotId } : {}),
    ...(doc.columnMap
      ? {
          columnMap: {
            columns: doc.columnMap.columns,
            confirmed: doc.columnMap.confirmed,
            ...(doc.columnMap.confirmedAt ? { confirmedAt: iso(doc.columnMap.confirmedAt) } : {}),
          },
        }
      : {}),
    product: productInfo(),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}
