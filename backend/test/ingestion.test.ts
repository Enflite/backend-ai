import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));

import { ingestDocument, internalEmbeddingProvider, chunkText } from '../src/documents/ingestion.js';
import type { EmbeddingProvider } from '../src/documents/ingestion.js';
import { config } from '../src/config.js';

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

describe('internal embedding provider retries', () => {
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = config.EMBEDDING_BASE_URL;
  const originalModel = config.EMBEDDING_MODEL;
  const originalDimensions = config.EMBEDDING_DIMENSIONS;

  beforeEach(() => {
    config.EMBEDDING_BASE_URL = 'http://embeddings.test';
    config.EMBEDDING_MODEL = 'test-model';
    config.EMBEDDING_DIMENSIONS = 2;
  });

  const embedResponse = (status: number) =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    config.EMBEDDING_BASE_URL = originalBaseUrl;
    config.EMBEDDING_MODEL = originalModel;
    config.EMBEDDING_DIMENSIONS = originalDimensions;
  });

  it('retries on 429 and 5xx, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(embedResponse(429))
      .mockResolvedValueOnce(embedResponse(503))
      .mockResolvedValueOnce(embedResponse(200));
    globalThis.fetch = fetchMock as never;
    const vectors = await internalEmbeddingProvider.embed(['hello']);
    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx: deterministic errors surface immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(embedResponse(400));
    globalThis.fetch = fetchMock as never;
    await expect(internalEmbeddingProvider.embed(['hello'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after exhausting retries on persistent 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(embedResponse(500));
    globalThis.fetch = fetchMock as never;
    await expect(internalEmbeddingProvider.embed(['hello'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry after cancellation: an aborted signal throws at once', async () => {
    const abortError = new DOMException('aborted', 'AbortError');
    const fetchMock = vi.fn().mockRejectedValueOnce(abortError);
    globalThis.fetch = fetchMock as never;
    const controller = new AbortController();
    controller.abort();
    await expect(internalEmbeddingProvider.embed(['hello'], controller.signal)).rejects.toThrow('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('chunkText argument validation', () => {
  it('rejects non-positive or fractional maxCharacters', () => {
    expect(() => chunkText('x'.repeat(200), 0, 0)).toThrow('maxCharacters');
    expect(() => chunkText('x'.repeat(200), 63, 0)).toThrow('maxCharacters');
    expect(() => chunkText('x'.repeat(200), 100.5, 10)).toThrow('maxCharacters');
  });

  it('rejects overlap outside [0, maxCharacters)', () => {
    expect(() => chunkText('x'.repeat(200), 100, -1)).toThrow('overlap');
    expect(() => chunkText('x'.repeat(200), 100, 100)).toThrow('overlap');
    expect(() => chunkText('x'.repeat(200), 100, 1.5)).toThrow('overlap');
  });

  it('still chunks normally with valid arguments', () => {
    const chunks = chunkText('word '.repeat(100), 100, 10);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.length <= 100)).toBe(true);
  });
});
  beforeEach(() => tenantQuery.mockReset());

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
