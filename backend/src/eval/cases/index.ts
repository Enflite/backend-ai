import type { EvalCase } from './types.js';
import { REASONING_CASES } from './reasoning.js';
import { CODING_CASES } from './coding.js';
import { JSON_OUTPUT_CASES } from './jsonOutput.js';
import { TOOL_SELECTION_CASES, TOOL_ARGS_CASES, SYTELINE_CASES } from './tools.js';
import {
  RAG_RETRIEVAL_CASES,
  RAG_GROUNDING_CASES,
  CITATION_ACCURACY_CASES,
  HALLUCINATION_CASES,
} from './rag.js';
import {
  PROMPT_INJECTION_CASES,
  EXFILTRATION_CASES,
  TENANT_ISOLATION_CASES,
  CLASSIFICATION_CASES,
} from './security.js';
import { LONG_CONTEXT_CASES, REFUSAL_CASES } from './longContext.js';
import {
  FAILURE_HANDLING_CASES,
  MALFORMED_INPUT_CASES,
  ADVERSARIAL_CASES,
  SENSITIVE_DATA_CASES,
} from './robustness.js';
import { QUALITY_CASES } from './quality.js';

export type { EvalCase, EvalCategory, QualityDimension } from './types.js';

/** The full evaluation case corpus: deterministic CI cases plus llm-judge cases (skipped without a judge model). */
export const EVAL_CORPUS: EvalCase[] = [
  ...REASONING_CASES,
  ...CODING_CASES,
  ...JSON_OUTPUT_CASES,
  ...TOOL_SELECTION_CASES,
  ...TOOL_ARGS_CASES,
  ...SYTELINE_CASES,
  ...RAG_RETRIEVAL_CASES,
  ...RAG_GROUNDING_CASES,
  ...CITATION_ACCURACY_CASES,
  ...HALLUCINATION_CASES,
  ...PROMPT_INJECTION_CASES,
  ...EXFILTRATION_CASES,
  ...TENANT_ISOLATION_CASES,
  ...CLASSIFICATION_CASES,
  ...LONG_CONTEXT_CASES,
  ...REFUSAL_CASES,
  ...FAILURE_HANDLING_CASES,
  ...MALFORMED_INPUT_CASES,
  ...ADVERSARIAL_CASES,
  ...SENSITIVE_DATA_CASES,
  ...QUALITY_CASES,
];
