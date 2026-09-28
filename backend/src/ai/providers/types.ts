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
  /**
   * Vision inputs attached to a user message. Only vision-capable models may
   * receive them: providers map these to `images` (Ollama) or `image_url`
   * content parts (OpenAI-compatible). Text-only models must never be
   * offered a message carrying images — the chat route resolves a vision
   * model for turns that attach images.
   */
  images?: ChatImage[];
}

/**
 * One vision input: raw image bytes, base64-encoded (no `data:` URL prefix),
 * plus the MIME type so providers can build data URLs when the API needs
 * them. The bytes come from the platform's own object storage, already
 * validated at upload (magic bytes) and scanned for malware during ingestion.
 */
export interface ChatImage {
  /** Base64-encoded image bytes (no data-URL prefix). */
  data: string;
  /** MIME type, e.g. 'image/png'. */
  mimeType: string;
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
  | { type: 'usage'; usage: TokenUsage }
  /**
   * A provider-executed server-side tool (e.g. Claude's native web_search).
   * Executed by the provider itself, never by the agent — the agentic loop
   * must not treat it as a client tool call.
   */
  | { type: 'server_tool'; name: string };

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
  /**
   * Enable the provider's native server-side web search (Claude's
   * web_search tool). Only meaningful for Claude; other providers ignore
   * it. The chat route sets it only on Claude-routed turns, which are by
   * construction free of sensitive data (privacy routing) — local Enflite
   * turns stay offline-only.
   */
  enableNativeWebSearch?: boolean;
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
