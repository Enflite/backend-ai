import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const embedMock = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/documents/ingestion.js', () => ({
  internalEmbeddingProvider: {
    model: 'embedding-test', version: '1', dimensions: 2,
    embed: embedMock,
  },
}));

import { config } from '../src/config.js';
import { retrieveAuthorizedContext } from '../src/rag/retrieval.js';
import type { AuthContext } from '../src/authz/permissions.js';

const auth: AuthContext = {
  userId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333', roleId: '44444444-4444-4444-8444-444444444444',
  email: 'user@example.test', displayName: 'User', roleName: 'User', clearance: 'INTERNAL', permissions: ['document:read'],
};

const row = {
  chunk_id: 'c1', content: 'the quick brown fox jumps over the lazy dog', page: null, section: null,
  source_location: null, document_id: 'd1', filename: 'doc.md', vector_score: '0.9',
};

describe('retrieval similarity threshold', () => {
  beforeEach(() => {
    tenantQuery.mockReset();
    embedMock.mockReset();
    embedMock.mockResolvedValue([[0.1, 0.2]]);
    config.RAG_SIMILARITY_THRESHOLD = 0;
    tenantQuery.mockResolvedValue({ rows: [row] });
  });

  it('excludes below-threshold chunks from model context', async () => {
    // Blended score: 0.9 * 0.85 + lexical * 0.15. 'question' shares no terms
    // with the content, so lexical = 0 and score = 0.765.
    config.RAG_SIMILARITY_THRESHOLD = 0.95;
    const result = await retrieveAuthorizedContext(auth, 'question');
    expect(result.results).toHaveLength(0);
    expect(result.context).toBe('');
    expect(result.citations).toHaveLength(0);
  });

  it('includes above-threshold chunks', async () => {
    config.RAG_SIMILARITY_THRESHOLD = 0.5;
    const result = await retrieveAuthorizedContext(auth, 'question');
    expect(result.results).toHaveLength(1);
    expect(result.context).toContain('<untrusted_document');
  });

  it('rejects non-finite query embeddings instead of querying with them', async () => {
    embedMock.mockResolvedValue([[NaN, 0.2]]);
    await expect(retrieveAuthorizedContext(auth, 'question')).rejects.toThrow('invalid query vector');
    expect(tenantQuery).not.toHaveBeenCalled();
  });
});
