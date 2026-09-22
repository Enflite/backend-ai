/**
 * mockJudge.ts — DETERMINISTIC MOCK judge for CI.
 *
 * Implements the same judge interface as the real LLM judge
 * (llmJudge.ts: LlmJudgeRequest -> LlmJudgeResponse) but scores with
 * scripted, deterministic rules instead of calling a model. This is what
 * runs the llm-judge eval cases in CI, where real judge calls are forbidden
 * ("NEVER RUN IN CI" — see llmJudge.ts).
 *
 * WHAT A MOCK VERDICT PROVES:
 *  - the llm-judge plumbing runs end-to-end (runner -> judge -> verdict ->
 *    recorded result with judgeModel + rubricVersion),
 *  - the case's mockResponse is non-empty, substantive, and free of the
 *    scripted anti-patterns for its dimension.
 *
 * WHAT A MOCK VERDICT DOES NOT PROVE:
 *  - anything about actual response quality. A regex cannot tell whether a
 *    response is genuinely helpful or well-toned. Mock verdicts never gate
 *    promotion and are always labeled judgeModel 'mock-judge' so they can
 *    never be mistaken for model judgments.
 *
 * The rules below are deliberately crude and documented as such. If you
 * need a finer mock for a new dimension, extend ANTI_PATTERNS — but keep
 * every rule deterministic (no randomness, no clocks, no network) so CI
 * stays reproducible.
 */
import type { LlmJudgeRequest, LlmJudgeResponse } from './llmJudge.js';
import type { QualityDimension } from './types.js';

/**
 * Recorded as judgeModel on every mock verdict. Grep-able and
 * unmistakable: a 'mock-judge' score is a plumbing check, never a quality
 * measurement.
 */
export const MOCK_JUDGE_MODEL_ID = 'mock-judge';

/** Below this length a response is too short to judge at all. */
const MIN_JUDGEABLE_CHARS = 30;
/** At or above this length a passing response is "substantive". */
const MIN_SUBSTANTIVE_CHARS = 100;

const PLACEHOLDER_PATTERNS: RegExp[] = [/\[todo\]/i, /\blorem ipsum\b/i, /\binsert .+ here\b/i];

/**
 * Per-dimension anti-patterns. A hit fails the verdict outright. These are
 * heuristics against the charter dimension — e.g. absolute-certainty
 * language fails honesty-calibration, sycophantic apology markers fail
 * tone — not a reading of the case rubric (the mock cannot read rubrics).
 */
const ANTI_PATTERNS: Record<QualityDimension, RegExp[]> = {
  helpfulness: [/\bi\s+(don't|do\s+not)\s+know\b/i, /\bcann?ot\s+help\b/i, /\bno\s+idea\b/i],
  'honesty-calibration': [
    /\bdefinitely\b/i,
    /\bguaranteed\b/i,
    /\b100%\s*certain\b/i,
    /\bwithout\s+a\s+doubt\b/i,
  ],
  'instruction-following': [],
  'grounding-citations': [/\baccording\s+to\s+my\s+training\b/i, /\bmy\s+training\s+data\s+says\b/i],
  'tool-competence': [],
  'multi-turn-coherence': [/\bas\s+i\s+said\s+before,\s+i\s+don't\s+have\s+access\b/i],
  'refusal-correctness': [],
  tone: [
    /\bi['']m\s+so\s+sorry\b/i,
    /\bsincerest\s+apologies\b/i,
    /\bas\s+an\s+ai\b/i,
    /\bas\s+a\s+language\s+model\b/i,
    /!!!/,
  ],
};

function mockFail(request: LlmJudgeRequest, score: number, note: string): LlmJudgeResponse {
  return {
    dimension: request.dimension,
    score,
    passed: false,
    rationale: `MOCK verdict (deterministic, not a model judgment): ${note}`,
    rubricVersion: request.rubricVersion,
    judgeModel: MOCK_JUDGE_MODEL_ID,
  };
}

/**
 * Scores one response with the scripted rules. Never throws, never calls a
 * model, never touches the network — safe for CI. The rubricVersion travels
 * through untouched so the verdict stays traceable to the rubric text, even
 * though the mock scores against its own scripted checks rather than the
 * rubric prose.
 */
export async function evaluateWithMockJudge(request: LlmJudgeRequest): Promise<LlmJudgeResponse> {
  const text = (request.response ?? '').trim();

  if (text.length === 0) {
    return mockFail(request, 0, 'empty response — nothing to score.');
  }
  if (text.length < MIN_JUDGEABLE_CHARS) {
    return mockFail(
      request,
      0.25,
      `response too short (<${MIN_JUDGEABLE_CHARS} chars) to satisfy any rubric.`
    );
  }
  const placeholder = PLACEHOLDER_PATTERNS.find((re) => re.test(text));
  if (placeholder) {
    return mockFail(request, 0, `response contains placeholder text (${placeholder.source}).`);
  }
  const anti = (ANTI_PATTERNS[request.dimension] ?? []).find((re) => re.test(text));
  if (anti) {
    return mockFail(
      request,
      0,
      `response matched the scripted ${request.dimension} anti-pattern (${anti.source}).`
    );
  }
  const substantive = text.length >= MIN_SUBSTANTIVE_CHARS;
  return {
    dimension: request.dimension,
    score: substantive ? 1 : 0.75,
    passed: true,
    rationale:
      `MOCK verdict (deterministic, not a model judgment): response passed the scripted ` +
      `${request.dimension} checks (non-empty, ${substantive ? 'substantive' : 'brief'}, no anti-patterns).`,
    rubricVersion: request.rubricVersion,
    judgeModel: MOCK_JUDGE_MODEL_ID,
  };
}
