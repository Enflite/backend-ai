/**
 * capabilityDetect.ts — deterministic, conservative capability detection for
 * chat turns (Phase 6).
 *
 * The capability router needs to know which model slot should serve a turn.
 * This module answers that from the turn's own text plus which tool families
 * are offered — no model call, no heuristics that can hallucinate. It is
 * deliberately conservative: anything it does not recognize is 'chat', and
 * 'syteline' requires the SyteLine tools to actually be offered to this
 * caller (detection can never grant tool access the caller lacks).
 *
 * A caller-supplied `capability` on the chat request always wins over
 * detection; detection is the default when the caller says nothing.
 */
import type { Capability } from '../ai/gateway/capabilityRouter.js';

export interface CapabilityDetectOptions {
  /** Whether SyteLine ERP tools are offered to this caller this turn. */
  sytelineToolsOffered: boolean;
}

// SyteLine ERP intent: order/item numbers, stock and fulfillment language.
// Each pattern is anchored to ERP vocabulary so general chat ("I ordered
// lunch late") does not route to the syteline model.
const SYTELINE_PATTERNS: RegExp[] = [
  /\bSO-\d{3,}\b/i, // sales order numbers like SO-77821
  /\bWO-\d{3,}\b/i, // work order numbers
  /\bPO-\d{3,}\b/i, // purchase order numbers
  /\bITEM-[A-Za-z0-9-]+\b/i, // SyteLine item numbers
  /\bon[\s-]?hand\b/i,
  /\b(atp|available[-\s]?to[-\s]?promise)\b/i,
  /\b(sales order|purchase order|work order|customer order)\b/i,
  /\b(inventory|stock (level|out|room)|backorder|lead time)\b/i,
  /\b(bill of materials|\bBOM\b)\b/i,
  /\b(order (is |was )?(late|delayed|past due)|has .* shipped|order status)\b/i,
];

// Coding intent: code fences, repo paths, or code verbs aimed at code nouns.
// Requires a code noun near the verb so "fix the order problem" (ERP) does
// not count as coding.
const CODE_FENCE_PATTERN = /```/;
const REPO_PATH_PATTERN = /(^|[\s"'`])([\w.-]+\/)+[\w.-]+\.(ts|tsx|js|jsx|py|go|rs|java|kt|rb|php|sql|yaml|yml|toml|json|md)\b/;
const CODE_INTENT_PATTERN =
  /\b(write|fix|debug|refactor|explain|review|optimize|implement|generate)\b.{0,80}?\b(code|function|method|class|bug|script|regex|query|sql|test|diff|patch|api|endpoint|component|module|snippet|stack ?trace|traceback)\b/i;
const DIFF_PATTERN = /\b(unified diff|pull request|merge conflict)\b/i;

/**
 * Detect the capability for a chat turn. Pure and deterministic — safe to
 * unit test exhaustively.
 *
 * Ordering: coding intent is checked first because an explicit code request
 * ("write a function that checks stock") is a stronger signal than an ERP
 * keyword appearing inside it. SyteLine requires the tools to be offered;
 * without them the turn stays 'chat' even when it mentions orders.
 */
export function detectCapability(content: string, options: CapabilityDetectOptions): Capability {
  const text = content;
  if (CODE_FENCE_PATTERN.test(text) || REPO_PATH_PATTERN.test(text) || CODE_INTENT_PATTERN.test(text) || DIFF_PATTERN.test(text)) {
    return 'coding';
  }
  if (options.sytelineToolsOffered && SYTELINE_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'syteline';
  }
  return 'chat';
}
