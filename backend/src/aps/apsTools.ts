/**
 * apsTools.ts — deterministic tool substrate for the APS exception-resolution
 * flow (upload report → parse → normalize → collect supply/demand/due-date
 * evidence → deterministic rules → snapshot → verify → close).
 *
 * These tools are the non-LLM spine of the flow: parsing, normalization,
 * evidence collection, and the rules engine are deterministic and auditable.
 * The agent steps (classify, root-cause, recommend) call an LLM and live in
 * the flow definition, not here.
 *
 * Permissions:
 *   - aps.parseExceptionReport → 'document:read' (reads the uploaded xlsx)
 *   - everything else          → 'syteline:read' (SyteLine evidence + issue store)
 * All tools are read-classified for PUBLIC..PROPRIETARY (CUI/UNKNOWN stay
 * excluded; UNKNOWN fails closed in authorizeTool).
 *
 * Security notes:
 *   - No secrets in logs. Errors via Errors.* with client-safe messages.
 *   - Tenant comes from ctx.auth.tenantId — never from model parameters.
 *   - Windows-compatible: no shell-outs anywhere.
 */

import ExcelJS from 'exceljs';
import { z } from 'zod';
import { Errors } from '../errors.js';
import { getDb } from '../db/mongo.js';
import { s3Storage } from '../storage/storage.js';
import { getSyteLineAdapter } from '../tools/syteline.js';
import type { ToolDefinition } from '../tools/gateway.js';
import type { Classification } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import {
  applyRules as applyApsRules,
  normalizeDateToISO,
  type ApsFinding,
  type DemandFact,
  type DueDateFact,
  type NormalizedIssue,
  type SupplyFact,
} from './rules.js';
import { closeIssue, getIssue, recordSnapshot } from './issues.js';

const APS_CLASSIFICATIONS: Classification[] = ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY'];

/** Identifier shapes mirrored from the gateway's SyteLine conventions. */
const apsSiteId = () => z.string().trim().min(1).max(40).regex(/^[A-Za-z0-9_-]+$/);
const apsDocumentId = () => z.string().trim().min(1).max(120);
const apsIssueId = () => z.string().trim().min(1).max(120);

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/** parseExceptionReport row cap: beyond this the report must be split before upload. */
const PARSE_ROW_LIMIT = 5000;
/** normalizeExceptionRows issue cap: beyond this the agent works the first 200 and is told to truncate. */
const NORMALIZE_ISSUE_LIMIT = 200;
/** Hard bound on parsed columns so a pathological sheet cannot blow up memory. */
const PARSE_COLUMN_LIMIT = 100;

// ---------------------------------------------------------------------------
// Shared zod schemas (strict everywhere; nested adapter payloads tolerate
// extra keys via catchall so strict top-level validation never rejects the
// adapter's own passthrough fields).
// ---------------------------------------------------------------------------

const normalizedIssueSchema = z
  .object({
    rowIndex: z.number().int().nonnegative().optional(),
    item: z.string().trim().min(1).max(80).optional(),
    orderNumber: z.string().trim().min(1).max(40).optional(),
    customerNumber: z.string().trim().min(1).max(40).optional(),
    workOrderNumber: z.string().trim().min(1).max(40).optional(),
    dueDate: z.string().trim().min(1).max(40).optional(),
    quantity: z.number().finite().optional(),
    exceptionText: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

const supplyFactSchema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    item: z.string().optional(),
    availability: z
      .object({
        onHand: z.number().optional(),
        allocated: z.number().optional(),
        available: z.number().optional(),
      })
      .catchall(z.unknown())
      .optional(),
    openPOs: z
      .array(
        z
          .object({
            poNumber: z.string().optional(),
            promisedDate: z.string().optional(),
            quantityOrdered: z.number().optional(),
            quantityReceived: z.number().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    error: z.string().optional(),
  })
  .strict();

const demandFactSchema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    orderNumber: z.string().optional(),
    customerNumber: z.string().optional(),
    salesOrder: z.unknown().optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

const dueDateFactSchema = z
  .object({
    rowIndex: z.number().int().nonnegative(),
    workOrders: z
      .array(
        z
          .object({
            workOrderNumber: z.string().optional(),
            status: z.string().optional(),
            scheduledComplete: z.string().optional(),
          })
          .catchall(z.unknown()),
      )
      .optional(),
    note: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Excel parsing (aps.parseExceptionReport)
// ---------------------------------------------------------------------------

/** Convert an ExcelJS cell value to JSON-safe data. Rich text → text, formulas → their result, Dates → ISO. */
function cellToJsonValue(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.richText)) {
      return record.richText
        .map((part) => String((part as { text?: unknown } | null)?.text ?? ''))
        .join('');
    }
    if (typeof record.text === 'string') return record.text;
    if ('result' in record) return cellToJsonValue(record.result); // formula cell
    return null;
  }
  return null;
}

function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  return true;
}

// ---------------------------------------------------------------------------
// Header normalization (aps.normalizeExceptionRows)
//
// Header mapping (case-insensitive; headers are lowercased, spaces/hyphens
// folded to underscores, other punctuation stripped before lookup):
//   item            <- item | item_number | part_number
//   orderNumber     <- order | order_no | order_number
//   customerNumber  <- customer | customer_no
//   workOrderNumber <- work_order | wo | work_order_number
//   dueDate         <- due_date | date_due | due            (YYYY-MM-DD when parseable)
//   quantity        <- qty | quantity                        (number)
//   exceptionText   <- exception | message | exception_message
// Rows with no mapped values at all are dropped as fully-empty.
// ---------------------------------------------------------------------------

const HEADER_ALIASES: Record<string, keyof NormalizedIssue> = {
  item: 'item',
  item_number: 'item',
  part_number: 'item',
  order: 'orderNumber',
  order_no: 'orderNumber',
  order_number: 'orderNumber',
  customer: 'customerNumber',
  customer_no: 'customerNumber',
  work_order: 'workOrderNumber',
  wo: 'workOrderNumber',
  work_order_number: 'workOrderNumber',
  due_date: 'dueDate',
  date_due: 'dueDate',
  due: 'dueDate',
  qty: 'quantity',
  quantity: 'quantity',
  exception: 'exceptionText',
  message: 'exceptionText',
  exception_message: 'exceptionText',
};

function normalizeHeaderName(header: unknown): string {
  return String(header ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

/** Coerce a cell to a trimmed non-empty string; numbers become their decimal form. */
function coerceText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Coerce a cell to a finite number; non-numeric values become undefined. */
function coerceNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * Normalize one parsed row object into a NormalizedIssue. Returns undefined
 * for fully-empty rows (no mapped field carried a value).
 */
function normalizeRow(row: Record<string, unknown>, rowIndex: number): NormalizedIssue | undefined {
  const issue: NormalizedIssue = { rowIndex };
  let populated = false;
  for (const [header, value] of Object.entries(row)) {
    const field = HEADER_ALIASES[normalizeHeaderName(header)];
    if (!field) continue;
    if (field === 'quantity') {
      const quantity = coerceNumber(value);
      if (quantity !== undefined) {
        issue.quantity = quantity;
        populated = true;
      }
      continue;
    }
    if (field === 'dueDate') {
      // Normalize to YYYY-MM-DD when parseable; keep the trimmed raw text
      // otherwise so the composite key still has something to match on.
      const iso = normalizeDateToISO(value);
      const text = iso ?? coerceText(value);
      if (text !== undefined) {
        issue.dueDate = text;
        populated = true;
      }
      continue;
    }
    const text = coerceText(value);
    if (text !== undefined) {
      (issue as Record<string, unknown>)[field] = text;
      populated = true;
    }
  }
  return populated ? issue : undefined;
}

// ---------------------------------------------------------------------------
// Snapshot comparison (aps.compareSnapshots)
// ---------------------------------------------------------------------------

/**
 * Composite match key for baseline→new issue matching: item, orderNumber,
 * workOrderNumber, dueDate — lowercased, missing/blank parts become ''.
 */
function buildIssueKey(issue: Record<string, unknown>): string {
  const parts = [issue.item, issue.orderNumber, issue.workOrderNumber, issue.dueDate];
  return parts
    .map((part) => {
      if (part === null || part === undefined) return '';
      const text = String(part).trim().toLowerCase();
      return text === '' ? '' : text;
    })
    .join('|');
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

type ParseReportInput = { documentId: string };
type NormalizeInput = { rows: unknown[] };
type CollectInput = { issues: NormalizedIssue[]; site: string };
type ApplyRulesInput = {
  issues: NormalizedIssue[];
  supplyFacts: SupplyFact[];
  demandFacts: DemandFact[];
  dueDateFacts: DueDateFact[];
  asOfDate?: string;
};
type RecordSnapshotInput = {
  issueId: string;
  reportDocumentId: string;
  site: string;
  issues: unknown[];
  classifications?: unknown;
  findings?: unknown;
  rootCause?: unknown;
  recommendation?: unknown;
  sytelineSteps?: unknown;
};
type CompareInput = { issueId: string; newIssues: NormalizedIssue[] };
type CloseIssueInput = { issueId: string; resolved: boolean };
type GetIssueInput = { issueId: string };

export const apsToolDefinitions: ToolDefinition<any>[] = [
  {
    name: 'aps.parseExceptionReport',
    description:
      'Parse an uploaded APS exception report (xlsx) into rows: fetches the ' +
      'document tenant-scoped from object storage, reads the first sheet, ' +
      'and returns the header columns plus row objects. Start of the ' +
      'exception pipeline; feed the rows into aps.normalizeExceptionRows.',
    action: 'read',
    destructive: false,
    permission: 'document:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z.object({ documentId: apsDocumentId() }).strict(),
    execute: async (input: ParseReportInput, ctx) => {
      const db = await getDb();
      const doc = await db
        .collection<{
          _id: string;
          tenantId: string;
          mimeType: string;
          objectKey: string;
          classification: Classification;
          deletedAt?: Date | null;
        }>('documents')
        .findOne({ _id: input.documentId, tenantId: ctx.auth.tenantId, deletedAt: null });
      if (!doc) {
        throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Exception report document not found');
      }
      // A document:read grant alone must not let a lower-cleared requester
      // exfiltrate a higher-classified report through the flow.
      assertClassificationAllowed(ctx.classification, doc.classification);
      if (doc.mimeType !== XLSX_MIME) {
        throw Errors.badRequest(
          'UNSUPPORTED_DOCUMENT_TYPE',
          'Exception reports must be xlsx workbooks',
        );
      }
      let bytes: Uint8Array;
      try {
        // NOTE: s3Storage is a const object (not a factory) — s3Storage.get(key).
        bytes = await s3Storage.get(doc.objectKey);
      } catch {
        throw Errors.badGateway('DOCUMENT_STORAGE_UNAVAILABLE', 'Could not read the exception report bytes');
      }
      let workbook: ExcelJS.Workbook;
      try {
        workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(Buffer.from(bytes));
      } catch {
        throw Errors.badRequest('INVALID_WORKBOOK', 'The exception report is not a readable xlsx workbook');
      }
      const sheet = workbook.worksheets[0];
      if (!sheet) {
        return { sheetName: '', columns: [] as string[], rows: [] as Record<string, unknown>[], rowCount: 0 };
      }
      const headerRow = sheet.getRow(1);
      const headerValues = (headerRow.values ?? []) as unknown[];
      const columns: string[] = [];
      for (let index = 1; index < headerValues.length && columns.length < PARSE_COLUMN_LIMIT; index += 1) {
        const text = cellToJsonValue(headerValues[index]);
        columns.push(typeof text === 'string' ? text : `column_${index}`);
      }
      const rows: Record<string, unknown>[] = [];
      sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
        if (rowNumber === 1) return; // header
        if (rows.length >= PARSE_ROW_LIMIT) {
          throw Errors.badRequest(
            'ROW_LIMIT_EXCEEDED',
            `Exception report exceeds the ${PARSE_ROW_LIMIT}-row limit; split it and re-upload`,
          );
        }
        const values = (row.values ?? []) as unknown[];
        const record: Record<string, unknown> = {};
        let hasContent = false;
        for (let index = 1; index < values.length && index <= columns.length; index += 1) {
          const column = columns[index - 1];
          if (column === undefined) continue;
          const value = cellToJsonValue(values[index]);
          record[column] = value;
          if (isNonEmpty(value)) hasContent = true;
        }
        if (hasContent) rows.push(record);
      });
      return { sheetName: sheet.name, columns, rows, rowCount: rows.length };
    },
  },
  {
    name: 'aps.normalizeExceptionRows',
    description:
      'Normalize parsed exception-report rows into structured issues: maps ' +
      'header aliases (case-insensitive) to item/orderNumber/customerNumber/' +
      'workOrderNumber/dueDate/quantity/exceptionText, normalizes due dates ' +
      'to YYYY-MM-DD when parseable, drops fully-empty rows. Caps at 200 ' +
      'issues (truncated=true beyond).',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z.object({ rows: z.array(z.unknown()).max(10000) }).strict(),
    execute: async (input: NormalizeInput) => {
      const issues: NormalizedIssue[] = [];
      let truncated = false;
      for (const raw of input.rows) {
        if (issues.length >= NORMALIZE_ISSUE_LIMIT) {
          truncated = true;
          break;
        }
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue;
        const issue = normalizeRow(raw as Record<string, unknown>, issues.length);
        if (issue) issues.push(issue);
      }
      return { issues, truncated };
    },
  },
  {
    name: 'aps.collectSupplyFacts',
    description:
      'Collect SyteLine supply evidence per issue row: for every issue with ' +
      'an item, fetch item availability (on-hand/allocated/ATP) and open ' +
      'purchase orders (promised dates, quantities). Sequential; a per-row ' +
      'failure is captured in the fact error field and never fails the batch.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    // Batch of sequential SyteLine lookups legitimately exceeds the default
    // 60s tool budget; the gateway enforces this per-tool deadline instead.
    timeoutMs: 300000,
    schema: z
      .object({
        issues: z.array(normalizedIssueSchema).max(200),
        site: apsSiteId(),
      })
      .strict(),
    execute: async (input: CollectInput, _ctx, signal) => {
      const adapter = getSyteLineAdapter();
      const facts: SupplyFact[] = [];
      for (let index = 0; index < input.issues.length; index += 1) {
        const issue = input.issues[index];
        if (!issue) continue;
        const rowIndex = issue.rowIndex ?? index;
        if (!issue.item) {
          facts.push({ rowIndex });
          continue;
        }
        try {
          const availability = await adapter.getItemAvailability({ item: issue.item, site: input.site }, signal);
          const purchaseOrders = await adapter.getOpenPurchaseOrders({ item: issue.item, site: input.site }, signal);
          facts.push({
            rowIndex,
            item: issue.item,
            availability: {
              onHand: availability.onHand,
              allocated: availability.allocated,
              available: availability.available,
            },
            openPOs: purchaseOrders.purchaseOrders.map((po) => ({
              poNumber: po.poNumber,
              promisedDate: po.promisedDate,
              quantityOrdered: po.quantityOrdered,
              quantityReceived: po.quantityReceived,
            })),
          });
        } catch (error) {
          // Per-row failure: capture, never fail the batch. The message is
          // the adapter's sanitized error — no secrets, no host details.
          facts.push({
            rowIndex,
            item: issue.item,
            error: error instanceof Error ? error.message : 'Supply lookup failed',
          });
        }
      }
      return { facts };
    },
  },
  {
    name: 'aps.collectDemandFacts',
    description:
      'Collect SyteLine demand evidence per issue row: look up the sales ' +
      'order by orderNumber, or list open orders for a customerNumber. Rows ' +
      'with no order reference get note "no-order-reference". Per-row ' +
      'failures are captured in the fact error field.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issues: z.array(normalizedIssueSchema).max(200),
        site: apsSiteId(),
      })
      .strict(),
    execute: async (input: CollectInput, _ctx, signal) => {
      const adapter = getSyteLineAdapter();
      const facts: DemandFact[] = [];
      for (let index = 0; index < input.issues.length; index += 1) {
        const issue = input.issues[index];
        if (!issue) continue;
        const rowIndex = issue.rowIndex ?? index;
        try {
          if (issue.orderNumber) {
            const salesOrder = await adapter.getSalesOrder({ orderNumber: issue.orderNumber }, signal);
            facts.push({ rowIndex, orderNumber: issue.orderNumber, salesOrder });
          } else if (issue.customerNumber) {
            const salesOrder = await adapter.getSalesOrder(
              { customerNumber: issue.customerNumber, status: 'open' },
              signal,
            );
            facts.push({ rowIndex, customerNumber: issue.customerNumber, salesOrder });
          } else {
            facts.push({ rowIndex, note: 'no-order-reference' });
          }
        } catch (error) {
          facts.push({
            rowIndex,
            ...(issue.orderNumber ? { orderNumber: issue.orderNumber } : {}),
            ...(issue.customerNumber ? { customerNumber: issue.customerNumber } : {}),
            error: error instanceof Error ? error.message : 'Demand lookup failed',
          });
        }
      }
      return { facts };
    },
  },
  {
    name: 'aps.evaluateDueDates',
    description:
      'Evaluate due-date evidence per issue row: look up work orders by ' +
      'workOrderNumber (or the work orders building an item) to get status ' +
      'and schedule dates. Rows with neither reference get a note. ' +
      'Per-row failures are captured in the fact error field.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issues: z.array(normalizedIssueSchema).max(200),
        site: apsSiteId(),
      })
      .strict(),
    execute: async (input: CollectInput, _ctx, signal) => {
      const adapter = getSyteLineAdapter();
      const facts: DueDateFact[] = [];
      for (let index = 0; index < input.issues.length; index += 1) {
        const issue = input.issues[index];
        if (!issue) continue;
        const rowIndex = issue.rowIndex ?? index;
        try {
          if (issue.workOrderNumber) {
            const result = await adapter.getWorkOrders({ workOrderNumber: issue.workOrderNumber }, signal);
            facts.push({
              rowIndex,
              workOrders: result.workOrders.map((wo) => ({
                workOrderNumber: wo.workOrderNumber,
                status: wo.status,
                scheduledComplete: wo.scheduledComplete,
              })),
            });
          } else if (issue.item) {
            const result = await adapter.getWorkOrders({ item: issue.item, site: input.site }, signal);
            facts.push({
              rowIndex,
              workOrders: result.workOrders.map((wo) => ({
                workOrderNumber: wo.workOrderNumber,
                status: wo.status,
                scheduledComplete: wo.scheduledComplete,
              })),
            });
          } else {
            facts.push({ rowIndex, note: 'no-work-order-or-item-reference' });
          }
        } catch (error) {
          facts.push({
            rowIndex,
            error: error instanceof Error ? error.message : 'Due-date lookup failed',
          });
        }
      }
      return { facts };
    },
  },
  {
    name: 'aps.applyRules',
    description:
      'Run the deterministic APS rules engine over normalized issues and ' +
      'collected facts: PAST_DUE_OPEN_ORDER, LATE_INBOUND_SUPPLY, ' +
      'MATERIAL_SHORTAGE, UNCOVERED_DEMAND, EXCESS_SUPPLY. Pure and ' +
      'reproducible — asOfDate defaults to today (UTC); pass it explicitly ' +
      'for reproducible runs. Returns findings with severity and detail.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issues: z.array(normalizedIssueSchema).max(200),
        supplyFacts: z.array(supplyFactSchema).max(200),
        demandFacts: z.array(demandFactSchema).max(200),
        dueDateFacts: z.array(dueDateFactSchema).max(200),
        asOfDate: z
          .string()
          .trim()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      })
      .strict(),
    execute: async (input: ApplyRulesInput) => {
      const asOfDate = input.asOfDate ?? new Date().toISOString().slice(0, 10);
      const findings: ApsFinding[] = applyApsRules(
        input.issues,
        input.supplyFacts,
        input.demandFacts,
        input.dueDateFacts,
        asOfDate,
      );
      return { findings };
    },
  },
  {
    name: 'aps.recordSnapshot',
    description:
      'Record a pipeline pass as a snapshot on an APS issue. Empty issueId ' +
      'creates a new open issue; otherwise the snapshot is appended to the ' +
      'existing open issue (ISSUE_NOT_FOUND / ISSUE_CLOSED when not ' +
      'applicable). Returns the issue id, snapshot id, and a rollup summary.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issueId: z.string().trim().max(120).default(''),
        reportDocumentId: apsDocumentId(),
        site: apsSiteId(),
        issues: z.array(z.unknown()).max(2000),
        classifications: z.unknown().optional(),
        findings: z.unknown().optional(),
        rootCause: z.unknown().optional(),
        recommendation: z.unknown().optional(),
        sytelineSteps: z.unknown().optional(),
      })
      .strict(),
    execute: async (input: RecordSnapshotInput, ctx) => {
      return recordSnapshot(ctx.auth.tenantId, input);
    },
  },
  {
    name: 'aps.compareSnapshots',
    description:
      'Compare the latest snapshot of an APS issue against a new exception ' +
      'report (the verify loop): baseline issues are matched to new issues ' +
      'by composite key item|orderNumber|workOrderNumber|dueDate ' +
      '(lowercased, blanks as empty string). resolved is true when every ' +
      'baseline key is absent from the new report.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issueId: apsIssueId(),
        newIssues: z.array(normalizedIssueSchema).max(2000),
      })
      .strict(),
    execute: async (input: CompareInput, ctx) => {
      const issue = await getIssue(ctx.auth.tenantId, input.issueId);
      if (!issue) {
        throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
      }
      const latest = issue.snapshots[issue.snapshots.length - 1] ?? null;
      const baselineRows = (latest?.issues ?? []) as Record<string, unknown>[];
      const baselineKeys = new Set(baselineRows.map(buildIssueKey));
      const newKeys = new Set(
        input.newIssues.map((row) => buildIssueKey(row as unknown as Record<string, unknown>)),
      );
      // "Unresolved" = baseline exceptions still present in the new report
      // (still open). "Resolved" = baseline keys gone from the new report.
      // resolved is true when nothing from the baseline is still open.
      const unresolvedKeys = [...baselineKeys].filter((key) => newKeys.has(key));
      const resolvedKeys = [...baselineKeys].filter((key) => !newKeys.has(key));
      const unresolvedCount = unresolvedKeys.length;
      return {
        resolved: unresolvedCount === 0,
        resolvedCount: resolvedKeys.length,
        unresolvedCount,
        totalBaseline: baselineRows.length,
        totalNew: input.newIssues.length,
        baselineSnapshotId: latest?.snapshotId ?? null,
        details: {
          unresolvedKeys,
          newKeys: [...newKeys].filter((key) => !baselineKeys.has(key)),
        },
      };
    },
  },
  {
    name: 'aps.closeIssue',
    description:
      'Close an APS issue after the verify loop resolves it. resolved=false ' +
      'is a deliberate no-op (no state change, closed:false): the verify ' +
      'flow runner falls through to this tool after the re-analyze branch, ' +
      'so the tool must be fall-through-safe and never close an unresolved ' +
      'issue by accident.',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z
      .object({
        issueId: apsIssueId(),
        resolved: z.boolean(),
      })
      .strict(),
    execute: async (input: CloseIssueInput, ctx) => {
      if (!input.resolved) {
        // INTENTIONAL fall-through-safe no-op: the verify flow calls this
        // tool unconditionally after the compare step; an unresolved issue
        // must keep flowing to re-analysis, never be closed by the runner's
        // control flow.
        return {
          issueId: input.issueId,
          closed: false,
          note: 'resolved=false: no state change; the verify loop continues to re-analysis',
        };
      }
      const issue = await closeIssue(ctx.auth.tenantId, input.issueId);
      return { issueId: issue._id, closed: issue.status === 'closed' };
    },
  },
  {
    name: 'aps.getIssue',
    description:
      'Read an APS issue: status, site, snapshot count, and the latest ' +
      'snapshot (its normalized issues plus the analysis fields recorded ' +
      'for that pass).',
    action: 'read',
    destructive: false,
    permission: 'syteline:read',
    allowedClassifications: APS_CLASSIFICATIONS,
    schema: z.object({ issueId: apsIssueId() }).strict(),
    execute: async (input: GetIssueInput, ctx) => {
      const issue = await getIssue(ctx.auth.tenantId, input.issueId);
      if (!issue) {
        throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
      }
      const latest = issue.snapshots[issue.snapshots.length - 1] ?? null;
      return {
        issueId: issue._id,
        status: issue.status,
        site: issue.site,
        snapshotCount: issue.snapshots.length,
        latestSnapshot: latest,
      };
    },
  },
];
