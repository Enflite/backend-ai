import { describe, expect, it } from 'vitest';
import { resolveEffectiveProviderGroup } from './providerGroups';
import type { ProviderGroup } from './types';

const model = (providerGroup: ProviderGroup) => ({ enabled: true, providerGroup });

describe('resolveEffectiveProviderGroup', () => {
  it('keeps the remembered group when it has servable models', () => {
    const models = [model('claude'), model('enflite')];
    expect(resolveEffectiveProviderGroup('enflite', models)).toBe('enflite');
    expect(resolveEffectiveProviderGroup('claude', models)).toBe('claude');
  });

  it('falls back to Claude when Enflite is absent (OLLAMA_ENABLED=false backend)', () => {
    // The backend omits Enflite from /providers and carries no Ollama
    // models, so a remembered Enflite preference must not strand the user
    // on an unusable provider.
    const models = [model('claude')];
    expect(resolveEffectiveProviderGroup('enflite', models)).toBe('claude');
  });

  it('prefers Claude, then OpenAI, then Enflite when the remembered group is unusable', () => {
    const models = [model('openai'), model('enflite')];
    expect(resolveEffectiveProviderGroup('claude', models)).toBe('openai');
    expect(resolveEffectiveProviderGroup('enflite', models)).toBe('enflite');
  });

  it('ignores disabled models when resolving', () => {
    const models = [{ enabled: false, providerGroup: 'enflite' as ProviderGroup }, model('claude')];
    expect(resolveEffectiveProviderGroup('enflite', models)).toBe('claude');
  });

  it('returns the remembered group as a last resort when nothing is servable', () => {
    expect(resolveEffectiveProviderGroup('enflite', [])).toBe('enflite');
  });
});
