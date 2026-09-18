/**
 * providers/types.ts — the private-inference provider abstraction.
 *
 * Every model call in the platform goes through these interfaces. Concrete
 * providers (OpenAI-compatible HTTP for vLLM/production, Ollama for local
 * dev) implement them; application code never touches provider HTTP
 * directly. This is the seam that lets Enflite swap models and inference
 * backends without touching chat, RAG, eval, or tooling code.
 *
 * Security invariants enforced by callers, not by providers:
 * - The AI Gateway authorizes the model, checks the endpoint allowlist,
 *   and enforces classification policy BEFORE a provider is constructed.
 * - Providers never see credentials except the per-endpoint API key they
 *   are constructed with; they never read process env themselves.
 * - Streaming inference is never retried (non-idempotent, often billed);
 *   the gateway fails over to another model instead. Embeddings ARE
 *   idempotent and may use bounded retries (see the embedding provider).
 */

export interface ChatMessage {
  role: string;
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

/** OpenAI-compatible function tool definition sent to the provider. */
export interface ProviderToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

/** Events produced while streaming a chat completion. */
export type ProviderEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; arguments: string }
  | { type: 'usage'; usage: TokenUsage };

export interface StreamChatOptions {
  /** Provider endpoint base URL, already allowlisted by the gateway. */
  endpoint: string;
  /** Provider-side model identifier (e.g. "meta-llama/Meta-Llama-3.1-8B-Instruct"). */
  model: string;
  messages: ChatMessage[];
  tools?: ProviderToolDefinition[];
  /** Override the server default inference timeout for this call. */
  timeoutMs?: number;
  maxTokens?: number | null;
  temperature?: number | null;
  signal?: AbortSignal;
}

export interface EmbedOptions {
  /** Override the server default embedding timeout for this call. */
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Second argument to `embed`: an options bag, or a bare AbortSignal. */
export type EmbedArg = EmbedOptions | AbortSignal;

export function normalizeEmbedArg(arg: EmbedArg | undefined): EmbedOptions {
  if (arg instanceof AbortSignal) return { signal: arg };
  return arg ?? {};
}

/**
 * A chat-completion provider. Implementations stream provider events;
 * exactly one attempt per call — no retries on streaming inference.
 */
export interface ChatProvider {
  readonly kind: string;
  streamChat(options: StreamChatOptions): AsyncGenerator<ProviderEvent, void, unknown>;
}

/**
 * An embedding provider. Embeddings are idempotent, so implementations
 * may use a small bounded retry with backoff on transient failures.
 */
export interface EmbeddingProvider {
  readonly kind: string;
  /** Provider-side embedding model name (pinned into document_chunks). */
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(texts: string[], options?: EmbedArg): Promise<number[][]>;
}

/** A provider that does both chat and embeddings (e.g. Ollama). */
export interface ModelProvider extends ChatProvider {
  asEmbeddingProvider(): EmbeddingProvider;
}
