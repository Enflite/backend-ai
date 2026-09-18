/**
 * providers/index.ts — public surface of the provider abstraction.
 */
export * from './types.js';
export { OpenAICompatibleProvider } from './openaiCompatible.js';
export type { OpenAICompatibleProviderConfig } from './openaiCompatible.js';
export { OpenAICompatibleEmbeddingProvider } from './openaiEmbeddings.js';
export type { OpenAIEmbeddingProviderConfig } from './openaiEmbeddings.js';
export { OllamaProvider } from './ollama.js';
export type { OllamaProviderConfig } from './ollama.js';
export {
  resolveChatProvider,
  resolveEmbeddingProvider,
  isKnownChatProvider,
  KNOWN_CHAT_PROVIDERS,
} from './factory.js';
export type { ProviderModelRef, EmbeddingProviderKind, KnownChatProvider } from './factory.js';
