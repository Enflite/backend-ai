/**
 * detectors.ts — deterministic PII detectors for the assistant outbound
 * boundary (Phase 5c).
 *
 * Built-in detectors (always on when DLP is enabled):
 *  - US Social Security numbers: dashed form `\d{3}-\d{2}-\d{4}`.
 *  - Credit-card-looking numbers: 13–19 digit runs (spaces/dashes allowed)
 *    that pass the Luhn check, which filters out order numbers, UUIDs, and
 *    other digit runs that merely look long.
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
    if (luhnValid(digits)) {
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
