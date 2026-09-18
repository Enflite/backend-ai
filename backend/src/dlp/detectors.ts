/**
 * detectors.ts — deterministic PII detectors for the assistant outbound
 * boundary (Phase 5c).
 *
 * Built-in detectors (always on when DLP is enabled):
 *  - US Social Security numbers: dashed form `\d{3}-\d{2}-\d{4}`.
 *  - Credit-card-looking numbers: 13–19 digit runs (spaces/dashes allowed)
 *    that pass the Luhn check AND look like a real PAN shape. Luhn alone is
 *    not enough: spaced ERP numeric tables (columns of quantities/prices)
 *    can produce digit runs that pass Luhn by chance, so a separated
 *    candidate must additionally use one consistent separator and a
 *    plausible card grouping (4-4-4-4, 4-6-5, 4-6-4, ...). Contiguous
 *    13–19 digit runs are accepted on Luhn alone — real PANs are often
 *    written without separators.
 *
 * Detected spans are replaced with a visible marker (`[redacted:SSN]`,
 * `[redacted:card]`) — no lecture, no refusal. Detection metadata (kind
 * and count) is returned for auditing; matched text is never persisted.
 */

export type DlpKind = 'ssn' | 'credit_card';

export interface DlpMatch {
  kind: DlpKind;
  /** Start offset (inclusive) in the scanned text. */
  start: number;
  /** End offset (exclusive) in the scanned text. */
  end: number;
}

export const DLP_MARKERS: Record<DlpKind, string> = {
  ssn: '[redacted:SSN]',
  credit_card: '[redacted:card]',
};

const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
// 13–19 digits with optional single spaces/dashes between them, always
// ending on a digit (a trailing separator is never part of the match). The
// \b guards keep the match out of longer digit runs (order numbers, snowflakes).
const CARD_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;

/** Luhn checksum: true when the digit string is card-plausible. */
export function luhnValid(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let digit = digits.charCodeAt(i) - 48;
    if (double) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Plausible separator groupings per PAN digit length. These are the
 * groupings real card networks use when the number is written with
 * separators (Visa/MC/Discover 4-4-4-4, Amex 4-6-5, Diners 4-6-4, legacy
 * 13-digit Visa 4-4-4-1 / 4-4-5, long PANs 4-4-4-4 + tail). A digit run
 * sliced into any other grouping — e.g. ERP table columns "1200 34500 800
 * 12908" (4-5-3-5) — is not a PAN even if it passes Luhn.
 */
const PLAUSIBLE_GROUPINGS: Record<number, number[][]> = {
  13: [
    [4, 4, 4, 1],
    [4, 4, 5],
  ],
  14: [[4, 6, 4]],
  15: [[4, 6, 5]],
  16: [[4, 4, 4, 4]],
  17: [[4, 4, 4, 4, 1]],
  18: [[4, 4, 4, 4, 2]],
  19: [[4, 4, 4, 4, 3]],
};

/**
 * True when a regex candidate looks like a real PAN shape: either a
 * contiguous digit run (13–19 digits, no separators), or groups joined by
 * one consistent separator (all spaces or all dashes) in a plausible
 * grouping for the digit length. Rejects implausible groupings and mixed
 * separators.
 */
export function panShapePlausible(candidate: string): boolean {
  const digits = candidate.replace(/\D/g, '');
  if (digits.length < 13 || digits.length > 19) return false;
  const groups = candidate.split(/[ -]/);
  if (groups.length === 1) return true; // contiguous run: no shape to check
  // The candidate regex only allows space/dash separators; require exactly
  // one separator character used consistently between every group.
  const separators = candidate.replace(/[\d]/g, '');
  const sep = separators[0];
  if (sep !== ' ' && sep !== '-') return false;
  if (![...separators].every((c) => c === sep)) return false;
  const lengths = groups.map((g) => g.length);
  return (PLAUSIBLE_GROUPINGS[digits.length] ?? []).some(
    (pattern) => pattern.length === lengths.length && pattern.every((n, i) => n === lengths[i])
  );
}

/**
 * Finds all PII matches in the text, sorted by position, with overlaps
 * resolved in favor of the earliest match.
 */
export function findDlpMatches(text: string): DlpMatch[] {
  const matches: DlpMatch[] = [];
  for (const match of text.matchAll(SSN_RE)) {
    matches.push({ kind: 'ssn', start: match.index!, end: match.index! + match[0].length });
  }
  for (const match of text.matchAll(CARD_CANDIDATE_RE)) {
    const digits = match[0].replace(/\D/g, '');
    if (panShapePlausible(match[0]) && luhnValid(digits)) {
      matches.push({ kind: 'credit_card', start: match.index!, end: match.index! + match[0].length });
    }
  }
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  return matches.filter((match, i) => i === 0 || match.start >= matches[i - 1]!.end);
}

export interface RedactionResult {
  text: string;
  /** Kinds detected, in order (one entry per redacted span). */
  detections: DlpKind[];
}

/** Replaces every detected span with its visible marker. */
export function redactText(text: string): RedactionResult {
  const matches = findDlpMatches(text);
  if (matches.length === 0) return { text, detections: [] };
  let out = '';
  let pos = 0;
  const detections: DlpKind[] = [];
  for (const match of matches) {
    out += text.slice(pos, match.start) + DLP_MARKERS[match.kind];
    detections.push(match.kind);
    pos = match.end;
  }
  out += text.slice(pos);
  return { text: out, detections };
}
