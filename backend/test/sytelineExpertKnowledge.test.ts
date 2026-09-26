import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSystemPrompt } from '../src/chat/systemPrompt.js';
import {
  SYTELINE_EXPERT_KNOWLEDGE,
  SYTELINE_EXPERT_KNOWLEDGE_VERSION,
} from '../src/chat/sytelineExpertKnowledge.js';

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, '..', '..', 'docs', 'syteline-expert.md');

/**
 * Anchor phrases that must appear in BOTH the runtime knowledge pack and
 * the human-readable doc. They pin the substance (platform, data model,
 * status lifecycle, expert concepts, honesty rules) without brittle
 * exact-text matching across two different formats.
 */
const SYNC_ANCHORS = [
  'Mongoose',
  'SLCustomers',
  'matltran',
  'Neg Flag',
  'Past Due',
  'backflush',
  'On Order Balance',
  'FormSync',
  'Stopped',
  'IdoCollections',
  'Uf_ENF_',
];

describe('syteline expert knowledge pack', () => {
  it('is versioned', () => {
    expect(SYTELINE_EXPERT_KNOWLEDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('covers the core expertise areas', () => {
    expect(SYTELINE_EXPERT_KNOWLEDGE.length).toBeGreaterThan(2000);
    for (const anchor of SYNC_ANCHORS) {
      expect(SYTELINE_EXPERT_KNOWLEDGE, `pack missing: ${anchor}`).toContain(anchor);
    }
  });

  it('contains no tenant data, secrets, or endpoint details', () => {
    // The pack is generic product knowledge; it must never carry anything
    // tenant-specific or credential-shaped into model context.
    expect(SYTELINE_EXPERT_KNOWLEDGE).not.toMatch(/sk-live-[A-Za-z0-9]+/);
    expect(SYTELINE_EXPERT_KNOWLEDGE).not.toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(SYTELINE_EXPERT_KNOWLEDGE).not.toMatch(/https?:\/\//);
    expect(SYTELINE_EXPERT_KNOWLEDGE).not.toMatch(/Bearer /);
  });

  it('stays in sync with docs/syteline-expert.md', () => {
    const doc = readFileSync(docPath, 'utf8');
    for (const anchor of SYNC_ANCHORS) {
      expect(doc, `doc missing anchor: ${anchor}`).toContain(anchor);
    }
  });

  it('is injected into the system prompt on SyteLine turns only', () => {
    const withTools = buildSystemPrompt({ sytelineToolsAvailable: true });
    expect(withTools).toContain('SYTELINE DOMAIN EXPERTISE');
    expect(withTools).toContain('On Hand Neg Flag');
    expect(withTools).toContain('matltran');

    const without = buildSystemPrompt({});
    expect(without).not.toContain('SYTELINE DOMAIN EXPERTISE');

    const explicitFalse = buildSystemPrompt({ sytelineToolsAvailable: false });
    expect(explicitFalse).not.toContain('SYTELINE DOMAIN EXPERTISE');

    // SyteLine guidance requires both flags: the pack references tool
    // workflows, so it must not appear when no tools are offered.
    const toolsOff = buildSystemPrompt({ toolsAvailable: false, sytelineToolsAvailable: true });
    expect(toolsOff).not.toContain('SYTELINE DOMAIN EXPERTISE');
  });

  it('never leaks the pack when no tools are available', () => {
    const prompt = buildSystemPrompt({ toolsAvailable: false });
    expect(prompt).not.toContain('SYTELINE DOMAIN EXPERTISE');
    expect(prompt).not.toContain('matltran');
  });
});
