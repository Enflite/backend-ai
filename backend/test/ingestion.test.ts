import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));

import { ingestDocument, chunkText, IngestionCanceledError } from '../src/documents/ingestion.js';
import { OpenAICompatibleEmbeddingProvider } from '../src/ai/providers/openaiEmbeddings.js';
import type { EmbeddingProvider } from '../src/documents/ingestion.js';
import { config } from '../src/config.js';

const DIMENSIONS = 2;

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      insertMany: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      aggregate: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'insertMany', 'deleteMany']) {
      coll[m].mockReset();
    }
    coll.find.mockReset();
    coll.find.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    coll.aggregate.mockReset();
    coll.aggregate.mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) });
    coll.findOne.mockResolvedValue(null);
    coll.findOneAndUpdate.mockResolvedValue(null);
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.insertMany.mockResolvedValue({ acknowledged: true });
    coll.deleteMany.mockResolvedValue({ deletedCount: 0 });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  tenantOpMock.mockReset();
  tenantOpMock.mockImplementation(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
}

function fakeDependencies(overrides: Partial<{
  vectors: number[][];
  text: string;
}> = {}) {
  const text = overrides.text ?? 'hello world';
  const embeddings: EmbeddingProvider = {
    kind: 'test',
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
  // ingestDocument starts by atomically transitioning the document to
  // PROCESSING via findOneAndUpdate, returning the document (or null if not found).
  const documentsColl = getMockCollection('documents');
  documentsColl.findOneAndUpdate.mockResolvedValue({
    _id: 'd1',
    tenantId: 't1',
    objectKey: 'k',
    mimeType: 'text/plain',
    classification: 'INTERNAL',
  });
}

function findFailedUpdate(errorCode?: string) {
  const documentsColl = getMockCollection('documents');
  return documentsColl.updateOne.mock.calls.find(([filter, update]: any[]) => {
    const set = update?.$set ?? {};
    return set.status === 'FAILED' && (errorCode === undefined || set.errorCode === errorCode);
  });
}

function chunkInsertCalls() {
  const chunksColl = getMockCollection('document_chunks');
  return chunksColl.insertMany.mock.calls;
}

describe('ingestion embedding validation', () => {
  beforeEach(() => resetMocks());

  it('rejects non-finite embedding values instead of storing them', async () => {
    mockDocumentRow();
    const deps = fakeDependencies({ vectors: [[NaN, 0.2]] });
    await expect(ingestDocument('d1', 't1', deps as any)).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING_RESPONSE',
    });
    // The document is marked FAILED.
    expect(findFailedUpdate()).toBeTruthy();
    // No chunk documents were written.
    expect(chunkInsertCalls().length).toBe(0);
  });

  it('rejects wrong-dimension vectors', async () => {
    mockDocumentRow();
    const deps = fakeDependencies({ vectors: [[0.1, 0.2, 0.3]] });
    await expect(ingestDocument('d1', 't1', deps as any)).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING_RESPONSE',
    });
  });
});

describe('OpenAI-compatible embedding provider retries', () => {
  const originalFetch = globalThis.fetch;

  const embedResponse = (status: number) =>
    new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2], index: 0 }] }), { status });

  function makeProvider() {
    return new OpenAICompatibleEmbeddingProvider({
      endpoint: 'http://embeddings.test',
      model: 'test-model',
      version: '1',
      dimensions: 2,
      defaultTimeoutMs: 5000,
    });
  }

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('retries on 429 and 5xx, then succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(embedResponse(429))
      .mockResolvedValueOnce(embedResponse(503))
      .mockResolvedValueOnce(embedResponse(200));
    globalThis.fetch = fetchMock as never;
    const vectors = await makeProvider().embed(['hello']);
    expect(vectors).toEqual([[0.1, 0.2]]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry 4xx: deterministic errors surface immediately', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(embedResponse(400));
    globalThis.fetch = fetchMock as never;
    await expect(makeProvider().embed(['hello'])).rejects.toMatchObject({
      code: 'EMBEDDING_PROVIDER_ERROR',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails after exhausting retries on persistent 5xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue(embedResponse(500));
    globalThis.fetch = fetchMock as never;
    await expect(makeProvider().embed(['hello'])).rejects.toMatchObject({
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
    await expect(makeProvider().embed(['hello'], controller.signal)).rejects.toThrow('aborted');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects invalid dimensions', async () => {
    const bad = new Response(JSON.stringify({ data: [{ embedding: [0.1], index: 0 }] }), { status: 200 });
    globalThis.fetch = vi.fn().mockResolvedValue(bad) as never;
    await expect(makeProvider().embed(['hello'])).rejects.toMatchObject({
      code: 'INVALID_EMBEDDING_RESPONSE',
    });
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

describe('ingestion chunk insert batching', () => {
  beforeEach(() => resetMocks());

  it('writes chunks with batched insertMany instead of one write per chunk', async () => {
    mockDocumentRow();
    // ~250 chunks of max-size text (1600 chars each).
    const text = 'w'.repeat(1600);
    const sections = Array.from({ length: 250 }, () => ({ text }));
    const deps = {
      storage: { get: vi.fn().mockResolvedValue(new TextEncoder().encode('x')) } as any,
      scanner: { scan: vi.fn().mockResolvedValue({ verdict: 'CLEAN', scanner: 'test' }) } as any,
      extractor: vi.fn().mockResolvedValue(sections),
      embeddings: {
        kind: 'test',
        model: 'test-model',
        version: '1',
        dimensions: DIMENSIONS,
        embed: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      } as EmbeddingProvider,
    };
    const result = await ingestDocument('d1', 't1', deps as any);
    expect(result).toBe('READY');
    const inserts = chunkInsertCalls();
    // 250 chunks in batches of 200 -> 2 insertMany calls, not 250.
    expect(inserts.length).toBe(2);
    const firstDocs = inserts[0][0] as any[];
    const secondDocs = inserts[1][0] as any[];
    expect(firstDocs).toHaveLength(200);
    expect(secondDocs).toHaveLength(50);
    // Chunk indexes are continuous across batches.
    const allDocs = [...firstDocs, ...secondDocs];
    expect(allDocs.map((d) => d.chunkIndex)).toEqual(Array.from({ length: 250 }, (_, i) => i));
    // Each chunk doc carries the MongoDB provenance fields.
    expect(firstDocs[0]).toMatchObject({
      documentId: 'd1',
      tenantId: 't1',
      embeddingModel: 'test-model',
      embeddingVersion: '1',
      embeddingDimensions: DIMENSIONS,
    });
    expect(firstDocs[0].embedding).toEqual([0.1, 0.2]);
  });
});

describe('ingestion cancellation hooks', () => {
  beforeEach(() => resetMocks());

  it('aborts between pipeline stages when shouldCancel fires', async () => {
    mockDocumentRow();
    const deps = fakeDependencies();
    let calls = 0;
    // Cancel lands after the scan stage: extraction (a later stage) never runs.
    const shouldCancel = () => ++calls > 1;
    await expect(
      ingestDocument('d1', 't1', deps as any, { shouldCancel })
    ).rejects.toBeInstanceOf(IngestionCanceledError);
    expect(deps.scanner.scan).toHaveBeenCalled();
    expect(deps.extractor).not.toHaveBeenCalled();
    // The document is left FAILED/INGESTION_CANCELED, never stranded in PROCESSING.
    expect(findFailedUpdate('INGESTION_CANCELED')).toBeTruthy();
    // No chunks were written: the store stage was never reached.
    expect(chunkInsertCalls().length).toBe(0);
  });

  it('runs to completion when shouldCancel never fires', async () => {
    mockDocumentRow();
    const deps = fakeDependencies();
    await expect(
      ingestDocument('d1', 't1', deps as any, { shouldCancel: () => false })
    ).resolves.toBe('READY');
  });

  it('is backward compatible when no hooks are passed', async () => {
    mockDocumentRow();
    const deps = fakeDependencies();
    await expect(ingestDocument('d1', 't1', deps as any)).resolves.toBe('READY');
  });
});
