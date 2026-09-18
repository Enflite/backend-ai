/**
 * providers/factory.ts — the single place providers are constructed.
 *
 * Application code (gateway, ingestion, retrieval) never constructs a
 * provider directly and never reads provider env vars itself; it asks the
 * factory. This keeps every connection parameter, dev-only gate, and
 * allowlist check in one auditable place.
 *
 * Dev-only rule: the Ollama provider is refused unless ALLOW_DEV_PROVIDERS
 * is explicitly enabled. Ollama is a workstation convenience, never a
 * security boundary and never a production path.
 */
import { config } from '../../config.js';
import { Errors } from '../../errors.js';
import type { ChatProvider, EmbeddingProvider } from './types.js';
import { OpenAICompatibleProvider } from './openaiCompatible.js';
import { OpenAICompatibleEmbeddingProvider } from './openaiEmbeddings.js';
import { OllamaProvider } from './ollama.js';

/** Minimal model fields the factory needs to pick and configure a provider. */
export interface ProviderModelRef {
  provider: string;
  endpoint: string;
  model_identifier: string;
  request_timeout_ms: number | null;
  max_tokens: number | null;
  temperature: number | null;
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
      if (!config.ALLOW_DEV_PROVIDERS) {
        throw Errors.forbidden(
          'MODEL_PROVIDER_DEV_ONLY',
          'Ollama models are for local development only and dev providers are not enabled on this server'
        );
      }
      return new OllamaProvider({
        endpoint: model.endpoint,
        defaultTimeoutMs,
        embeddingModel: config.OLLAMA_EMBEDDING_MODEL,
        embeddingDimensions: config.OLLAMA_EMBEDDING_DIMENSIONS,
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
      if (!config.ALLOW_DEV_PROVIDERS) {
        throw Errors.forbidden(
          'EMBEDDING_PROVIDER_DEV_ONLY',
          'Ollama embeddings are for local development only and dev providers are not enabled on this server'
        );
      }
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
export const KNOWN_CHAT_PROVIDERS = ['vllm', 'openai-compatible', 'ollama'] as const;
export type KnownChatProvider = (typeof KNOWN_CHAT_PROVIDERS)[number];

export function isKnownChatProvider(value: string): value is KnownChatProvider {
  return (KNOWN_CHAT_PROVIDERS as readonly string[]).includes(value);
}
