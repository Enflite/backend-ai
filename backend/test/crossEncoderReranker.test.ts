import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the DB and embedding provider so the end-to-end test below runs
// retrieveAuthorizedContext without MongoDB.
const { getDbMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  return { getDbMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));

const { embed } = vi.hoisted(() => ({ embed: vi.fn() }));
vi.mock('../src/documents/ingestion.js', () => ({
  internalEmbeddingProvider: () => ({ model: 'emb', version: '1', dimensions: 3, embed }),
}));

import { createCrossEncoderReranker, resolveRerankerConfig } from '../src/rag/crossEncoderReranker.js';
import type { AuthorizedChunk, Reranker } from '../src/rag/retrieval.js';
import { retrieveAuthorizedContext, setReranker } from '../src/rag/retrieval.js';
import { config } from '../src/config.js';
import { rerankerFallbacksTotal, resetMetrics } from '../src/observability/metrics.js';
import type { Permission } from '../src/authz/permissions.js';

const ALLOWED_URL = 'http://localhost:8000/rerank'; // on AI_PROVIDER_ALLOWED_ORIGINS

function makeChunk(chunkId: string, score: number, text = `text-${chunkId}`): AuthorizedChunk {
  return {
    documentId: `doc-${chunkId}`,
    documentName: 'doc.txt',
    chunkId,
    text,
    score,
    citation: { documentId: `doc-${chunkId}`, documentName: 'doc.txt', chunkId },
  };
}

function okResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  } as Response;
}

function failingResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}) } as Response;
}

/** A fetch impl whose calls are captured for assertion. */
function capturingFetch(response: Response | (() => Promise<Response>)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = async (url: string, init: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    return typeof response === 'function' ? response() : response;
  };
  return { calls, fetchImpl };
}

/** A fetch impl that only resolves when the abort signal fires (for timeout tests). */
function abortOnSignalFetch(): (url: string, init: RequestInit) => Promise<Response> {
  return async (_url: string, init: RequestInit) => {
    await new Promise<void>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      });
      if (init.signal?.aborted) {
        const error = new Error('The operation was aborted.');
        error.name = 'AbortError';
        reject(error);
      }
    });
    throw new Error('unreachable');
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMetrics();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  setReranker({ name: 'hybrid-score', rerank: (_q, chunks) => chunks });
});

function fallbackSeriesCount(reason: string): number {
  const rendered = rerankerFallbacksTotal.render();
  const match = rendered.match(new RegExp(`reranker_fallbacks_total\\{reason="${reason}"\\} (\\d+)`));
  return match ? Number(match[1]) : 0;
}

describe('cross-encoder reranker: interface conformance', () => {
  it('satisfies the Reranker hook interface', () => {
    const reranker: Reranker = createCrossEncoderReranker({ url: ALLOWED_URL });
    expect(reranker.name).toBe('cross-encoder');
    expect(typeof reranker.rerank).toBe('function');
  });

  it('returns the input unchanged for an empty candidate list without calling the endpoint', async () => {
    const { calls, fetchImpl } = capturingFetch(okResponse({ results: [] }));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    expect(await reranker.rerank('query', [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('cross-encoder reranker: score-based reordering', () => {
  it('reorders candidates by the endpoint relevance scores', async () => {
    const { fetchImpl } = capturingFetch(
      okResponse({
        results: [
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.4 },
          { index: 1, relevance_score: 0.7 },
        ],
      })
    );
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    const chunks = [makeChunk('a', 0.9), makeChunk('b', 0.5), makeChunk('c', 0.1)];
    const out = await reranker.rerank('what is this', chunks);
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['c', 'b', 'a']);
  });

  it('proposes validated [0,1] scores and keeps text and citation intact', async () => {
    const { fetchImpl } = capturingFetch(
      okResponse({
        results: [
          { index: 0, relevance_score: 12.5 },
          { index: 1, relevance_score: -3 },
        ],
      })
    );
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    const chunks = [makeChunk('a', 0.9, 'alpha text'), makeChunk('b', 0.5, 'beta text')];
    const out = await reranker.rerank('q', chunks);
    expect(out[0]!.chunkId).toBe('a');
    expect(out[0]!.score).toBe(1); // clamped from 12.5
    expect(out[0]!.text).toBe('alpha text');
    expect(out[1]!.chunkId).toBe('b');
    expect(out[1]!.score).toBe(0); // clamped from -3
    expect(out[1]!.citation.chunkId).toBe('b');
  });

  it('accepts the TEI-style `score` field as well', async () => {
    const { fetchImpl } = capturingFetch(okResponse({ results: [{ index: 1, score: 0.8 }, { index: 0, score: 0.2 }] }));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    const out = await reranker.rerank('q', [makeChunk('a', 0.9), makeChunk('b', 0.1)]);
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['b', 'a']);
  });

  it('appends unscored documents in their original order and keeps chunks beyond topN', async () => {
    const { fetchImpl } = capturingFetch(okResponse({ results: [{ index: 0, relevance_score: 0.9 }] }));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, topN: 2, fetchImpl });
    const chunks = [makeChunk('a', 0.9), makeChunk('b', 0.8), makeChunk('c', 0.7), makeChunk('d', 0.6)];
    const out = await reranker.rerank('q', chunks);
    // 'a' scored first; 'b' unscored but within topN keeps its spot after 'a';
    // 'c' and 'd' were never sent for scoring and stay in original order.
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['a', 'b', 'c', 'd']);
    expect(out[0]!.score).toBe(0.9);
    expect(out[2]!.score).toBe(0.7); // hybrid score preserved
  });

  it('sends only query, model, and chunk texts — no credentials, ids, or auth headers', async () => {
    const { calls, fetchImpl } = capturingFetch(okResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, model: 'test-model', fetchImpl });
    await reranker.rerank('secret question', [makeChunk('a', 0.9, 'chunk text')]);
    expect(calls).toHaveLength(1);
    const { init } = calls[0]!;
    const headers = new Headers(init.headers);
    expect(headers.has('authorization')).toBe(false);
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['documents', 'model', 'query']);
    expect(body.query).toBe('secret question');
    expect(body.documents).toEqual(['chunk text']);
    expect(body.model).toBe('test-model');
  });

  it('caps the documents sent per call at topN', async () => {
    const { calls, fetchImpl } = capturingFetch(okResponse({ results: [{ index: 0, relevance_score: 0.5 }] }));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, topN: 3, fetchImpl });
    const chunks = [0, 1, 2, 3, 4].map((i) => makeChunk(`c${i}`, 0.9 - i * 0.1));
    await reranker.rerank('q', chunks);
    const body = JSON.parse(String(calls[0]!.init.body)) as { documents: string[] };
    expect(body.documents).toHaveLength(3);
  });
});

describe('cross-encoder reranker: fail-open fallbacks', () => {
  it('falls back on HTTP errors and preserves hybrid order', async () => {
    const { fetchImpl } = capturingFetch(failingResponse(500));
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    const chunks = [makeChunk('a', 0.9), makeChunk('b', 0.5)];
    const out = await reranker.rerank('q', chunks);
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['a', 'b']);
    expect(fallbackSeriesCount('http_error')).toBe(1);
  });

  it('falls back on timeout', async () => {
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, timeoutMs: 30, fetchImpl: abortOnSignalFetch() });
    const chunks = [makeChunk('a', 0.9), makeChunk('b', 0.5)];
    const out = await reranker.rerank('q', chunks);
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['a', 'b']);
    expect(fallbackSeriesCount('timeout')).toBe(1);
  });

  it('falls back on invalid JSON', async () => {
    const { fetchImpl } = capturingFetch({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error('not json');
      },
    } as unknown as Response);
    const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
    const chunks = [makeChunk('a', 0.9)];
    expect(await reranker.rerank('q', chunks)).toEqual(chunks);
    expect(fallbackSeriesCount('invalid_response')).toBe(1);
  });

  it('falls back on malformed response shapes and unusable result entries', async () => {
    for (const body of [
      { wrong: 'shape' },
      { results: 'not-an-array' },
      { results: [{ index: 99, relevance_score: 0.9 }] }, // index out of range
      { results: [{ index: 'x', relevance_score: NaN }] },
    ]) {
      const { fetchImpl } = capturingFetch(okResponse(body));
      const reranker = createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl });
      const chunks = [makeChunk('a', 0.9)];
      const out = await reranker.rerank('q', chunks);
      expect(out.map((chunk) => chunk.chunkId)).toEqual(['a']);
    }
    expect(fallbackSeriesCount('invalid_response')).toBe(4);
  });

  it('never calls an endpoint whose origin is outside the egress allowlist', async () => {
    const { calls, fetchImpl } = capturingFetch(okResponse({ results: [{ index: 0, relevance_score: 0.9 }] }));
    const reranker = createCrossEncoderReranker({ url: 'http://evil.example.com/rerank', fetchImpl });
    const chunks = [makeChunk('a', 0.9), makeChunk('b', 0.5)];
    const out = await reranker.rerank('q', chunks);
    expect(out.map((chunk) => chunk.chunkId)).toEqual(['a', 'b']);
    expect(calls).toHaveLength(0);
    expect(fallbackSeriesCount('not_allowed')).toBe(1);
  });

  it('falls back without calling anything when no URL is configured', async () => {
    const { calls, fetchImpl } = capturingFetch(okResponse({ results: [{ index: 0, relevance_score: 0.9 }] }));
    const reranker = createCrossEncoderReranker({ url: '', fetchImpl });
    const chunks = [makeChunk('a', 0.9)];
    expect(await reranker.rerank('q', chunks)).toEqual(chunks);
    expect(calls).toHaveLength(0);
    expect(fallbackSeriesCount('not_configured')).toBe(1);
  });
});

describe('cross-encoder reranker: config', () => {
  it('is disabled by default so the passthrough preserves hybrid order', () => {
    expect(config.RERANKER_ENABLED).toBe(false);
  });

  it('parses defaults for timeout, topN, url, and model', () => {
    expect(config.RERANKER_TIMEOUT_MS).toBe(5000);
    expect(config.RERANKER_TOP_N).toBe(10);
    expect(config.RERANKER_URL).toBe('');
    expect(config.RERANKER_MODEL).toBe('cross-encoder/ms-marco-MiniLM-L-6-v2');
  });

  it('resolveRerankerConfig mirrors the parsed env config', () => {
    const resolved = resolveRerankerConfig();
    expect(resolved).toEqual({
      url: config.RERANKER_URL,
      model: config.RERANKER_MODEL,
      timeoutMs: config.RERANKER_TIMEOUT_MS,
      topN: config.RERANKER_TOP_N,
    });
  });
});

// ---------------------------------------------------------------------------
// End-to-end: the cross-encoder reranker behind the retrieval.ts hook cannot
// widen access. The DB rows are the already-authorized set; the endpoint is
// hostile (out-of-range index, dropped chunk). The reconstruction must emit
// exactly the authorized set, reordered, with canonical text.
// ---------------------------------------------------------------------------

const auth = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
  roleId: 'role-1',
  email: 'u@test',
  displayName: 'U',
  roleName: 'User',
  clearance: 'INTERNAL' as const,
  permissions: ['chat:create'] as Permission[],
};

function chunkDoc(chunkId: string, vectorScore: number) {
  return {
    _id: chunkId,
    content: `canonical content of ${chunkId}`,
    documentId: `doc-${chunkId}`,
    classification: 'INTERNAL',
    page: null,
    section: null,
    sourceLocation: null,
    vectorScore,
  };
}

// Mock collections for the end-to-end retrieval tests
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      })),
      aggregate: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
      })),
    };
  }
  return mockCollections[name];
}

let e2eChunkDocs: any[] = [];
let e2eDocumentDocs: any[] = [];

function setupE2ERetrieval(chunks: any[]) {
  e2eChunkDocs = chunks;
  const docIds = [...new Set(chunks.map((c) => c.documentId))];
  e2eDocumentDocs = docIds.map((docId) => ({
    _id: docId,
    filename: `${docId}.txt`,
    classification: 'INTERNAL',
  }));
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  for (const name of ['document_permissions', 'department_memberships', 'security_group_memberships']) {
    getMockCollection(name).find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getMockCollection('documents').find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue(e2eDocumentDocs),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    project: vi.fn().mockReturnThis(),
  }));
  getMockCollection('document_chunks').aggregate.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue(e2eChunkDocs),
  }));
}

describe('cross-encoder reranker through retrieval: cannot widen access', () => {
  beforeEach(() => {
    e2eChunkDocs = [];
    e2eDocumentDocs = [];
    embed.mockResolvedValue([[0.1, 0.2, 0.3]]);
    setupE2ERetrieval([]);
  });

  it('emits exactly the authorized chunk set, reordered, against a hostile endpoint', async () => {
    setupE2ERetrieval([chunkDoc('a', 0.9), chunkDoc('b', 0.8), chunkDoc('c', 0.7)]);
    const { fetchImpl } = capturingFetch(
      okResponse({
        results: [
          // Hostile: out-of-range index must be ignored; chunk 'a' downgraded.
          { index: 42, relevance_score: 0.99 },
          { index: 2, relevance_score: 0.95 },
          { index: 0, relevance_score: 0.01 },
        ],
      })
    );
    setReranker(createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl }));
    const result = await retrieveAuthorizedContext(auth, 'query');
    const ids = result.results.map((chunk) => chunk.chunkId);
    expect(new Set(ids)).toEqual(new Set(['a', 'b', 'c']));
    expect(ids).toEqual(['c', 'a', 'b']); // endpoint reorder; unscored 'b' appended
    for (const chunk of result.results) {
      expect(chunk.text).toBe(`canonical content of ${chunk.chunkId}`);
      expect(chunk.documentId).toBe(`doc-${chunk.chunkId}`);
    }
    expect(result.citations.every((citation) => ids.includes(citation.chunkId))).toBe(true);
  });

  it('falls back to hybrid order through retrieval when the endpoint is down', async () => {
    setupE2ERetrieval([chunkDoc('a', 0.9), chunkDoc('b', 0.8)]);
    const { fetchImpl } = capturingFetch(failingResponse(503));
    setReranker(createCrossEncoderReranker({ url: ALLOWED_URL, fetchImpl }));
    const result = await retrieveAuthorizedContext(auth, 'query');
    expect(result.results.map((chunk) => chunk.chunkId)).toEqual(['a', 'b']);
    expect(fallbackSeriesCount('http_error')).toBe(1);
  });
});
