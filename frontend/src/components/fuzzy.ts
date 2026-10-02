/**
 * components/fuzzy.ts — dependency-free fuzzy subsequence matcher.
 *
 * Used by the command palette (and anywhere else that needs ranked
 * typeahead): scores how well `query` matches `target`, with ranking
 * prefix > word-boundary > plain subsequence.
 *
 * Returns `null` when the query is not a subsequence of the target (no
 * match); otherwise a finite non-negative score, or `Infinity` for an
 * exact match. Higher is better. Scores are only meaningful relative to
 * each other for the same query — never persist or display them.
 */

function isBoundaryChar(ch: string): boolean {
  return (
    ch === ' ' || ch === '\t' || ch === '-' || ch === '_' ||
    ch === '/' || ch === '.' || ch === ':' || ch === '(' || ch === '['
  );
}

export function fuzzyScore(query: string, target: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const t = target.toLowerCase();
  if (t.length === 0) return null;
  if (t === q) return Number.POSITIVE_INFINITY;

  // Prefix matches outrank everything else.
  if (t.startsWith(q)) {
    // Shorter targets win among prefixes.
    return 1000 + Math.max(0, 100 - t.length);
  }

  // Greedy subsequence scan.
  const positions: number[] = [];
  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      positions.push(ti);
      qi++;
    }
  }
  if (qi < q.length) return null;

  let score = 100;
  const first = positions[0]!;
  const last = positions[positions.length - 1]!;

  // Word-boundary start: the match begins a word (but isn't a prefix).
  if (isBoundaryChar(t[first - 1]!)) score += 60;

  // Consecutive-character runs: matches that don't skip around.
  for (let k = 1; k < positions.length; k++) {
    if (positions[k] === positions[k - 1]! + 1) score += 8;
  }

  // Compactness: penalize matches spread across a long span.
  score -= (last - first) * 0.5;
  // Shorter targets win ties.
  score += 20 / (1 + t.length / 20);
  return score;
}

/**
 * Best score across a set of candidate fields. Returns `null` when the
 * query matches none of them.
 */
export function fuzzyScoreFields(query: string, fields: string[]): number | null {
  let best: number | null = null;
  for (const field of fields) {
    const score = fuzzyScore(query, field);
    if (score !== null && (best === null || score > best)) best = score;
  }
  return best;
}

/**
 * Filter + rank items by fuzzy score against the given fields. Items with
 * no match are dropped; ties keep their original (stable) order. An empty
 * query returns every item, unscored, in original order.
 */
export function rankFuzzy<T>(
  query: string,
  items: T[],
  fields: (item: T) => string[],
): T[] {
  const q = query.trim();
  if (q.length === 0) return [...items];
  return items
    .map((item, index) => ({ item, index, score: fuzzyScoreFields(q, fields(item)) }))
    .filter((entry) => entry.score !== null)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.index - b.index)
    .map((entry) => entry.item);
}
