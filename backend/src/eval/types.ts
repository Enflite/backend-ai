/**
 * types.ts — the eval framework's public contract.
 *
 * The corpus worker (Phase 2 workstream B) builds eval cases against these
 * exact types. Field names are frozen: do not rename or restructure without
 * coordinating with the corpus workstream.
 */

export type EvalCategory =
  | 'reasoning' | 'coding' | 'json-output' | 'tool-selection' | 'tool-args'
  | 'rag-retrieval' | 'rag-grounding' | 'citation-accuracy' | 'hallucination'
  | 'prompt-injection' | 'exfiltration' | 'tenant-isolation' | 'classification'
  | 'long-context' | 'multi-turn' | 'syteline' | 'refusal' | 'failure-handling'
  | 'malformed-input' | 'adversarial' | 'sensitive-data';

/**
 * QualityDimension — the 8 behavioral dimensions from the Assistant Quality
 * Charter (docs/assistant-quality.md §5 "Measuring quality"). This list is
 * the charter's, verbatim in kebab-case; do not extend or rename without
 * updating the charter.
 */
export type QualityDimension =
  | 'helpfulness'            // §2.1 — does the response move the task forward?
  | 'honesty-calibration'    // §2.2 — no invented facts; uncertainty stated
  | 'instruction-following'  // follows the request, format, and constraints
  | 'grounding-citations'    // §2.3 — claims trace to retrieved chunks
  | 'tool-competence'        // correct tool, valid args, recovers from failure
  | 'multi-turn-coherence'   // consistent across turns; uses history correctly
  | 'refusal-correctness'    // §2.7 — refuses only what policy forbids
  | 'tone';                  // §2.6 — direct, warm, non-sycophantic

export interface EvalToolDef {
  name: string;
  description: string;
  parameters: unknown;
}

export interface EvalJudgeSpec {
  kind: 'contains' | 'not-contains' | 'json-schema' | 'refusal' | 'citation-grounding' | 'tool-call' | 'tool-chain' | 'no-exfiltration' | 'llm-judge';
  expectedSubstrings?: string[];
  forbiddenSubstrings?: string[];
  jsonSchema?: unknown;
  requiredCitations?: string[];
  expectedTool?: string;
  expectedToolArgs?: Record<string, unknown>;
  /**
   * tool-chain only: expected tool names in call order. The verdict passes
   * when the assistant's tool calls contain this sequence as an ordered
   * subsequence (extra calls between steps are allowed), the synthesized
   * content contains every expectedSubstrings entry (the cited evidence),
   * and none of forbiddenSubstrings appears. This is how agentic,
   * multi-step SyteLine investigations ("why is this order late?") are
   * scored deterministically: correct chain + correct root cause + no
   * invented records.
   */
  expectedToolChain?: string[];
  /** llm-judge only: which charter dimension this case scores. */
  dimension?: QualityDimension;
  /** llm-judge only: case-specific rubric; when omitted the versioned default for `dimension` is used. */
  rubric?: string;
}

export interface EvalCase {
  id: string;
  category: EvalCategory;
  title: string;
  description: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: EvalToolDef[];
  ragContext?: Array<{ chunkId: string; documentId: string; text: string }>;
  judge: EvalJudgeSpec;
  mockResponse?: string | { toolCalls: Array<{ name: string; args: unknown }>; content?: string };
  severity: 'p0' | 'p1' | 'p2';
  /**
   * Charter quality dimensions this case exercises. Omit = uncategorized
   * (the case still runs and judges normally; it just contributes to no
   * dimension breakdown).
   */
  dimensions?: QualityDimension[];
}

export interface EvalCaseResult {
  caseId: string;
  category: EvalCategory;
  severity: string;
  passed: boolean;
  score: number;
  details: unknown;
  latencyMs: number;
  /**
   * True when the case did not run (currently: llm-judge cases with no judge
   * model configured). Skipped cases are excluded from total/passed/failed,
   * byCategory, byDimension, and p0Failed — they are reported, never gated.
   */
  skipped?: boolean;
}

export interface EvalRunSummary {
  runId: string;
  modelId: string;
  modelVersion: string;
  total: number;
  passed: number;
  failed: number;
  byCategory: Record<string, { passed: number; total: number }>;
  p0Failed: string[];
  /**
   * Per-dimension pass-rate breakdown (charter §5). Computed only over cases
   * that actually ran — skipped cases are excluded. A case with multiple
   * dimensions contributes its verdict to each.
   */
  byDimension: Record<string, { passed: number; total: number }>;
  /** Cases skipped without running (llm-judge without a judge model). */
  skipped: number;
}
