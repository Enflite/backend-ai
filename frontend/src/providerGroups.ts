import type { Model, ProviderGroup } from './types';

/**
 * Resolve the effective provider group after the model list loads.
 *
 * The remembered (or initially guessed) group stands when it has servable
 * models; otherwise fall back to the first group with servable models,
 * preferring Claude. While OLLAMA_ENABLED=false the backend omits the
 * Enflite provider from /providers entirely and /models carries no Ollama
 * models, so a hard-coded Enflite fallback would strand the user on an
 * unusable provider — Claude becomes the usable default instead.
 */
export function resolveEffectiveProviderGroup(
  preferred: ProviderGroup,
  models: Pick<Model, 'enabled' | 'providerGroup'>[]
): ProviderGroup {
  const enabled = models.filter((model) => model.enabled);
  const groupHasModels = (group: ProviderGroup) =>
    enabled.some((model) => model.providerGroup === group);
  if (groupHasModels(preferred)) return preferred;
  return (['claude', 'openai', 'enflite'] as ProviderGroup[]).find(groupHasModels) ?? preferred;
}
