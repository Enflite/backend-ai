/**
 * @deprecated Import from `../providers/index.js` instead. This shim keeps
 * the historical import path working: it re-exports the OpenAI-compatible
 * chat provider under the legacy `streamChat` name.
 */
import { OpenAICompatibleProvider } from '../providers/openaiCompatible.js';
import { config } from '../../config.js';
import type { StreamChatOptions } from '../providers/types.js';

export type {
  ChatMessage,
  ProviderToolDefinition,
  TokenUsage,
  ProviderEvent,
  StreamChatOptions,
} from '../providers/types.js';

const makeProvider = () =>
  new OpenAICompatibleProvider({
    endpoint: '',
    apiKey: config.VLLM_API_KEY,
    defaultTimeoutMs: config.AI_REQUEST_TIMEOUT_MS,
  });

/** @deprecated Use `resolveChatProvider(model).streamChat(options)` instead. */
export function streamChat(options: StreamChatOptions) {
  return makeProvider().streamChat(options);
}
