import { afterEach, describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  buildCacheableSystemPrompt,
  assertStaticPrefix,
  hashPromptPrefix,
  verifyPrefixDeterministic,
} from '../src/ai/gateway/prefixCache.js';
import { buildSystemPrompt, buildStaticPromptHead } from '../src/chat/systemPrompt.js';
import { SYTELINE_EXPERT_KNOWLEDGE } from '../src/chat/sytelineExpertKnowledge.js';

const baseOptions = {
  modelName: 'Test Model',
  modelVersion: '1',
  toolsAvailable: true,
  sytelineToolsAvailable: false,
  codingMode: false,
  repoToolsAvailable: false,
};

const sytelineOptions = { ...baseOptions, sytelineToolsAvailable: true };
const codingOptions = { ...baseOptions, codingMode: true, repoToolsAvailable: true };

afterEach(() => {
  // Config is a process-wide singleton: any test that mutates it must
  // restore the default so other suites are unaffected.
  config.PROMPT_CACHE_ENABLED = true;
});

describe('prefixCache: byte-stability across turns', () => {
  it('assembles byte-identical prompts for identical options (simulated turns)', () => {
    // Two turns of the same conversation: different user content, same
    // turn options. The system prompt must be byte-identical so vLLM's
    // automatic prefix caching reuses the KV blocks.
    const turn1 = buildCacheableSystemPrompt(baseOptions);
    const turn2 = buildCacheableSystemPrompt(baseOptions);
    expect(turn1.text).toBe(turn2.text);
    expect(turn1.hash).toBe(turn2.hash);
    expect(turn1.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the builder is deterministic for every capability variant', () => {
    for (const options of [baseOptions, sytelineOptions, codingOptions, {}, { toolsAvailable: false }]) {
      expect(verifyPrefixDeterministic(options)).toBe(true);
      const a = buildCacheableSystemPrompt(options);
      const b = buildCacheableSystemPrompt(options);
      expect(a.text).toBe(b.text);
      expect(a.hash).toBe(b.hash);
    }
  });

  it('every variant starts with the byte-stable static head', () => {
    const head = buildStaticPromptHead();
    expect(head.length).toBeGreaterThan(1000);
    for (const options of [baseOptions, sytelineOptions, codingOptions, {}]) {
      const { text } = buildCacheableSystemPrompt(options);
      expect(text.startsWith(head)).toBe(true);
      assertStaticPrefix(text);
    }
  });

  it('hashPromptPrefix is stable and distinguishes different prompts', () => {
    const a = buildCacheableSystemPrompt(baseOptions);
    const b = buildCacheableSystemPrompt(sytelineOptions);
    expect(hashPromptPrefix(a.text)).toBe(a.hash);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('prefixCache: no dynamic content in the cached region', () => {
  it('per-model identity appears only AFTER the static head', () => {
    const head = buildStaticPromptHead();
    const withModel = buildCacheableSystemPrompt({ modelName: 'Model A', modelVersion: '9' }).text;
    const otherModel = buildCacheableSystemPrompt({ modelName: 'Model B', modelVersion: '2' }).text;
    // Same static head regardless of model ...
    expect(withModel.slice(0, head.length)).toBe(head);
    expect(otherModel.slice(0, head.length)).toBe(head);
    // ... and the model name never leaks into it.
    expect(head).not.toContain('Model A');
    expect(head).not.toContain('Model B');
    expect(withModel.indexOf('Model A')).toBeGreaterThan(head.length);
  });

  it('capability variants share the identical static head', () => {
    const head = buildStaticPromptHead();
    const plain = buildCacheableSystemPrompt(baseOptions).text;
    const syteline = buildCacheableSystemPrompt(sytelineOptions).text;
    const coding = buildCacheableSystemPrompt(codingOptions).text;
    expect(plain.slice(0, head.length)).toBe(head);
    expect(syteline.slice(0, head.length)).toBe(head);
    expect(coding.slice(0, head.length)).toBe(head);
    // The SyteLine knowledge pack is real content in the tail, not the head.
    expect(syteline).toContain(SYTELINE_EXPERT_KNOWLEDGE);
    expect(head).not.toContain(SYTELINE_EXPERT_KNOWLEDGE);
  });

  it('the static head carries no timestamps, request IDs, or per-turn values', () => {
    const head = buildStaticPromptHead();
    expect(head).not.toMatch(/\d{4}-\d{2}-\d{2}/); // dates
    expect(head).not.toMatch(/\d{2}:\d{2}(:\d{2})?/); // times
    expect(head).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/i); // UUIDs
    expect(head).not.toContain('tenantId');
    expect(head).not.toContain('userId');
    expect(head).not.toContain('requestId');
  });

  it('assertStaticPrefix throws when the head is violated', () => {
    const { text } = buildCacheableSystemPrompt(baseOptions);
    expect(() => assertStaticPrefix(`turn-id: 123\n${text}`)).toThrow(/prefix-cache violation/);
    expect(() => assertStaticPrefix('completely different prompt')).toThrow(/prefix-cache violation/);
    // The plain builder output always satisfies the contract.
    expect(() => assertStaticPrefix(buildSystemPrompt(baseOptions))).not.toThrow();
  });
});

describe('prefixCache: PROMPT_CACHE_ENABLED flag', () => {
  it('defaults to true', () => {
    expect(config.PROMPT_CACHE_ENABLED).toBe(true);
  });

  it('when disabled, returns the same content with no hash and no assertion', () => {
    config.PROMPT_CACHE_ENABLED = false;
    const cached = buildCacheableSystemPrompt(baseOptions);
    // Same model-visible content as the plain builder ...
    expect(cached.text).toBe(buildSystemPrompt(baseOptions));
    // ... but the contract is off: no hash issued.
    expect(cached.hash).toBe('');
  });

  it('when enabled, issues a hash for the assembled prompt', () => {
    const cached = buildCacheableSystemPrompt(baseOptions);
    expect(cached.hash).toBe(hashPromptPrefix(cached.text));
  });
});
