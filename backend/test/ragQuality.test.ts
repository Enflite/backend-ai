import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery, withTenant } = vi.hoisted(() => ({ tenantQuery: vi.fn(), withTenant: vi.fn() }));
const embedMock = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool.js', () => ({ tenantQuery, withTenant }));
// Mock only the embedding provider; chunkText/chunkSections/ingestDocument
// stay real so chunking quality is exercised, not the mock.
vi.mock('../src/documents/ingestion.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/documents/ingestion.js')>();
  return {
    ...original,
    internalEmbeddingProvider: () => ({
      model: 'embedding-test', version: '1', dimensions: 2,
      embed: embedMock,
    }),
  };
});

import { config } from '../src/config.js';
import {
  applyDiversity,
  normalizeQuery,
  retrieveAuthorizedContext,
  setReranker,
  type AuthorizedChunk,
} from '../src/rag/retrieval.js';
import { chunkSections, chunkText, ingestDocument } from '../src/documents/ingestion.js';
import type { AuthContext } from '../src/authz/permissions.js';

const auth: AuthContext = {
  userId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333', roleId: '44444444-4444-4444-8444-444444444444',
  email: 'user@example.test', displayName: 'User', roleName: 'User', clearance: 'INTERNAL', permissions: ['document:read'],
};

const DEFAULT_RERANKER = { name: 'hybrid-score', rerank: (_q: string, chunks: AuthorizedChunk[]) => chunks };

function chunkRow(overrides: Record<string, unknown> = {}) {
  return {
    chunk_id: 'c1', content: 'alpha beta gamma delta', page: null, section: null,
    source_location: null, document_id: 'd1', filename: 'doc.md', vector_score: '0.9',
    ...overrides,
  };
}

const seenSql: string[] = [];
const seenParams: unknown[][] = [];
const fakeClient = {
  query: vi.fn(async (sql: string, params?: unknown[]) => {
    if (typeof sql === 'string' && sql.startsWith('SET LOCAL')) return { rows: [] };
    seenSql.push(sql);
    seenParams.push(params ?? []);
    return { rows: fakeClient.rows };
  }),
  rows: [] as Record<string, unknown>[],
};

const ORIGINAL_CONFIG = {
  RAG_DIVERSITY_LAMBDA: config.RAG_DIVERSITY_LAMBDA,
  RAG_SIMILARITY_THRESHOLD: config.RAG_SIMILARITY_THRESHOLD,
  RAG_CHUNK_MAX_CHARS: config.RAG_CHUNK_MAX_CHARS,
  RAG_CHUNK_OVERLAP: config.RAG_CHUNK_OVERLAP,
  MAX_DOCUMENT_CHUNKS: config.MAX_DOCUMENT_CHUNKS,
};

beforeEach(() => {
  tenantQuery.mockReset();
  withTenant.mockReset();
  embedMock.mockReset();
  embedMock.mockResolvedValue([[0.1, 0.2]]);
  seenSql.length = 0;
  seenParams.length = 0;
  fakeClient.rows = [];
  fakeClient.query.mockClear();
  withTenant.mockImplementation(async (_tenantId: string, callback: (client: unknown) => Promise<unknown>) =>
    callback(fakeClient));
  setReranker(DEFAULT_RERANKER);
});

afterEach(() => {
  Object.assign(config, ORIGINAL_CONFIG);
  setReranker(DEFAULT_RERANKER);
});

describe('query normalization', () => {
  it('trims and collapses whitespace before embedding', () => {
    expect(normalizeQuery('  hello   world\n\tfoo  ')).toBe('hello world foo');
  });

  it('caps query length at RAG_QUERY_MAX_CHARS', () => {
    expect(normalizeQuery('x'.repeat(5000))).toHaveLength(config.RAG_QUERY_MAX_CHARS);
  });

  it('embeds the normalized query, not the raw text', async () => {
    fakeClient.rows = [chunkRow()];
    await retrieveAuthorizedContext(auth, '  hello   world  ');
    expect(embedMock).toHaveBeenCalledTimes(1);
    expect(embedMock.mock.calls[0]![0]).toEqual(['hello world']);
  });

  it('returns the empty retrieval shape for a blank query without embedding', async () => {
    const result = await retrieveAuthorizedContext(auth, '   \n\t ');
    expect(result).toEqual({ context: '', citations: [], results: [] });
    expect(embedMock).not.toHaveBeenCalled();
  });
});

describe('MMR-lite diversity selection', () => {
  const candidate = (chunkId: string, documentId: string, score: number): AuthorizedChunk => ({
    chunkId, documentId, documentName: `${documentId}.md`, text: 'text', score,
    citation: { documentId, documentName: `${documentId}.md`, chunkId },
  });

  it('with lambda = 0 preserves strict top-K order', () => {
    const candidates = [
      candidate('a1', 'dA', 0.9), candidate('a2', 'dA', 0.89), candidate('b1', 'dB', 0.7),
    ];
    expect(applyDiversity(candidates, 2, 0).map((c) => c.chunkId)).toEqual(['a1', 'a2']);
  });

  it('blends in the best chunk from a second document when one document dominates', () => {
    const candidates = [
      candidate('a1', 'dA', 0.9), candidate('a2', 'dA', 0.89), candidate('b1', 'dB', 0.7),
    ];
    // a1 picked first; then a2 is discounted to 0.89 * (1 - 0.5) = 0.445 < 0.7,
    // so b1 from the second document takes the second slot.
    expect(applyDiversity(candidates, 2, 0.5).map((c) => c.chunkId)).toEqual(['a1', 'b1']);
  });

  it('keeps a same-document chunk when it stays competitive after discounting', () => {
    const candidates = [
      candidate('a1', 'dA', 0.9), candidate('a2', 'dA', 0.85), candidate('b1', 'dB', 0.3),
    ];
    // 0.85 * (1 - 0.5) = 0.425 still beats 0.3.
    expect(applyDiversity(candidates, 2, 0.5).map((c) => c.chunkId)).toEqual(['a1', 'a2']);
  });

  it('breaks ties deterministically by chunkId', () => {
    const candidates = [candidate('c2', 'dX', 0.5), candidate('c1', 'dY', 0.5)];
    expect(applyDiversity(candidates, 1, 0.5).map((c) => c.chunkId)).toEqual(['c1']);
  });

  it('blends a second document through the full retrieval path', async () => {
    // Query 'query' shares no terms with the contents, so the hybrid score is
    // exactly 0.85 * vector_score: a1 = 0.8075, a2 = 0.799, b1 = 0.68.
    config.RAG_DIVERSITY_LAMBDA = 0.5;
    fakeClient.rows = [
      chunkRow({ chunk_id: 'a1', document_id: 'dA', vector_score: '0.95' }),
      chunkRow({ chunk_id: 'a2', document_id: 'dA', vector_score: '0.94' }),
      chunkRow({ chunk_id: 'b1', document_id: 'dB', vector_score: '0.80' }),
    ];
    const result = await retrieveAuthorizedContext(auth, 'query', undefined, 2);
    expect(result.results.map((r) => r.chunkId)).toEqual(['a1', 'b1']);
  });

  it('with diversity disabled the full path keeps strict top-K order', async () => {
    config.RAG_DIVERSITY_LAMBDA = 0;
    fakeClient.rows = [
      chunkRow({ chunk_id: 'a1', document_id: 'dA', vector_score: '0.95' }),
      chunkRow({ chunk_id: 'a2', document_id: 'dA', vector_score: '0.94' }),
      chunkRow({ chunk_id: 'b1', document_id: 'dB', vector_score: '0.80' }),
    ];
    const result = await retrieveAuthorizedContext(auth, 'query', undefined, 2);
    expect(result.results.map((r) => r.chunkId)).toEqual(['a1', 'a2']);
  });
});

describe('citation grounding', () => {
  it('every citation in the context string references a returned chunkId', async () => {
    fakeClient.rows = [
      chunkRow({ chunk_id: 'c1', document_id: 'd1', filename: 'a.md', page: 3, section: 'Intro' }),
      chunkRow({ chunk_id: 'c2', document_id: 'd2', filename: 'b.md' }),
    ];
    const result = await retrieveAuthorizedContext(auth, 'query');
    const returnedIds = new Set(result.results.map((r) => r.chunkId));
    const citedInContext = [...result.context.matchAll(/chunk_id="([^"]+)"/g)].map((m) => m[1]!);
    expect(citedInContext).not.toHaveLength(0);
    expect(new Set(citedInContext)).toEqual(returnedIds);
    for (const citation of result.citations) {
      expect(returnedIds.has(citation.chunkId)).toBe(true);
    }
  });

  it('citations carry the DB row provenance (page/section) and are never synthesized', async () => {
    fakeClient.rows = [chunkRow({ chunk_id: 'c9', page: 12, section: 'Appendix', source_location: 'page:12' })];
    const result = await retrieveAuthorizedContext(auth, 'query');
    expect(result.citations[0]).toMatchObject({
      documentId: 'd1', documentName: 'doc.md', chunkId: 'c9', page: 12, section: 'Appendix',
    });
  });
});

describe('UNKNOWN classification fail-closed', () => {
  it('excludes UNKNOWN chunks in SQL, not just the JS allow-list', async () => {
    fakeClient.rows = [];
    await retrieveAuthorizedContext(auth, 'query');
    const sql = seenSql.find((s) => s.includes('FROM document_chunks'))!;
    expect(sql).toContain("dc.classification <> 'UNKNOWN'");
    expect(sql).toContain("d.classification <> 'UNKNOWN'");
    // Belt and suspenders: the classification allow-list parameter must not
    // contain UNKNOWN either.
    const params = seenParams[seenSql.indexOf(sql)]!;
    expect(params[1]).not.toContain('UNKNOWN');
  });
});

describe('threshold applies after the reranker', () => {
  it('a reranker-downgraded chunk is filtered by the threshold', async () => {
    // Hybrid scores: a = 0.765, b = 0.68 — both above the 0.5 threshold.
    config.RAG_SIMILARITY_THRESHOLD = 0.5;
    fakeClient.rows = [
      chunkRow({ chunk_id: 'a', vector_score: '0.9' }),
      chunkRow({ chunk_id: 'b', vector_score: '0.8' }),
    ];
    setReranker({
      name: 'downgrader',
      rerank: (_q, chunks) => chunks.map((c) => (c.chunkId === 'a' ? { ...c, score: 0.1 } : c)),
    });
    const result = await retrieveAuthorizedContext(auth, 'query');
    // The threshold must see the post-rerank score: 'a' drops out even though
    // its hybrid score qualified.
    expect(result.results.map((r) => r.chunkId)).toEqual(['b']);
    expect(result.citations.map((c) => c.chunkId)).toEqual(['b']);
  });

  it('a reranker-upgraded chunk still passes when above the threshold', async () => {
    config.RAG_SIMILARITY_THRESHOLD = 0.5;
    fakeClient.rows = [chunkRow({ chunk_id: 'a', vector_score: '0.9' })];
    setReranker({
      name: 'upgrader',
      rerank: (_q, chunks) => chunks.map((c) => ({ ...c, score: 0.99 })),
    });
    const result = await retrieveAuthorizedContext(auth, 'query');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.score).toBe(0.99);
  });
});

describe('chunking quality', () => {
  it('defaults keep overlap in the 10-15% band', () => {
    const ratio = config.RAG_CHUNK_OVERLAP / config.RAG_CHUNK_MAX_CHARS;
    expect(ratio).toBeGreaterThanOrEqual(0.1);
    expect(ratio).toBeLessThanOrEqual(0.15);
  });

  it('consecutive chunks share the configured overlap', () => {
    const chunks = chunkText('ab'.repeat(1000), 100, 20);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.startsWith(chunks[i - 1]!.slice(-20))).toBe(true);
    }
  });

  it('chunkSections preserves page/section/sourceLocation provenance', () => {
    const chunks = chunkSections([
      { text: 'word '.repeat(1000), page: 7, section: 'Security', sourceLocation: 'page:7' },
    ]);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.page).toBe(7);
      expect(chunk.section).toBe('Security');
      expect(chunk.sourceLocation).toBe('page:7');
      expect(chunk.text.length).toBeGreaterThan(0);
    }
  });

  it('warns when a document approaches the chunk cap', async () => {
    const originalCap = config.MAX_DOCUMENT_CHUNKS;
    config.MAX_DOCUMENT_CHUNKS = 4;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      tenantQuery.mockImplementation(async (...args: unknown[]) => {
        const sql = (args[1] ?? '') as string;
        if (sql.includes("UPDATE documents SET status = 'PROCESSING'")) {
          return { rows: [{ object_key: 'k', mime_type: 'text/plain', classification: 'INTERNAL' }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      });
      // 4000 chars / 1600-char chunks with 200 overlap -> 3 chunks, which is
      // >= 75% of the temporary cap of 4 but below it.
      const deps = {
        storage: { get: vi.fn().mockResolvedValue(new TextEncoder().encode('x')) },
        scanner: { scan: vi.fn().mockResolvedValue({ verdict: 'CLEAN', scanner: 'test' }) },
        extractor: vi.fn().mockResolvedValue([{ text: 'ab'.repeat(2000) }]),
        embeddings: {
          model: 'test-model', version: '1', dimensions: 2,
          embed: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
        },
      };
      const status = await ingestDocument('d1', 't1', deps as never);
      expect(status).toBe('READY');
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]![0]).toMatch(/produced 3 chunks.*cap 4/);
    } finally {
      warn.mockRestore();
      config.MAX_DOCUMENT_CHUNKS = originalCap;
    }
  });

  it('still fails closed above the chunk cap', async () => {
    config.MAX_DOCUMENT_CHUNKS = 2;
    tenantQuery.mockImplementation(async (...args: unknown[]) => {
      const sql = (args[1] ?? '') as string;
      if (sql.includes("UPDATE documents SET status = 'PROCESSING'")) {
        return { rows: [{ object_key: 'k', mime_type: 'text/plain', classification: 'INTERNAL' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const deps = {
      storage: { get: vi.fn().mockResolvedValue(new TextEncoder().encode('x')) },
      scanner: { scan: vi.fn().mockResolvedValue({ verdict: 'CLEAN', scanner: 'test' }) },
      extractor: vi.fn().mockResolvedValue([{ text: 'ab'.repeat(2000) }]),
      embeddings: {
        model: 'test-model', version: '1', dimensions: 2,
        embed: vi.fn().mockImplementation(async (texts: string[]) => texts.map(() => [0.1, 0.2])),
      },
    };
    await expect(ingestDocument('d1', 't1', deps as never)).rejects.toMatchObject({ code: 'TOO_MANY_CHUNKS' });
  });
});

describe('empty retrieval', () => {
  it('returns the empty shape (not an error) when no rows match', async () => {
    fakeClient.rows = [];
    const result = await retrieveAuthorizedContext(auth, 'query');
    expect(result).toEqual({ context: '', citations: [], results: [] });
  });
});
