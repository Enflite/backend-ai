/**
 * migration028.test.ts — Ollama-primary seed migration (028).
 *
 * Verifies migration 028's `up`:
 *   1. repoints the untouched legacy vLLM seed model at Ollama,
 *   2. never overwrites an operator-customized model row,
 *   3. is a no-op on a second run (idempotent).
 *
 * Uses an in-memory stand-in for the `models` collection; real MongoDB
 * behavior REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */
import { describe, expect, it, vi } from 'vitest';
import { migration028 } from '../src/db/migrations/028_ollama_primary_seed.js';

function fakeDb(docs: Array<Record<string, unknown>>) {
  const rows = docs.map((d) => ({ ...d }));
  const matchedCounts: number[] = [];
  const collection = {
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, any>) => {
      let matched = 0;
      for (const row of rows) {
        if (Object.entries(filter).every(([k, v]) => row[k] === v)) {
          Object.assign(row, update.$set);
          matched++;
        }
      }
      matchedCounts.push(matched);
      return { matchedCount: matched, modifiedCount: matched };
    }),
  };
  return {
    db: { collection: vi.fn(() => collection) } as any,
    rows,
    updateOne: collection.updateOne,
    matchedCounts,
  };
}

const LEGACY_SEED = {
  name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  provider: 'vllm',
  endpoint: 'http://vllm:8000/v1',
  modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  status: 'ACTIVE',
};

describe('migration 028 (ollama primary seed)', () => {
  it('repoints the untouched legacy vLLM seed model at Ollama', async () => {
    const { db, rows, updateOne } = fakeDb([LEGACY_SEED]);
    await migration028.up(db);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(rows[0]).toMatchObject({
      name: 'meta-llama/Meta-Llama-3.1-8B-Instruct', // registry name unchanged
      provider: 'ollama',
      endpoint: 'http://ollama:11434',
      modelIdentifier: 'llama3.1:8b',
      status: 'ACTIVE', // lifecycle untouched
    });
  });

  it('does not overwrite an operator-customized model row', async () => {
    const customized = {
      ...LEGACY_SEED,
      endpoint: 'http://gpu-cluster.internal:8000/v1', // operator repointed it
    };
    const { db, rows, updateOne, matchedCounts } = fakeDb([customized]);
    await migration028.up(db);
    expect(updateOne).toHaveBeenCalledTimes(1);
    expect(matchedCounts[0]).toBe(0);
    expect(rows[0]).toMatchObject({
      provider: 'vllm',
      endpoint: 'http://gpu-cluster.internal:8000/v1',
      modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
    });
  });

  it('is a no-op on a second run (idempotent)', async () => {
    const { db, updateOne, matchedCounts } = fakeDb([LEGACY_SEED]);
    await migration028.up(db);
    await migration028.up(db);
    expect(updateOne).toHaveBeenCalledTimes(2);
    expect(matchedCounts).toEqual([1, 0]);
  });
});
