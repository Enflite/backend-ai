/**
 * providers/factory.ts — the single place providers are constructed.
 *
 * Application code (gateway, ingestion, retrieval) never constructs a
 * provider directly and never reads provider env vars itself; it asks the
 * factory. This keeps every connection parameter and allowlist check in
 * one auditable place.
 *
 * Security-boundary note: the factory makes NO trust decisions. The AI
 * Gateway authorizes every call BEFORE a provider is constructed — model
 * approval, endpoint allowlist (AI_PROVIDER_ALLOWED_ORIGINS),
 * classification policy, tenant grants, DLP. Ollama is the primary
 * inference provider (Windows-native, GPU-capable) and needs no special
 * gate: the gateway's authorization is the boundary, not the provider
 * binary. vLLM remains a supported provider for high-throughput
 * Linux deployments.
 */
import { config } from '../../config.js';
import { AppError, Errors } from '../../errors.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { OpenAICompatibleEmbeddingProvider } from './openaiEmbeddings.js';
import { OpenAIProvider } from './openai.js';
import { ClaudeProvider } from './claude.js';
import { OllamaProvider } from './ollama.js';

/** Minimal model fields the factory needs to pick and configure a provider. */
export interface ProviderModelRef {
  provider: string;
  endpoint: string;
  modelIdentifier: string;
  requestTimeoutMs: number | null;
  maxTokens: number | null;
  temperature: number | null;
}

/**
 * Fail closed when the operator disabled local Ollama inference: nothing
 * may construct an Ollama client (chat or embeddings) while
 * OLLAMA_ENABLED=false — not the gateway, not indexing, not the CLI.
 * The error names the flag so the fix is obvious. This is an intentional
 * operator choice (launch runs Claude-only), not an outage, so the 503
 * message says so.
 */
function assertOllamaEnabled(operation: string): void {
  if (config.OLLAMA_ENABLED) return;
  throw new AppError(
    503,
    'OLLAMA_DISABLED',
    `Local Ollama inference is disabled (OLLAMA_ENABLED=false): ${operation} is unavailable. ` +
      `Set OLLAMA_ENABLED=true to re-enable the local Enflite provider.`
  );
}

/**
 * Resolve the chat provider for a registry model. The gateway calls this
 * AFTER authorizing the model (approval, endpoint allowlist, classification
 * policy) — the factory only picks the wire protocol.
 */
export function resolveChatProvider(model: ProviderModelRef): ChatProvider {
  const defaultTimeoutMs = config.AI_REQUEST_TIMEOUT_MS;
  switch (model.provider) {
    case 'vllm':
    case 'openai-compatible':
      return new OpenAICompatibleProvider({
        endpoint: model.endpoint,
        apiKey: config.VLLM_API_KEY,
        defaultTimeoutMs,
      });
    case 'ollama':
      // Primary inference provider when OLLAMA_ENABLED=true. No dev-only
      // gate: the gateway authorizes the model (approval, endpoint
      // allowlist, classification) before the factory ever constructs a
      // provider — but a disabled flag fails closed before any client is
      // built, so nothing ever dials a host the operator turned off.
      assertOllamaEnabled('Ollama chat');
      return new OllamaProvider({
        endpoint: model.endpoint,
        defaultTimeoutMs,
        embeddingModel: config.OLLAMA_EMBEDDING_MODEL,
        embeddingDimensions: config.OLLAMA_EMBEDDING_DIMENSIONS,
      });
    case 'claude':
      // Anthropic cloud API. The gateway authorizes the model before the
      // factory constructs this provider; the key travels only in the
      // x-api-key header and is never logged or surfaced.
      return new ClaudeProvider({
        endpoint: model.endpoint || config.ANTHROPIC_BASE_URL,
        apiKey: config.ANTHROPIC_API_KEY,
        defaultTimeoutMs,
      });
    case 'openai':
      // OpenAI cloud API (wire-compatible with the generic provider, but
      // a named first-class provider with its own endpoint and key).
      return new OpenAIProvider({
        endpoint: model.endpoint || config.OPENAI_BASE_URL,
        apiKey: config.OPENAI_API_KEY,
        defaultTimeoutMs,
      });
    default:
      throw Errors.forbidden('MODEL_PROVIDER_UNSUPPORTED', 'Model provider is not supported by this gateway');
  }
}

export type EmbeddingProviderKind = 'openai-compatible' | 'ollama';

/**
 * Resolve the platform embedding provider from server configuration.
 * Document ingestion and RAG retrieval both use this — there is exactly
 * one embedding call site family, and it lives behind this factory.
 */
export function resolveEmbeddingProvider(kind?: EmbeddingProviderKind): EmbeddingProvider {
  const selected: EmbeddingProviderKind = kind ?? config.EMBEDDING_PROVIDER;
  switch (selected) {
    case 'openai-compatible': {
      if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
        throw Errors.internal(
          'Internal embedding provider is not configured',
          undefined,
          'EMBEDDING_NOT_CONFIGURED'
        );
      }
      return new OpenAICompatibleEmbeddingProvider({
        endpoint: config.EMBEDDING_BASE_URL,
        apiKey: config.EMBEDDING_API_KEY,
        model: config.EMBEDDING_MODEL,
        version: config.EMBEDDING_MODEL_VERSION,
        dimensions: config.EMBEDDING_DIMENSIONS,
        defaultTimeoutMs: config.EMBEDDING_TIMEOUT_MS,
      });
    }
    case 'ollama': {
      // Primary embedding provider when OLLAMA_ENABLED=true. No dev-only
      // gate (see chat case above) — but a disabled flag fails closed with
      // a flag-named error so indexing/embedding operations report the
      // actual cause instead of a connection timeout.
      assertOllamaEnabled('Ollama embeddings');
      return new OllamaProvider({
        endpoint: config.OLLAMA_BASE_URL,
        defaultTimeoutMs: config.EMBEDDING_TIMEOUT_MS,
        embeddingModel: config.OLLAMA_EMBEDDING_MODEL,
        embeddingDimensions: config.OLLAMA_EMBEDDING_DIMENSIONS,
      }).asEmbeddingProvider();
    }
    default:
      throw Errors.internal('Unknown embedding provider kind', { kind: selected }, 'EMBEDDING_PROVIDER_UNKNOWN');
  }
}

/** The provider kinds the platform knows how to speak to. */
export const KNOWN_CHAT_PROVIDERS = ['vllm', 'openai-compatible', 'ollama', 'claude', 'openai'] as const;
export type KnownChatProvider = (typeof KNOWN_CHAT_PROVIDERS)[number];

export function isKnownChatProvider(value: string): value is KnownChatProvider {
  return (KNOWN_CHAT_PROVIDERS as readonly string[]).includes(value);
}
