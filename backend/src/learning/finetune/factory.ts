/**
 * finetune/factory.ts — the single place fine-tune providers are constructed.
 *
 * Application code never constructs a provider directly and never reads
 * FINETUNE_* env vars itself; it asks this factory. This keeps the
 * feature-flag toggle, the dev-only gates, and the allowlist checks in one
 * auditable place (same convention as ai/providers/factory.ts).
 *
 * Toggle (env FINETUNE_PROVIDER):
 *   disabled (default) → training is off; job creation throws.
 *   external           → 3rd-party fine-tuning service (testing path).
 *   local              → self-hosted GPU workers via the finetune_jobs queue.
 */
import { config } from '../../config.js';
import { Errors } from '../../errors.js';
import type { FineTuneProvider } from './types.js';
import { ExternalFineTuneProvider } from './externalProvider.js';
import { LocalFineTuneProvider } from './localProvider.js';

export type FineTuneProviderKind = 'disabled' | 'external' | 'local';

export function getFineTuneProviderKind(): FineTuneProviderKind {
  return config.FINETUNE_PROVIDER;
}

export function isFineTuningEnabled(): boolean {
  return config.FINETUNE_PROVIDER !== 'disabled';
}

/**
 * Resolve the active fine-tune provider. Throws when training is disabled
 * (the kill switch) so callers fail closed.
 */
export function resolveFineTuneProvider(): FineTuneProvider {
  switch (config.FINETUNE_PROVIDER) {
    case 'external':
      return new ExternalFineTuneProvider();
    case 'local':
      return new LocalFineTuneProvider();
    case 'disabled':
    default:
      throw Errors.forbidden(
        'FINETUNE_DISABLED',
        'Fine-tuning is disabled on this server (FINETUNE_PROVIDER=disabled)'
      );
  }
}
