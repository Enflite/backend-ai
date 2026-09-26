/**
 * sytelineSftSeed.test.ts — curator-authored SFT seed dataset (ADR-015 seed path).
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - parseSeedJsonl validates the seed JSONL: roles, non-empty content,
 *    user-first/assistant-last, no duplicate questions, MAX cap.
 *  - The shipped seed file (scripts/seed-data/syteline-expert-seed-v1.jsonl)
 *    parses cleanly with a healthy example count.
 *  - seedDataset is idempotent per (tenantId, name) and builds a
 *    FinetuneDatasetDoc with status 'ready' and seed provenance
 *    (sourceFeedbackId 'seed:<name>:<n>').
 *  - datasetToJsonl renders the seed doc in the training-upload format.
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));

import {
  buildSeedDatasetDoc,
  parseSeedJsonl,
  seedDataset,
  SEED_DATASET_NAME,
} from '../src/learning/seed.js';
import { datasetToJsonl, MAX_DATASET_EXAMPLES } from '../src/learning/dataset.js';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CTX = { tenantId: TENANT, userId: 'seed-script' };
const INPUT = { name: SEED_DATASET_NAME, classification: 'INTERNAL' as const, createdBy: 'seed-script' };

const GOOD_LINE = JSON.stringify({
  messages: [
    { role: 'user', content: 'What is an IDO?' },
    { role: 'assistant', content: 'An Intelligent Data Object.' },
  ],
});

const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    };
  }
  return mockCollections[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockCollections)) delete mockCollections[k];
  getDbMock.mockResolvedValue({ collection: (n: string) => getMockCollection(n) });
});

describe('parseSeedJsonl', () => {
  it('parses a valid file', () => {
    const sets = parseSeedJsonl(`${GOOD_LINE}\n\n${GOOD_LINE.replace('What is an IDO?', 'What is MRP?')}\n`);
    expect(sets).toHaveLength(2);
    expect(sets[0]![0]!.role).toBe('user');
    expect(sets[0]![1]!.role).toBe('assistant');
  });

  it('rejects invalid JSON with a line number', () => {
    expect(() => parseSeedJsonl(`${GOOD_LINE}\n{nope`)).toThrow(/line 2/i);
  });

  it('rejects wrong role order', () => {
    const bad = JSON.stringify({ messages: [{ role: 'assistant', content: 'x' }, { role: 'user', content: 'y' }] });
    expect(() => parseSeedJsonl(bad)).toThrow(/first message must be role 'user'/);
  });

  it('rejects empty content', () => {
    const bad = JSON.stringify({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: '  ' }] });
    expect(() => parseSeedJsonl(bad)).toThrow(/non-empty content/);
  });

  it('rejects duplicate user questions', () => {
    expect(() => parseSeedJsonl(`${GOOD_LINE}\n${GOOD_LINE}`)).toThrow(/duplicate user question/);
  });

  it('rejects an empty file', () => {
    expect(() => parseSeedJsonl('\n  \n')).toThrow(/no usable examples/);
  });

  it('rejects files over the example cap', () => {
    const lines = Array.from({ length: MAX_DATASET_EXAMPLES + 1 }, (_, i) =>
      JSON.stringify({ messages: [{ role: 'user', content: `q${i}` }, { role: 'assistant', content: 'a' }] })
    );
    expect(() => parseSeedJsonl(lines.join('\n'))).toThrow(/max is/);
  });
});

describe('shipped seed file', () => {
  const seedPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'seed-data', 'syteline-expert-seed-v1.jsonl');

  it('parses cleanly with a healthy example count', () => {
    const text = readFileSync(seedPath, 'utf8');
    const sets = parseSeedJsonl(text);
    expect(sets.length).toBeGreaterThanOrEqual(120);
    expect(sets.length).toBeLessThanOrEqual(MAX_DATASET_EXAMPLES);
  });
});

describe('seedDataset', () => {
  it('inserts a ready doc with seed provenance when new', async () => {
    const sets = parseSeedJsonl(GOOD_LINE);
    const { doc, skipped } = await seedDataset(CTX, INPUT, sets);
    expect(skipped).toBe(false);
    expect(doc.status).toBe('ready');
    expect(doc.tenantId).toBe(TENANT);
    expect(doc.name).toBe(SEED_DATASET_NAME);
    expect(doc.exampleCount).toBe(1);
    expect(doc.skippedCount).toBe(0);
    expect(doc.examples[0]!.sourceFeedbackId).toBe(`seed:${SEED_DATASET_NAME}:1`);
    expect(doc.examples[0]!.classification).toBe('INTERNAL');
    expect(getMockCollection('finetune_datasets').insertOne).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: returns the existing doc without inserting', async () => {
    const existing = buildSeedDatasetDoc(CTX, INPUT, parseSeedJsonl(GOOD_LINE));
    getMockCollection('finetune_datasets').findOne.mockResolvedValue(existing);
    const { doc, skipped } = await seedDataset(CTX, INPUT, parseSeedJsonl(GOOD_LINE));
    expect(skipped).toBe(true);
    expect(doc._id).toBe(existing._id);
    expect(getMockCollection('finetune_datasets').insertOne).not.toHaveBeenCalled();
  });
});

describe('datasetToJsonl with a seed doc', () => {
  it('renders one JSON object per line in training-upload format', () => {
    const doc = buildSeedDatasetDoc(CTX, INPUT, parseSeedJsonl(GOOD_LINE));
    const jsonl = datasetToJsonl(doc);
    const lines = jsonl.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.messages[0].role).toBe('user');
    expect(parsed.messages[1].role).toBe('assistant');
    expect(parsed).not.toHaveProperty('sourceFeedbackId');
  });
});
