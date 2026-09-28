/**
 * providers/openai.ts — first-class OpenAI API chat provider.
 *
 * The OpenAI cloud API is wire-compatible with the generic
 * OpenAI-compatible provider, so this subclasses it: one tested
 * implementation, one wire protocol. The subclass exists so the factory,
 * capability routing, and UI can treat "OpenAI" as a named provider with
 * its own endpoint default and API key — distinct from a self-hosted
 * vLLM/OpenAI-compatible endpoint.
 */
import { OpenAICompatibleProvider, type OpenAICompatibleProviderConfig } from './openaiCompatible.js';

export interface OpenAIProviderConfig extends OpenAICompatibleProviderConfig {}

export class OpenAIProvider extends OpenAICompatibleProvider {
  readonly kind = 'openai';

  constructor(config: OpenAIProviderConfig) {
    super(config);
  }
}
