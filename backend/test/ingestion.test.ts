import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));

import { ingestDocument } from '../src/documents/ingestion.js';
import type { EmbeddingProvider } from '../src/documents/ingestion.js';

const DIMENSIONS = 2;

function fakeDependencies(overrides: Partial<{
  vectors: number[][];
  text: string;
}> = {}) {
  const text = overrides.text ?? 'hello world';
  const embeddings: EmbeddingProvider = {
    model: 'test-model',
    version: '1',
    dimensions: DIMENSIONS,
    embed: vi.fn().mockImplementation(async (texts: string[]) =>
      overrides.vectors ?? texts.map(() => [0.1, 0.2])
    ),
  };
  return {
    storage: { get: vi.fn().mockResolvedValue(new TextEncoder().encode(text)) } as any,
    scanner: { scan: vi.fn().mockResolvedValue({ verdict: 'CLEAN', scanner: 'test' }) } as any,
    extractor: vi.fn().mockResolvedValue([{ text }]),
    embeddings,
  };
}

function mockDocumentRow() {
  tenantQuery.mockImplementation(async (...args: any[]) => {
    // Vitest teardown may invoke the implementation with no arguments; ignore.
    const sql = (args[1] ?? '') as string;
    if (sql.includes('UPDATE documents SET status = \'PROCESSING\'')) {
      return { rows: [{ object_key: 'k', mime_type: 'text/plain', classification: 'INTERNAL' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
}

describe('ingestion embedding validation', () => {
  beforeEach(() => tenantQuery.mockReset());

  it('rejects non-finite embedding values instead of storing them', async () => {
    mockDocumentRow();
    const deps = fakeDependencies({ vectors: [[NaN, 0.2]] });
    await expect(ingestDocument('d1', 't1', deps as any)).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING_RESPONSE',
    });
    const failedUpdate = tenantQuery.mock.calls.find(([, sql]: any[]) =>
      (sql as string).includes('UPDATE documents SET status = \'FAILED\'')
    );
    expect(failedUpdate).toBeTruthy();
    // No chunk rows were written.
    expect(
      tenantQuery.mock.calls.some(([, sql]: any[]) => (sql as string).includes('INSERT INTO document_chunks'))
    ).toBe(false);
  });

  it('rejects wrong-dimension vectors', async () => {
    mockDocumentRow();
    const deps = fakeDependencies({ vectors: [[0.1, 0.2, 0.3]] });
    await expect(ingestDocument('d1', 't1', deps as any)).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING_RESPONSE',
    });
  });
});

describe('ingestion chunk insert batching', () => {
  beforeEach(() => tenantQuery.mockReset());

  it('writes chunks with multi-row inserts instead of one transaction per chunk', async () => {
    mockDocumentRow();
    // ~250 chunks of max-size text (1600 chars each).
    const text = 'w'.repeat(1600);
    const sections = Array.from({ length: 250 }, () => ({ text }));
    const deps = {
      storage: { get: vi.fn().mockResolvedValue(new TextEncoder().encode('x')) } as any,
      scanner: { scan: vi.fn().mockResolvedValue({ verdict: 'CLEAN', scanner: 'test' }) } as any,
      extractor: vi.fn().mockResolvedValue(sections),
      embeddings: {
        model: 'test-model',
        version: '1',
        dimensions: DIMENSIONS,
        embed: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      } as EmbeddingProvider,
    };
    const result = await ingestDocument('d1', 't1', deps as any);
    expect(result).toBe('READY');
    const inserts = tenantQuery.mock.calls.filter(([, sql]: any[]) =>
      (sql as string).includes('INSERT INTO document_chunks')
    );
    // 250 chunks in batches of 200 -> 2 statements, not 250.
    expect(inserts.length).toBe(2);
    const [, firstSql, firstParams] = inserts[0]!;
    expect((firstSql as string).match(/\(\$/g)).toHaveLength(200);
    expect((firstParams as unknown[]).length).toBe(200 * 12);
    const [, secondSql] = inserts[1]!;
    expect((secondSql as string).match(/\(\$/g)).toHaveLength(50);
    // Chunk indexes are continuous across batches.
    const allParams = inserts.flatMap(([, , params]: any[]) => params as unknown[]);
    const indexes = allParams.filter((_: unknown, i: number) => i % 12 === 2);
    expect(indexes).toEqual(Array.from({ length: 250 }, (_, i) => i));
  });
});
