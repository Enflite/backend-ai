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
export { OpenAIProvider } from './openai.js';
export type { OpenAIProviderConfig } from './openai.js';
export { ClaudeProvider } from './claude.js';
export type { ClaudeProviderConfig } from './claude.js';
export {
  PROVIDER_GROUPS,
  PROVIDER_GROUP_INFO,
  displayNameForModel,
  prettifyModelName,
  providerGroupFor,
  providerLabelFor,
  isProviderGroup,
} from './providerDisplay.js';
export type { ProviderGroup, ProviderGroupInfo } from './providerDisplay.js';
export {
  resolveChatProvider,
  resolveEmbeddingProvider,
  isKnownChatProvider,
  KNOWN_CHAT_PROVIDERS,
} from './factory.js';
export type { ProviderModelRef, EmbeddingProviderKind, KnownChatProvider } from './factory.js';
