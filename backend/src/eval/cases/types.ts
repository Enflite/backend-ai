/**
 * Local copy of the eval framework contract (see backend/src/eval/types.ts,
 * built by the parallel framework worker). Kept verbatim here so the case
 * corpus compiles and runs in CI without depending on the framework PR.
 * The merge coordinator will reconcile the duplicate.
 */
export type EvalCategory =
  | 'reasoning'
  | 'coding'
  | 'json-output'
  | 'tool-selection'
  | 'tool-args'
  | 'rag-retrieval'
  | 'rag-grounding'
  | 'citation-accuracy'
  | 'hallucination'
  | 'prompt-injection'
  | 'exfiltration'
  | 'tenant-isolation'
  | 'classification'
  | 'long-context'
  | 'multi-turn'
  | 'syteline'
  | 'refusal'
  | 'failure-handling'
  | 'malformed-input'
  | 'adversarial'
  | 'sensitive-data';

export interface EvalCase {
  id: string;
  category: EvalCategory;
  title: string;
  description: string;
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  tools?: Array<{ name: string; description: string; parameters: unknown }>;
  ragContext?: Array<{ chunkId: string; documentId: string; text: string }>;
  judge: {
    kind:
      | 'contains'
      | 'not-contains'
      | 'json-schema'
      | 'refusal'
      | 'citation-grounding'
      | 'tool-call'
      | 'no-exfiltration';
    expectedSubstrings?: string[];
    forbiddenSubstrings?: string[];
    jsonSchema?: unknown;
    requiredCitations?: string[];
    expectedTool?: string;
    expectedToolArgs?: Record<string, unknown>;
  };
  mockResponse?: string | { toolCalls: Array<{ name: string; args: unknown }>; content?: string };
  severity: 'p0' | 'p1' | 'p2';
}
