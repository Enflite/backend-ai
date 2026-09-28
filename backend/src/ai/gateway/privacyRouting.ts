/**
 * privacyRouting.ts — privacy-aware provider routing: Claude for public /
 * general work, local Enflite whenever sensitive data is involved.
 *
 * The owner-approved policy: the AI may use the Claude API for anything
 * outside sensitive data, and must use the local Enflite model whenever
 * sensitive data is involved. Sensitive data has THREE categories, all
 * local-only:
 *
 * - customer: customer records, PII (emails, phones, SSNs), ERP customer
 *   tables and document numbers;
 * - finance: financial PII (account/tax IDs), finance keywords (revenue,
 *   margin, P&L, payroll, GL, ...), ERP finance tables;
 * - proprietary: the tenant's private document corpus (RAG chunks),
 *   tenant-private user memory, proprietary business data.
 *
 * The detector scans the COMPLETE prompt text that is about to be sent to
 * a provider (whole-context / context-bleed model):
 *
 * - the full conversation history (earlier turns may carry sensitive tool
 *   results the latest message does not mention),
 * - retrieved private-corpus RAG chunks (zone 3, plus an optional
 *   `sensitivity="..."` attribute on `<untrusted_document>` wrappers when
 *   the source document carries sensitivity metadata/tags),
 * - tenant-private user-memory injections,
 * - and the current user message.
 *
 * Scanning only the latest message would let sensitive data bleed into a
 * cloud provider through history. When in doubt the detector stays local.
 *
 * CODE CARVE-OUT (tenant setting `codeRoutableToCloud`, default true):
 * the tenant's repo SOURCE CODE stays routable to Claude — coding help is
 * a primary use case. Only business/finance/proprietary *data* is locked
 * local. Flip the flag to false to make code content local-only too; the
 * detector then treats repo tool results, zone-3b repo files, and fenced
 * code as proprietary. The finance-keyword scan always runs on
 * code-stripped text so source code never trips finance keywords.
 *
 * The enforced category list is tenant-configurable
 * (`sensitiveCategories`, default-deny: all three). A detected category
 * forces local inference only when it is enforced.
 *
 * Routing precedence (applied in applyPrivacyRouting):
 *   1. explicit Enflite (local) selection is never changed;
 *   2. sensitive data in an enforced category forces local even when the
 *      user picked Claude (privacy overrides toward local only);
 *   3. clean turns with no explicit selection auto-route to Claude when
 *      the tenant toggle is on and Claude is configured;
 *   4. anything else stays on the preliminary model.
 *
 * Claude unconfigured (no ANTHROPIC_API_KEY) -> everything stays local.
 * Audit events carry detection reasons/kinds only, never matched text.
 */

import { tenantOp } from '../../db/mongo.js';
import { AppError } from '../../errors.js';
import {
  ensureTenantDefaultModel,
  findServableChatModelForGroup,
  getApprovedModelForUser,
  isClaudeConfigured,
} from './modelRegistry.js';
import type { ApprovedModel } from './modelRegistry.js';
import { resolveDefaultOpenModel, resolveVisionModel } from './capabilityRouter.js';
import { providerGroupFor } from '../providers/providerDisplay.js';
import { recordAudit } from '../../audit/audit.js';

/** The three sensitive-data categories that must stay local. */
export const SENSITIVE_CATEGORIES = ['customer', 'finance', 'proprietary'] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

const DEFAULT_SENSITIVE_CATEGORIES: SensitiveCategory[] = [...SENSITIVE_CATEGORIES];

export const CUSTOMER_DATA_REASONS = [
  'syteline_tool_result',
  'syteline_capability_predicted',
  'private_rag_context',
  'user_memory',
  'pii_email',
  'pii_phone',
  'pii_ssn',
  'pii_account',
  'pii_customer_id',
  'pii_tax_id',
  'erp_document_number',
  'finance_keyword',
  'code_content',
] as const;
export type CustomerDataReason = (typeof CUSTOMER_DATA_REASONS)[number];

/** Which sensitive categories each detection reason implicates. */
const REASON_CATEGORIES: Record<CustomerDataReason, SensitiveCategory[]> = {
  syteline_tool_result: ['customer', 'finance'],
  syteline_capability_predicted: ['customer', 'finance'],
  private_rag_context: ['proprietary'],
  user_memory: ['customer', 'proprietary'],
  pii_email: ['customer'],
  pii_phone: ['customer'],
  pii_ssn: ['customer'],
  pii_account: ['finance'],
  pii_customer_id: ['customer'],
  pii_tax_id: ['finance'],
  erp_document_number: ['customer', 'finance'],
  finance_keyword: ['finance'],
  code_content: ['proprietary'],
};

// ---------------------------------------------------------------------------
// Detection markers
// ---------------------------------------------------------------------------

/** SyteLine tool-result wrappers: the ERP covers customer AND finance tables. */
const SYTELINE_TOOL_RESULT_RE = /<untrusted_tool_result name="syteline\./;
/** Zone 3 label for retrieved private-corpus RAG context. */
const RAG_CONTEXT_ZONE_RE = /--- ZONE 3: RETRIEVED RAG CONTEXT/;
/**
 * Optional per-chunk sensitivity metadata: `<untrusted_document
 * citation="1" document_id="..." chunk_id="..." sensitivity="finance">`.
 * Emitted by the RAG pipeline when the source document carries
 * sensitivity metadata/tags; absent for untagged documents (which default
 * to the proprietary category via the zone-3 label).
 */
const RAG_CHUNK_SENSITIVITY_RE = /<untrusted_document\b[^>]*\bsensitivity="([a-z]+)"/g;
/** Tenant-private user-memory injection section. */
const USER_MEMORY_RE = /--- USER MEMORY \(untrusted data\) ---/;
/** Repo file context (zone 3b) and repo tool results: the code carve-out. */
const REPO_FILES_ZONE_RE = /--- ZONE 3b: REPO FILES/;
const REPO_TOOL_RESULT_RE = /<untrusted_tool_result name="repo\./;
const FENCED_CODE_RE = /```[\s\S]*?```/;

/** Code regions are stripped before the finance-keyword scan so source
 *  code never trips finance keywords (the code carve-out). */
function stripCodeRegions(text: string): string {
  return text
    .replace(/<untrusted_tool_result name="repo\.[\s\S]*?<\/untrusted_tool_result>/g, ' ')
    .replace(/--- ZONE 3b: REPO FILES[\s\S]*?--- END REPO FILES ---/g, ' ')
    .replace(FENCED_CODE_RE, ' ');
}

// PII patterns
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}/;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/;
const ACCOUNT_LABEL_RE = /\b(?:account|acct|member|policy|loan)\s*(?:number|num|no|#|id)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]*/i;
/** Customer identifiers stay in the customer category, not finance. */
const CUSTOMER_ID_RE = /\bcustomer\s*(?:number|num|no|#|id)\s*[:#]?\s*[A-Za-z0-9][A-Za-z0-9-]*/i;
/** Employer Identification Number (US federal tax ID): XX-XXXXXXX. */
const TAX_ID_RE = /\b\d{2}-\d{7}\b/;
/** ERP document numbers: SO-77821, PO-1234, WO-99, QUO-2024-001, INV-555. */
const ERP_DOC_RE = /\b(?:SO|PO|WO|QUO|QUOTE|INV|RMA|CO|DO|TO|ITEM)-\d[\w-]*\b/i;

/**
 * Conservative finance keyword set. Runs on code-stripped text (see
 * stripCodeRegions) so identifiers like CSS `margin` inside source code
 * never trigger it. In prose these terms indicate financial data.
 */
const FINANCE_KEYWORD_RE =
  /\b(?:revenues?|margins?|p&l|p\/l|profit and loss|payroll|general ledger|gl|ebitda|balance sheets?|income statements?|cash flows?|accounts payable|accounts receivable|ledger|gross profit|net income|operating income|trial balance|chart of accounts)\b/i;

export interface CustomerDataDetection {
  /**
   * True when any sensitive data was detected (any of the three
   * categories). This is the raw detector verdict; whether it forces
   * local routing depends on the tenant's enforced category list, which
   * applyPrivacyRouting applies.
   */
  hasCustomerData: boolean;
  /** Detection reasons found in the prompt text (never matched text). */
  reasons: CustomerDataReason[];
  /**
   * Sensitive categories implicated by the reasons (before the tenant's
   * enforced-category filter). Includes categories parsed from RAG chunk
   * `sensitivity="..."` metadata when present.
   */
  categories: SensitiveCategory[];
}

/**
 * Scan the complete provider-bound prompt for sensitive data.
 *
 * @param promptText the full prompt (system + history + retrieved context
 *   + user message) that would be sent to the provider.
 * @param options.codeRoutableToCloud the CODE CARVE-OUT flag: when false,
 *   repo source code counts as proprietary and forces local.
 */
export function detectCustomerData(
  promptText: string,
  options: { codeRoutableToCloud?: boolean } = {}
): CustomerDataDetection {
  const reasons: CustomerDataReason[] = [];
  const categories = new Set<SensitiveCategory>();
  const add = (reason: CustomerDataReason): void => {
    if (!reasons.includes(reason)) {
      reasons.push(reason);
      for (const category of REASON_CATEGORIES[reason]) categories.add(category);
    }
  };

  // --- Source-based markers ---
  if (SYTELINE_TOOL_RESULT_RE.test(promptText)) add('syteline_tool_result');
  if (RAG_CONTEXT_ZONE_RE.test(promptText)) {
    add('private_rag_context');
    // Finer-grained categories from document sensitivity metadata/tags.
    for (const match of promptText.matchAll(RAG_CHUNK_SENSITIVITY_RE)) {
      const tag = match[1]!;
      if ((SENSITIVE_CATEGORIES as readonly string[]).includes(tag)) {
        categories.add(tag as SensitiveCategory);
      }
    }
  }
  if (USER_MEMORY_RE.test(promptText)) add('user_memory');

  // --- Pattern-based markers ---
  if (EMAIL_RE.test(promptText)) add('pii_email');
  if (PHONE_RE.test(promptText)) add('pii_phone');
  if (SSN_RE.test(promptText)) add('pii_ssn');
  if (ACCOUNT_LABEL_RE.test(promptText)) add('pii_account');
  if (CUSTOMER_ID_RE.test(promptText)) add('pii_customer_id');
  if (TAX_ID_RE.test(promptText)) add('pii_tax_id');
  if (ERP_DOC_RE.test(promptText)) add('erp_document_number');
  if (FINANCE_KEYWORD_RE.test(stripCodeRegions(promptText))) add('finance_keyword');

  // --- Code carve-out (flipped state): code content is proprietary. ---
  if (options.codeRoutableToCloud === false) {
    if (
      REPO_FILES_ZONE_RE.test(promptText) ||
      REPO_TOOL_RESULT_RE.test(promptText) ||
      FENCED_CODE_RE.test(promptText)
    ) {
      add('code_content');
    }
  }

  return { hasCustomerData: reasons.length > 0, reasons, categories: [...categories] };
}

// ---------------------------------------------------------------------------
// Tool gating
// ---------------------------------------------------------------------------

const CUSTOMER_DATA_TOOL_PREFIXES = ['syteline.'] as const;
const CODE_TOOL_PREFIXES = ['repo.'] as const;

/**
 * Remove tools whose results could introduce sensitive data on a
 * cloud-served turn. The agentic loop keeps the round's model across tool
 * calls without re-running privacy routing, so a cloud turn must never be
 * OFFERED a tool whose result would leak:
 *
 * - `syteline.*` (ERP customer/finance data) is stripped whenever the
 *   customer or finance category is enforced;
 * - `repo.*` (source code) is stripped only when the CODE CARVE-OUT is
 *   flipped off (`codeRoutableToCloud: false`).
 *
 * Defaults preserve the standard policy: all categories enforced, the
 * code carve-out on.
 */
export function stripCustomerDataTools<T extends { function: { name: string } }>(
  tools: readonly T[],
  enforcedCategories: SensitiveCategory[] = [...DEFAULT_SENSITIVE_CATEGORIES],
  codeRoutableToCloud = true
): T[] {
  const stripSyteline =
    enforcedCategories.includes('customer') || enforcedCategories.includes('finance');
  return tools.filter((tool) => {
    const name = tool.function.name;
    if (stripSyteline && CUSTOMER_DATA_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return false;
    }
    if (!codeRoutableToCloud && CODE_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))) {
      return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Tenant settings (privacy_routing_settings collection, _id = tenantId)
// ---------------------------------------------------------------------------

export interface PrivacyRoutingSetting {
  tenantId: string;
  /** Master switch: clean, unpinned turns may auto-route to Claude. Default true. */
  autoRouteToCloud: boolean;
  /**
   * Sensitive categories that force a turn local. Tenant-configurable;
   * default-deny: all three categories enforced.
   */
  sensitiveCategories: SensitiveCategory[];
  /**
   * CODE CARVE-OUT: repo source code stays routable to Claude (coding help
   * is a primary use case); only business/finance/proprietary *data* is
   * locked local. Flip to false to make code content local-only too.
   */
  codeRoutableToCloud: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

function sanitizeCategories(value: unknown): SensitiveCategory[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<SensitiveCategory>();
  for (const entry of value) {
    if (typeof entry === 'string' && (SENSITIVE_CATEGORIES as readonly string[]).includes(entry)) {
      seen.add(entry as SensitiveCategory);
    }
  }
  return [...seen];
}

function defaultSetting(tenantId: string): PrivacyRoutingSetting {
  return {
    tenantId,
    autoRouteToCloud: true,
    sensitiveCategories: [...DEFAULT_SENSITIVE_CATEGORIES],
    codeRoutableToCloud: true,
    updatedBy: null,
    updatedAt: new Date(0),
  };
}

/** Shape of the privacy_routing_settings document (_id = tenantId). */
interface PrivacyRoutingSettingDoc {
  _id: string;
  autoRouteToCloud?: boolean;
  sensitiveCategories?: unknown;
  codeRoutableToCloud?: boolean;
  updatedBy?: string;
  updatedAt?: Date;
}

export async function getPrivacyAutoRouting(tenantId: string): Promise<PrivacyRoutingSetting> {
  const doc = await tenantOp(tenantId, (db) =>
    db.collection<PrivacyRoutingSettingDoc>('privacy_routing_settings').findOne({ _id: tenantId })
  );
  return {
    tenantId,
    autoRouteToCloud: typeof doc?.autoRouteToCloud === 'boolean' ? doc.autoRouteToCloud : true,
    sensitiveCategories:
      sanitizeCategories(doc?.sensitiveCategories) ?? [...DEFAULT_SENSITIVE_CATEGORIES],
    codeRoutableToCloud:
      typeof doc?.codeRoutableToCloud === 'boolean' ? doc.codeRoutableToCloud : true,
    updatedBy: typeof doc?.updatedBy === 'string' ? doc.updatedBy : null,
    updatedAt: doc?.updatedAt instanceof Date ? doc.updatedAt : new Date(0),
  };
}

export interface PrivacyRoutingSettingUpdate {
  autoRouteToCloud?: boolean;
  sensitiveCategories?: SensitiveCategory[];
  codeRoutableToCloud?: boolean;
}

export async function setPrivacyRoutingSetting(
  tenantId: string,
  update: PrivacyRoutingSettingUpdate,
  actorUserId: string,
  requestId?: string,
  ip?: string
): Promise<PrivacyRoutingSetting> {
  const now = new Date();
  const setDoc: Record<string, unknown> = { updatedBy: actorUserId, updatedAt: now };
  if (typeof update.autoRouteToCloud === 'boolean') setDoc.autoRouteToCloud = update.autoRouteToCloud;
  if (Array.isArray(update.sensitiveCategories)) {
    setDoc.sensitiveCategories = sanitizeCategories(update.sensitiveCategories) ?? [];
  }
  if (typeof update.codeRoutableToCloud === 'boolean') {
    setDoc.codeRoutableToCloud = update.codeRoutableToCloud;
  }
  // Read-then-write (instead of blind upsert + re-read) so the returned
  // setting reflects fields the caller did not touch.
  const existing = await getPrivacyAutoRouting(tenantId).catch(() => defaultSetting(tenantId));
  const merged: PrivacyRoutingSetting = {
    tenantId,
    autoRouteToCloud:
      typeof setDoc.autoRouteToCloud === 'boolean'
        ? (setDoc.autoRouteToCloud as boolean)
        : existing.autoRouteToCloud,
    sensitiveCategories: Array.isArray(setDoc.sensitiveCategories)
      ? (setDoc.sensitiveCategories as SensitiveCategory[])
      : existing.sensitiveCategories,
    codeRoutableToCloud:
      typeof setDoc.codeRoutableToCloud === 'boolean'
        ? (setDoc.codeRoutableToCloud as boolean)
        : existing.codeRoutableToCloud,
    updatedBy: actorUserId,
    updatedAt: now,
  };
  await tenantOp(tenantId, (db) =>
    db
      .collection<PrivacyRoutingSettingDoc>('privacy_routing_settings')
      .updateOne({ _id: tenantId }, { $set: setDoc }, { upsert: true })
  );
  // Audit exactly what changed (never values from the prompt or documents).
  const metadata: Record<string, unknown> = {};
  if (typeof setDoc.autoRouteToCloud === 'boolean') metadata.autoRouteToCloud = setDoc.autoRouteToCloud;
  if (Array.isArray(setDoc.sensitiveCategories)) {
    metadata.sensitiveCategories = setDoc.sensitiveCategories;
  }
  if (typeof setDoc.codeRoutableToCloud === 'boolean') {
    metadata.codeRoutableToCloud = setDoc.codeRoutableToCloud;
  }
  await recordAudit({
    tenantId,
    userId: actorUserId,
    requestId,
    ip,
    action: 'PRIVACY_AUTO_ROUTING_SET',
    success: true,
    metadata,
  });
  return merged;
}

export async function setPrivacyAutoRouting(
  tenantId: string,
  autoRouteToCloud: boolean,
  actorUserId: string,
  requestId?: string,
  ip?: string
): Promise<PrivacyRoutingSetting> {
  return setPrivacyRoutingSetting(tenantId, { autoRouteToCloud }, actorUserId, requestId, ip);
}

// ---------------------------------------------------------------------------
// Routing decision
// ---------------------------------------------------------------------------

/** Friendly notice sent when privacy forces a turn local. */
export const PRIVACY_ROUTING_NOTICE = 'Kept this on Enflite — it touches customer data.';
const FINANCE_ROUTING_NOTICE = 'Kept this on Enflite — it touches financial data.';
const PROPRIETARY_ROUTING_NOTICE = 'Kept this on Enflite — it touches proprietary business data.';
const SENSITIVE_ROUTING_NOTICE = 'Kept this on Enflite — it touches sensitive data.';

/**
 * Friendly override notice naming the enforced categories accurately.
 * Customer-only keeps the owner-approved exact wording; mixed categories
 * get the generic sensitive-data wording.
 */
export function privacyOverrideNotice(enforcedCategories: SensitiveCategory[]): string {
  if (enforcedCategories.includes('customer')) return PRIVACY_ROUTING_NOTICE;
  if (enforcedCategories.includes('finance')) return FINANCE_ROUTING_NOTICE;
  if (enforcedCategories.includes('proprietary')) return PROPRIETARY_ROUTING_NOTICE;
  return SENSITIVE_ROUTING_NOTICE;
}

export interface PrivacyRoutingDecision {
  /** The model that will actually serve this turn. */
  model: ApprovedModel;
  /** True when the serving model differs from the preliminary resolution. */
  privacyOverridden: boolean;
  /** True when a clean turn was auto-routed to Claude. */
  autoRoutedToCloud: boolean;
  /** Friendly override notice for the activity feed, or null. */
  notice: string | null;
  /** Detector output for this turn. */
  detection: CustomerDataDetection;
  /** Categories implicated by the detection that the tenant enforces. */
  enforcedCategories: SensitiveCategory[];
  /** The tenant's full enforced category list (for tool gating). */
  allEnforcedCategories: SensitiveCategory[];
  /** The tenant's code carve-out flag (for tool gating). */
  codeRoutableToCloud: boolean;
}

export interface PrivacyRoutingInput {
  tenantId: string;
  userId: string;
  roleId: string;
  /** The complete provider-bound prompt text for this turn. */
  promptText: string;
  /** Model from normal resolution (explicit selection or capability router). */
  preliminaryModel: ApprovedModel;
  /** True when the user explicitly picked a provider/model. */
  explicitModelSelection: boolean;
  /** Capability requested for this turn, if any (predictive routing). */
  requestedCapability?: string;
  /** True when the turn carries image payloads (needs a vision-capable local model). */
  hasImages?: boolean;
  requestId?: string;
  ip?: string;
}

/**
 * Apply privacy-aware routing to a resolved model.
 *
 * Never throws for missing settings or an unconfigured Claude: those fall
 * back to the preliminary (local) model. It DOES throw (fail closed) when
 * the turn is sensitive and no local model can serve it — sensitive context
 * must never fall back to a cloud model.
 */
export async function applyPrivacyRouting(input: PrivacyRoutingInput): Promise<PrivacyRoutingDecision> {
  const setting = await getPrivacyAutoRouting(input.tenantId).catch(() => defaultSetting(input.tenantId));

  const detection = detectCustomerData(input.promptText, {
    codeRoutableToCloud: setting.codeRoutableToCloud,
  });

  // Predictive routing: a turn that WILL call SyteLine tools is treated as
  // sensitive before any result exists (ERP covers customer+finance tables).
  const reasons: CustomerDataReason[] = [...detection.reasons];
  const categories = new Set<SensitiveCategory>(detection.categories);
  if (input.requestedCapability === 'syteline' && !reasons.includes('syteline_capability_predicted')) {
    reasons.push('syteline_capability_predicted');
    for (const category of REASON_CATEGORIES['syteline_capability_predicted']) {
      categories.add(category);
    }
  }

  const enforcedCategories = [...categories].filter((category) =>
    setting.sensitiveCategories.includes(category)
  );
  const hasSensitiveData = enforcedCategories.length > 0;

  const preliminaryGroup = providerGroupFor(input.preliminaryModel.provider);
  const isLocalPreliminary = preliminaryGroup === 'enflite';

  const base: Omit<PrivacyRoutingDecision, 'model' | 'privacyOverridden' | 'autoRoutedToCloud' | 'notice'> = {
    detection: { hasCustomerData: reasons.length > 0, reasons, categories: [...categories] },
    enforcedCategories,
    allEnforcedCategories: setting.sensitiveCategories,
    codeRoutableToCloud: setting.codeRoutableToCloud,
  };

  // Rule 1: an explicit local selection is never changed.
  if (isLocalPreliminary && input.explicitModelSelection) {
    return { ...base, model: input.preliminaryModel, privacyOverridden: false, autoRoutedToCloud: false, notice: null };
  }

  // Rule 2: sensitive data in an enforced category forces local, even over
  // an explicit Claude pick (privacy overrides toward local only). Image
  // turns resolve the local vision model so image payloads keep working.
  if (hasSensitiveData) {
    const local = await (input.hasImages
      ? resolveVisionModel({
          tenantId: input.tenantId,
          userId: input.userId,
          roleId: input.roleId,
          requestId: input.requestId,
        }).catch(() => null)
      : resolveLocalChatModel(input.tenantId, input.userId, input.roleId).catch(() => null));
    if (local) {
      await recordAudit({
        tenantId: input.tenantId,
        userId: input.userId,
        requestId: input.requestId,
        ip: input.ip,
        action: 'PRIVACY_ROUTING_OVERRIDE',
        success: true,
        metadata: { reasons, categories: enforcedCategories },
      });
      return {
        ...base,
        model: local,
        privacyOverridden: true,
        autoRoutedToCloud: false,
        notice: privacyOverrideNotice(enforcedCategories),
      };
    }
    // No local model available: fail closed. Sensitive context must never
    // fall back to a cloud model — the turn is rejected with a clear error
    // instead of leaking to Claude.
    await recordAudit({
      tenantId: input.tenantId,
      userId: input.userId,
      requestId: input.requestId,
      ip: input.ip,
      action: 'PRIVACY_ROUTING_NO_LOCAL_MODEL',
      success: false,
      metadata: { reasons, categories: enforcedCategories },
    });
    throw new AppError(
      503,
      'PRIVACY_LOCAL_MODEL_UNAVAILABLE',
      'This turn involves sensitive data and no local Enflite model is available to serve it. Ask your admin to approve a local model.'
    );
  }

  // Rule 3: clean turn, no explicit selection -> auto-route to Claude when
  // the tenant toggle is on and Claude is configured. The caller must still
  // be approved for the Claude model; a revoked approval falls back local.
  if (!input.explicitModelSelection && setting.autoRouteToCloud && isClaudeConfigured()) {
    try {
      const claudeDoc = await findServableChatModelForGroup('claude');
      if (claudeDoc) {
        const approved = await getApprovedModelForUser(
          claudeDoc._id,
          input.tenantId,
          input.userId,
          input.roleId
        );
        await recordAudit({
          tenantId: input.tenantId,
          userId: input.userId,
          requestId: input.requestId,
          ip: input.ip,
          action: 'PRIVACY_ROUTING_AUTO_CLOUD',
          success: true,
          metadata: { model: approved.id },
        });
        return {
          ...base,
          model: approved,
          privacyOverridden: preliminaryGroup !== 'claude',
          autoRoutedToCloud: true,
          notice: null,
        };
      }
    } catch {
      // Claude unavailable or not approved for this caller: preliminary stands.
    }
  }

  // Rule 4: default — the preliminary model stands.
  return {
    ...base,
    model: input.preliminaryModel,
    privacyOverridden: false,
    autoRoutedToCloud: preliminaryGroup === 'claude' || preliminaryGroup === 'openai',
    notice: null,
  };
}

/**
 * Resolve the tenant's default local (Enflite) chat model for privacy
 * overrides. Never throws: returns null when no local model can serve.
 */
async function resolveLocalChatModel(
  tenantId: string,
  userId: string,
  roleId: string
): Promise<ApprovedModel | null> {
  try {
    const fallback = await resolveDefaultOpenModel(tenantId, userId, roleId);
    if (providerGroupFor(fallback.provider) === 'enflite') return fallback;
  } catch {
    // Fall through to the ensured tenant default below.
  }
  try {
    const ensured = await ensureTenantDefaultModel();
    if (ensured && providerGroupFor(ensured.provider) === 'enflite') return ensured;
  } catch {
    // No local model available.
  }
  return null;
}
