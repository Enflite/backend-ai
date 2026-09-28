/**
 * providerDisplay.test.ts — user-facing provider identity (ADR-018).
 *
 * Pure functions: provider group mapping, labels, and friendly model
 * display names. The headline rule: "Ollama" never appears in user-facing
 * strings, and raw registry IDs never reach the UI for known models.
 */
import { describe, expect, it } from 'vitest';
import {
  PROVIDER_GROUPS,
  PROVIDER_GROUP_INFO,
  displayNameForModel,
  isProviderGroup,
  prettifyModelName,
  providerGroupFor,
  providerLabelFor,
} from '../src/ai/providers/providerDisplay.js';

describe('provider groups', () => {
  it('exposes exactly Enflite, Claude, and OpenAI', () => {
    expect([...PROVIDER_GROUPS]).toEqual(['enflite', 'claude', 'openai']);
  });

  it('never labels anything "Ollama" for users', () => {
    for (const group of PROVIDER_GROUPS) {
      expect(PROVIDER_GROUP_INFO[group].label).not.toMatch(/ollama/i);
    }
    expect(providerLabelFor('ollama')).toBe('Enflite');
  });

  it('maps self-hosted kinds to the Enflite group', () => {
    expect(providerGroupFor('ollama')).toBe('enflite');
    expect(providerGroupFor('vllm')).toBe('enflite');
    expect(providerGroupFor('openai-compatible')).toBe('enflite');
    expect(providerGroupFor('something-unknown')).toBe('enflite');
  });

  it('maps cloud kinds to their own groups', () => {
    expect(providerGroupFor('claude')).toBe('claude');
    expect(providerGroupFor('openai')).toBe('openai');
  });

  it('carries a data-residency note on every group', () => {
    expect(PROVIDER_GROUP_INFO.enflite.dataResidency).toBe('local');
    expect(PROVIDER_GROUP_INFO.claude.dataResidency).toBe('cloud');
    expect(PROVIDER_GROUP_INFO.openai.dataResidency).toBe('cloud');
    for (const group of PROVIDER_GROUPS) {
      expect(PROVIDER_GROUP_INFO[group].residencyNote.length).toBeGreaterThan(0);
    }
  });

  it('validates group keys', () => {
    expect(isProviderGroup('enflite')).toBe(true);
    expect(isProviderGroup('ollama')).toBe(false);
    expect(isProviderGroup('')).toBe(false);
  });
});

describe('friendly model display names', () => {
  it('uses the curated names for known models', () => {
    expect(displayNameForModel({ name: 'x', modelIdentifier: 'llama3.1:8b' })).toBe('Enflite 8B');
    expect(displayNameForModel({ name: 'x', modelIdentifier: 'qwen2.5vl:7b' })).toBe('Enflite Vision');
    expect(displayNameForModel({ name: 'x', modelIdentifier: 'claude-sonnet-4-20250514' })).toBe('Claude Sonnet 4');
    expect(displayNameForModel({ name: 'x', modelIdentifier: 'gpt-4o' })).toBe('GPT-4o');
    expect(displayNameForModel({ name: 'x', modelIdentifier: 'gpt-4o-mini' })).toBe('GPT-4o Mini');
  });

  it('prettifies unknown technical IDs instead of showing them raw', () => {
    expect(displayNameForModel({ name: 'meta-llama/Meta-Llama-3.1-8B-Instruct', modelIdentifier: '' })).toBe(
      'Meta Llama 3.1 8B Instruct',
    );
  });

  it('prettifyModelName strips org prefixes and separators', () => {
    expect(prettifyModelName('meta-llama/Meta-Llama-3.1-8B-Instruct')).toBe('Meta Llama 3.1 8B Instruct');
    expect(prettifyModelName('qwen2.5vl_7b')).toBe('qwen2.5vl 7b');
  });
});
