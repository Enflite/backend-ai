/**
 * classifier.ts — deterministic task → capability classification (Phase 6).
 *
 * Capability routing picks which approved model serves a turn *by task* so
 * the user never sees model plumbing: they just talk to the assistant.
 * This classifier is deliberately rule-based, not model-based:
 *
 * - It runs on every routed turn with zero added latency, cost, or
 *   failure modes (no provider call, no network, no timeout).
 * - It is total and deterministic: every input yields exactly one
 *   capability, so routing always has a deterministic fallback.
 * - Its decisions are explainable: the ordered `reasons` codes travel in
 *   the SSE `meta` event and the MODEL_ROUTED audit.
 *
 * Precedence (first match wins):
 *   1. `rag`      — the caller attached documents for retrieval this turn.
 *                   An explicit user action beats all heuristics.
 *   2. `coding`   — strong code signals (fenced blocks, stack traces, code
 *                   file paths, programming keywords). A message can mention
 *                   ERP entities *and* contain code ("write a script that
 *                   checks SyteLine stock"); the task is still coding.
 *   3. `syteline` — ERP investigation language (order/item/inventory/PO/work
 *                   order/BOM/customer …) plus an investigation verb, an
 *                   explicit SyteLine mention, or a bare order reference.
 *                   Requires `sytelineToolsOffered`: there is no point routing
 *                   to the SyteLine capability for a caller who cannot use
 *                   its tools.
 *   4. `chat`     — the default. General conversation, and anything the
 *                   heuristics do not recognize.
 *
 * This classifier makes NO security decision. Tool permissions, data
 * classification, model approval, and endpoint allowlisting are enforced
 * downstream exactly as before (ADR-004); classification only selects among
 * models the caller is already approved to use.
 */

export const TASK_CAPABILITIES = ['chat', 'syteline', 'coding', 'rag'] as const;
export type TaskCapability = (typeof TASK_CAPABILITIES)[number];

export function isTaskCapability(value: unknown): value is TaskCapability {
  return typeof value === 'string' && (TASK_CAPABILITIES as readonly string[]).includes(value);
}

export interface TaskClassificationInput {
  /** The user's message text for the turn being routed. */
  content: string;
  /** Document IDs attached for retrieval on this turn (explicit user action). */
  documentIds?: string[];
  /** Whether syteline.* tools will be offered to the model this turn. */
  sytelineToolsOffered: boolean;
}

export interface TaskClassification {
  capability: TaskCapability;
  /**
   * Stable, ordered reason codes. Safe for audit metadata and SSE: they
   * name the matched rule, never user content.
   */
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Signal patterns
// ---------------------------------------------------------------------------

/** Fenced code block anywhere in the message. */
const CODE_FENCE_RE = /```/;
/** Python tracebacks and `at fn (file:line:col)` / `file.ext:line` frames. */
const STACK_TRACE_RE =
  /(?:Traceback \(most recent call last\)|^\s*at\s+\S+\s*\(.+:\d+:\d+\)|^\s*[\w.~\-/#]+\.(?:js|ts|jsx|tsx|py|java|kt|go|rs|rb|php|cs|cpp|c|h):\d+)/m;
/** A path-like token ending in a code file extension. */
const CODE_FILE_RE =
  /(?:\b[\w.~\-/#]+\.(?:py|tsx?|jsx?|java|kt|go|rs|rb|php|cs|cpp|cc|cxx|c|h|hpp|sql|sh|bash|zsh|ps1|yaml|yml|toml|tf)\b|\bDockerfile\b)/i;
/** Programming-task vocabulary. Word-boundaried; intentionally narrow to
 *  avoid stealing general questions ("how does git work?" still matches —
 *  that IS a coding question). Bare language names are included, but only
 *  unambiguous ones: "rust" (corrosion) and "swift" (bank transfers) are
 *  deliberately excluded — in a manufacturing/ERP context they are more
 *  often not the programming language. */
const CODE_KEYWORD_RE =
  /\b(debugging?|debugger|refactor(?:ing)?|compil(?:e|er|ing|ation)|syntax error|type error|null\s?pointer|segfault|stack\s?(?:trace|overflow)|breakpoint|unit tests?|integration tests?|pull requests?|merge conflicts?|git\s+(?:commit|push|pull|merge|rebase|stash|checkout|clone)|regular expressions?|\bregex\b|lambdas?|closures?|recursion|big-?o\b|time complexity|api\s+(?:endpoint|request|response)|http\s+(?:get|post|put|delete|patch)\b|sql\s+queries?|schema migrations?|code\s+review|python|javascript|typescript|java|kotlin|golang|ruby|php|scala|haskell)\b/i;

/** Explicit product mention — unambiguous regardless of verbs. */
const SYTELINE_MENTION_RE = /\bsyteline\b/i;
/** ERP entity vocabulary. */
const ERP_ENTITY_RE =
  /\b(sales?\s+orders?|purchase\s+orders?|work\s+orders?|back\s*orders?|items?|inventory|inventories|stock|warehouses?|shipments?|invoices?|customers?|vendors?|suppliers?|bill\s+of\s+materials?|allocations?|lead\s+times?|on[-\s]?hand)\b/i;
/** Bare "PO" — case-sensitive on purpose: lowercase "po" is a common word. */
const ERP_PO_RE = /\bPO\b/;
/** A bare order reference ("order 45213", "order #45213") is a lookup request. */
const ERP_ORDER_REF_RE = /\border\s*(?:#|no\.?|number|id)?\s*\d{2,}\b/i;
/** Investigation verbs that turn an entity mention into an ERP task. */
const ERP_VERB_RE =
  /\b(why|what|late|delay(?:ed|s)?|overdue|behind|status|checks?|checking|lookup|look\s*up|find|show|list|search|shortages?|fulfill(?:ment)?|ships?|shipped|shipping|eta|expected|arriving|arrives?)\b/i;

function hasCodeSignals(content: string): boolean {
  return CODE_FENCE_RE.test(content) || STACK_TRACE_RE.test(content) || CODE_FILE_RE.test(content) || CODE_KEYWORD_RE.test(content);
}

function hasSytelineSignals(content: string): { matched: boolean; explicit: boolean } {
  if (SYTELINE_MENTION_RE.test(content)) return { matched: true, explicit: true };
  if (ERP_ORDER_REF_RE.test(content)) return { matched: true, explicit: false };
  if ((ERP_ENTITY_RE.test(content) || ERP_PO_RE.test(content)) && ERP_VERB_RE.test(content)) {
    return { matched: true, explicit: false };
  }
  return { matched: false, explicit: false };
}

/**
 * Classify one user turn into a serving capability. Total: never throws,
 * never returns anything but a valid TaskClassification.
 */
export function classifyTask(input: TaskClassificationInput): TaskClassification {
  const content = input.content ?? '';

  // 1. Explicit document context wins over every heuristic.
  if (input.documentIds && input.documentIds.length > 0) {
    return { capability: 'rag', reasons: ['explicit-document-context'] };
  }

  // 2. Strong code signals.
  if (hasCodeSignals(content)) {
    return { capability: 'coding', reasons: ['code-content-detected'] };
  }

  // 3. SyteLine investigation — only when the caller can actually use the
  // ERP tools; otherwise the capability default buys them nothing.
  if (input.sytelineToolsOffered) {
    const syteline = hasSytelineSignals(content);
    if (syteline.matched) {
      return {
        capability: 'syteline',
        reasons: [syteline.explicit ? 'explicit-syteline-mention' : 'syteline-entities-detected'],
      };
    }
  }

  // 4. Default: general chat.
  return { capability: 'chat', reasons: ['default-capability'] };
}
