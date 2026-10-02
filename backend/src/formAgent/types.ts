/**
 * types.ts — data model, request validation, and input validators for the
 * SyteLine Form AI Agent product surface (`/api/v1/form-customizations`).
 *
 * A customization request carries exactly five inputs (ADR-021 §1a):
 *  1. the current form .XML (the TRN original — the rollback copy)
 *  2. IDO properties as a CSV
 *  3. SQL columns as a CSV
 *  4. the instruction list (the actual customization requirements)
 *  5. free-form context attachments for the AI
 *
 * The Form-Project-Templates SOP is NOT part of the request — it is baked
 * into the agent's planner knowledge pack (knowledge.ts).
 *
 * Lifecycle: requested → in_progress → awaiting_review → completed,
 * plus requested → in_progress → blocked, and (any non-terminal) →
 * cancelled. `awaiting_review` is the agent's terminal state; `completed`
 * is reached only when a human merges the review PR and records it.
 */

import { z } from 'zod';
import { Errors } from '../errors.js';
import { FORM_AGENT_VERSION, PRODUCT_NAME } from './version.js';

/** Lifecycle. Terminal agent state: awaiting_review. Human terminal state: completed. */
export const FORM_CUSTOMIZATION_STATUSES = [
  'requested',
  'in_progress',
  'awaiting_review',
  'completed',
  'blocked',
  'cancelled',
] as const;

export type FormCustomizationStatus = (typeof FORM_CUSTOMIZATION_STATUSES)[number];

export const TERMINAL_FORM_CUSTOMIZATION_STATUSES: readonly FormCustomizationStatus[] = [
  'awaiting_review',
  'completed',
  'blocked',
  'cancelled',
];

/**
 * Enumerated blocked reasons (ADR-021 §6 + operator guide). `blockedReason`
 * is the code; `blockedDetail` is the human-readable message.
 */
export const BLOCKED_REASONS = [
  'missing-current-form-xml',
  'missing-production-original',
  'trn-prd-drift',
  'missing-github-token',
  'invalid-requirements',
  'attachment-quarantined',
  'build-check-failed',
  'requester-lost-permission',
] as const;

export type BlockedReason = (typeof BLOCKED_REASONS)[number];

// ---------------------------------------------------------------------------
// Input size limits (operator guide: per-part table)
// ---------------------------------------------------------------------------

/** Max bytes for one inline (JSON) XML or CSV input. */
export const MAX_INLINE_INPUT_BYTES = 512 * 1024;
/** Max bytes for a form XML file part (≤ 10 MB per the guide). */
export const MAX_XML_PART_BYTES = 10 * 1024 * 1024;
/** Max bytes for a CSV file part (≤ 5 MB per the guide). */
export const MAX_CSV_PART_BYTES = 5 * 1024 * 1024;
/** Max attachments per request (0–20 per the guide). */
export const MAX_ATTACHMENTS = 20;
/** Max bytes per attachment (≤ 200 KB per the guide). */
export const MAX_ATTACHMENT_BYTES = 200 * 1024;
/** Max file parts per multipart request. */
export const MAX_MULTIPART_FILES = 4 + MAX_ATTACHMENTS;

// ---------------------------------------------------------------------------
// XML validation
// ---------------------------------------------------------------------------

/**
 * Assert that `text` is well-formed XML (balanced tags, single root).
 * Throws an Error with a user-facing message (no internal names).
 */
export function assertWellFormedXml(text: string): void {
  const what = 'form XML';
  let s = text;
  const strip = (start: string, end: string): void => {
    let idx = s.indexOf(start);
    while (idx >= 0) {
      const close = s.indexOf(end, idx + start.length);
      if (close < 0) throw new Error(`${what}: unterminated ${start} section — the XML is malformed`);
      s = s.slice(0, idx) + s.slice(close + end.length);
      idx = s.indexOf(start);
    }
  };
  strip('<!--', '-->');
  strip('<![CDATA[', ']]>');
  for (;;) {
    const idx = s.indexOf('<!DOCTYPE');
    if (idx < 0) break;
    let i = idx + '<!DOCTYPE'.length;
    let quote: string | null = null;
    while (i < s.length) {
      const ch = s[i]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      i += 1;
    }
    if (i >= s.length) throw new Error(`${what}: unterminated DOCTYPE — the XML is malformed`);
    s = s.slice(0, idx) + s.slice(i + 1);
  }
  strip('<?', '?>');

  const tagName = /[A-Za-z_][A-Za-z0-9_.:-]*/;
  const stack: string[] = [];
  let rootCount = 0;
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    if (lt < 0) break;
    let j = lt + 1;
    let quote: string | null = null;
    while (j < s.length) {
      const ch = s[j]!;
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '>') {
        break;
      }
      j += 1;
    }
    if (j >= s.length) throw new Error(`${what}: unterminated tag — the XML is malformed`);
    const raw = s.slice(lt + 1, j).trim();
    i = j + 1;
    if (raw.length === 0) throw new Error(`${what}: empty tag <> — the XML is malformed`);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim().split(/\s/, 1)[0]!;
      const open = stack.pop();
      if (open === undefined || open !== name) {
        throw new Error(`${what}: mismatched tags — the XML is malformed`);
      }
    } else if (raw.endsWith('/')) {
      const name = raw.slice(0, -1).trim().split(/\s/, 1)[0]!;
      if (!tagName.test(name)) throw new Error(`${what}: invalid tag name — the XML is malformed`);
      if (stack.length === 0) rootCount += 1;
    } else {
      const name = raw.split(/\s/, 1)[0]!;
      if (!tagName.test(name)) throw new Error(`${what}: invalid tag name — the XML is malformed`);
      if (stack.length === 0) rootCount += 1;
      stack.push(name);
    }
  }
  if (stack.length > 0) throw new Error(`${what}: unclosed tag <${stack[stack.length - 1]}> — the XML is malformed`);
  if (rootCount === 0) throw new Error(`${what}: no root element — the XML is malformed`);
  if (rootCount > 1) throw new Error(`${what}: more than one root element — the XML is malformed`);
}

/**
 * Extract the form name from the `<Form Name="...">` definition.
 * Returns null when the XML has no form definition.
 */
export function extractFormNameFromXml(text: string): string | null {
  const match = /<Form\b[^>]*\bName\s*=\s*"([^"]+)"/.exec(text);
  return match ? match[1]! : null;
}

/**
 * Validate the current form XML: well-formed, contains the form
 * definition, and the form name matches the request's `formName`.
 * Throws an Error with a user-facing message.
 */
export function validateFormXml(text: string, formName: string): void {
  assertWellFormedXml(text);
  const xmlFormName = extractFormNameFromXml(text);
  if (!xmlFormName) {
    throw new Error('form XML: no <Form Name="..."> definition found — supply the FormSync export');
  }
  if (xmlFormName !== formName) {
    throw new Error(
      `form XML: the form name in the XML ("${xmlFormName}") does not match the request's formName ("${formName}")`,
    );
  }
}

// ---------------------------------------------------------------------------
// CSV parsing + shape validation
// ---------------------------------------------------------------------------

export interface ParsedCsv {
  header: string[];
  rows: string[][];
  rowCount: number;
}

const MAX_CSV_ROWS = 20000;

/**
 * Minimal RFC-4180-style CSV parser (quoted fields, escaped quotes,
 * CRLF/LF). Throws an Error with a user-facing message on malformed
 * input. Never a silent partial parse.
 */
export function parseCsv(text: string, what: string): ParsedCsv {
  const rows: string[][] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  const pushField = (): void => {
    fields.push(field);
    field = '';
  };
  const pushRow = (): void => {
    pushField();
    rows.push(fields);
    fields = [];
    if (rows.length > MAX_CSV_ROWS + 1) {
      throw new Error(`${what}: too many rows (max ${MAX_CSV_ROWS})`);
    }
  };
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else {
        field += ch;
        i += 1;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i += 1;
    } else if (ch === ',') {
      pushField();
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      if (!(fields.length === 0 && field === '')) pushRow();
      else {
        fields = [];
        field = '';
      }
      i += 1;
    } else {
      field += ch;
      i += 1;
    }
  }
  if (inQuotes) throw new Error(`${what}: unterminated quoted field — the CSV is malformed`);
  if (fields.length > 0 || field !== '') pushRow();
  if (rows.length === 0) throw new Error(`${what}: the CSV is empty`);
  const header = rows[0]!;
  if (header.every((h) => h.trim() === '')) throw new Error(`${what}: the CSV has no header row`);
  const width = header.length;
  rows.slice(1).forEach((row, idx) => {
    if (row.length !== width) {
      throw new Error(`${what}: row ${idx + 2} has ${row.length} fields but the header has ${width}`);
    }
  });
  if (rows.length < 2) throw new Error(`${what}: the CSV has a header but no data rows`);
  return { header, rows: rows.slice(1), rowCount: rows.length - 1 };
}

/** Normalize a header cell: `Property Name` → `propertyname`. */
function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[\s_]+/g, '');
}

const NAME_LIKE = new Set(['name', 'property', 'propertyname', 'column', 'columnname']);

/**
 * The IDO properties CSV: UTF-8, header row whose FIRST column is
 * property-name-like, plus data rows.
 */
export function parseIdoPropertiesCsv(text: string): ParsedCsv {
  const parsed = parseCsv(text, 'IDO properties CSV');
  if (!NAME_LIKE.has(headerKey(parsed.header[0]!))) {
    throw new Error(
      'IDO properties CSV: the first header column must be property-name-like ' +
        `(name, property, ...) — got: ${parsed.header[0]}`,
    );
  }
  return parsed;
}

/**
 * The SQL columns CSV: UTF-8, header row whose FIRST column is
 * column-name-like, plus data rows.
 */
export function parseSqlColumnsCsv(text: string): ParsedCsv {
  const parsed = parseCsv(text, 'SQL columns CSV');
  if (!NAME_LIKE.has(headerKey(parsed.header[0]!))) {
    throw new Error(
      'SQL columns CSV: the first header column must be column-name-like ' +
        `(name, column, ...) — got: ${parsed.header[0]}`,
    );
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Request schemas (JSON body and assembled multipart share one schema)
// ---------------------------------------------------------------------------

const formNameSchema = z
  .string()
  .trim()
  .min(1, 'formName is required')
  .max(60)
  .regex(/^[A-Za-z0-9_]+$/, 'formName must match ^[A-Za-z0-9_]+$ (the SyteLine form name)');

const attachmentSchema = z
  .preprocess(
    (v) => {
      if (v && typeof v === 'object' && !('filename' in (v as object)) && 'name' in (v as object)) {
        const { name, ...rest } = v as { name: string } & Record<string, unknown>;
        return { filename: name, ...rest };
      }
      return v;
    },
    z
      .object({
        filename: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_][A-Za-z0-9_.\- ]*$/, 'filename may only contain letters, digits, and _ . - space'),
        /** Inline text content. */
        content: z.string().min(1).max(MAX_ATTACHMENT_BYTES).optional(),
        /** Base64-encoded content (alternative to content). */
        contentBase64: z.string().min(1).max(MAX_ATTACHMENT_BYTES * 2).optional(),
      })
      .strict()
      .refine((a) => a.content !== undefined || a.contentBase64 !== undefined, {
        message: 'attachment needs content or contentBase64',
      }),
  );

export interface ParsedAttachment {
  filename: string;
  bytes: Buffer;
}

/** Decode an attachment item to bytes. Throws on bad base64. */
export function decodeAttachment(item: {
  filename: string;
  content?: string;
  contentBase64?: string;
}): ParsedAttachment {
  const safeName = item.filename.split('/').pop()!.split('\\').pop()!;
  if (item.contentBase64 !== undefined) {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(item.contentBase64, 'base64');
    } catch {
      throw new Error(`attachment "${safeName}": contentBase64 is not valid base64`);
    }
    if (bytes.length === 0) throw new Error(`attachment "${safeName}": decoded content is empty`);
    if (bytes.length > MAX_ATTACHMENT_BYTES) {
      throw new Error(`attachment "${safeName}": decoded content exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
    }
    return { filename: safeName, bytes };
  }
  const bytes = Buffer.from(item.content ?? '', 'utf8');
  if (bytes.length === 0) throw new Error(`attachment "${safeName}": content is empty`);
  return { filename: safeName, bytes };
}

/**
 * The five request inputs. Both `application/json` and
 * `multipart/form-data` are assembled into this shape before validation.
 */
export const createCustomizationInput = z
  .object({
    /** SyteLine form name, e.g. `Incidents`. */
    formName: formNameSchema,
    /** Short title for the project and the review PR. */
    title: z.string().trim().min(1).max(200),
    /** Who asked (free text). */
    requestedBy: z.string().trim().min(1).max(200).optional(),
    /** Input 4: the actual customization requirements. */
    instructions: z
      .array(z.string().trim().min(1).max(500))
      .min(1, 'at least one instruction is required')
      .max(100),
    /** Input 1: the current form .XML — the TRN original. */
    formXml: z.string().min(1, 'formXml is required').max(MAX_INLINE_INPUT_BYTES),
    /** Input 2: IDO properties as a CSV. */
    idoPropertiesCsv: z.string().min(1, 'idoPropertiesCsv is required').max(MAX_INLINE_INPUT_BYTES),
    /** Input 3: SQL columns as a CSV. */
    sqlColumnsCsv: z.string().min(1, 'sqlColumnsCsv is required').max(MAX_INLINE_INPUT_BYTES),
    /** Input 5: free-form context files for the AI. */
    attachments: z.array(attachmentSchema).max(MAX_ATTACHMENTS).optional().default([]),
  })
  .strict();

export type CreateCustomizationInput = z.infer<typeof createCustomizationInput>;

export const listCustomizationsQuery = z
  .object({
    status: z.enum(FORM_CUSTOMIZATION_STATUSES).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();

export const customizationIdParam = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'id must be a 1-64 char identifier'),
  })
  .strict();

// ---------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------

/** Normalize text to CRLF line endings. */
export function toCrlf(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
}

/** Ensure the UTF-8 BOM prefix (byte-preservation for staged originals). */
export function withBom(bytes: Buffer): Buffer {
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  return bytes.subarray(0, 3).equals(bom) ? bytes : Buffer.concat([bom, bytes]);
}

// ---------------------------------------------------------------------------
// Flow run document
// ---------------------------------------------------------------------------

/** Per-step execution log entry (the progress log reviewers read). */
export interface FlowStepLog {
  name: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  startedAt?: Date;
  completedAt?: Date;
  /** Identifier keys only — never values. */
  detail?: string;
}

/** A step outcome from a flow run (platform or bespoke). */
export type FlowStepStatus = 'done' | 'blocked' | 'failed';

export interface FlowStepOutcome {
  name: string;
  status: FlowStepStatus;
  startedAt: string;
  completedAt: string;
  outputs?: Record<string, unknown>;
  blockedCode?: string;
  blockedDetail?: string;
  errorCode?: string;
  /** Identifier keys only — never values. */
  detail?: string;
}

export interface CustomizationEvidence {
  formXml: string;
  deck: string;
  inputs: { formXml: string; idoPropertiesCsv: string; sqlColumnsCsv: string };
  originals: { trn: string; prd: string; sha256Prefix: string };
  openItems: string[];
  assumptions: string[];
}

export interface CustomizationResult {
  prUrl: string;
  repoUrl: string;
  resultSummary: string;
  evidence: CustomizationEvidence;
}

/** Snapshot of the requester's auth context, taken at request creation. Identifiers only. */
export interface CustomizationAuthSnapshot {
  userId: string;
  tenantId: string;
  email: string;
  displayName: string;
  clearance: string;
  roleId: string;
  roleName: string;
  permissions: string[];
}

/** Mongo document for the `form_customizations` collection (tenant-scoped). */
export interface FormCustomizationDoc {
  _id: string;
  tenantId: string;
  requesterUserId: string;
  requestedBy?: string;
  formName: string;
  title: string;
  instructions: string[];
  status: FormCustomizationStatus;
  /** Flow definition that executes this run (reconciliation key). */
  flowName: string;
  flowVersion: string;
  /** Relative inbox folder holding the staged request inputs. */
  inboxDir: string;
  /** Relative project folder (set by the backup-originals step). */
  projectDir: string;
  /** Target GitHub repo (owner/name) for the review PR. */
  repo: string;
  hasPrdOriginal: boolean;
  inlineNormalized: boolean;
  attachmentNames: string[];
  /** Validated planner output (zod-checked before execution). */
  plan: unknown;
  steps: FlowStepLog[];
  result?: CustomizationResult;
  /** Enumerated blocked code (BLOCKED_REASONS). */
  blockedReason?: string;
  /** Human-readable blocked detail. */
  blockedDetail?: string;
  /**
   * Side-channel for flow tools: a blocked step records its (code, detail)
   * here before throwing, so the runner can map the failed tool call back
   * to the exact blocked outcome. Cleared on each claim.
   */
  pendingBlocked?: { code: string; detail: string };
  /** Platform flow run id executing this request (cancel bridge). */
  flowRunId?: string;
  authSnapshot: CustomizationAuthSnapshot;
  runnerId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

export function productInfo(): { name: string; version: string } {
  return { name: PRODUCT_NAME, version: FORM_AGENT_VERSION };
}

function iso(date: Date | undefined): string | undefined {
  return date?.toISOString();
}

/** Public list item. */
export function publicListItem(doc: FormCustomizationDoc): Record<string, unknown> {
  return {
    id: doc._id,
    status: doc.status,
    formName: doc.formName,
    title: doc.title,
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
  };
}

/**
 * Public detail view: the full request record minus the internal auth
 * snapshot (runner plumbing). Dates are ISO strings.
 */
export function publicDetailView(doc: FormCustomizationDoc): Record<string, unknown> {
  return {
    id: doc._id,
    status: doc.status,
    formName: doc.formName,
    title: doc.title,
    ...(doc.requestedBy ? { requestedBy: doc.requestedBy } : {}),
    product: productInfo(),
    flow: { name: doc.flowName, version: doc.flowVersion },
    steps: doc.steps.map((s) => ({
      name: s.name,
      status: s.status,
      ...(s.detail ? { detail: s.detail } : {}),
      startedAt: iso(s.startedAt),
      completedAt: iso(s.completedAt),
    })),
    ...(doc.result
      ? {
          resultSummary: doc.result.resultSummary,
          evidence: doc.result.evidence,
          prUrl: doc.result.prUrl,
          repoUrl: doc.result.repoUrl,
        }
      : {}),
    ...(doc.blockedReason ? { blockedReason: doc.blockedReason } : {}),
    ...(doc.blockedDetail ? { blockedDetail: doc.blockedDetail } : {}),
    createdAt: iso(doc.createdAt),
    updatedAt: iso(doc.updatedAt),
    ...(doc.completedAt ? { completedAt: iso(doc.completedAt) } : {}),
  };
}

/** Guard: a request may be read by its requester or an admin (403 otherwise). */
export function assertRequestReadable(
  doc: FormCustomizationDoc,
  requesterUserId: string,
  isAdmin: boolean,
): void {
  if (doc.requesterUserId !== requesterUserId && !isAdmin) {
    throw Errors.forbidden('FORBIDDEN', 'This SyteLine Form AI Agent request is not yours to read');
  }
}
