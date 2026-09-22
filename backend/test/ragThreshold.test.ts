import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock, withTenantTxMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  const withTenantTxMock = vi.fn(async (_tenantId: string, cb: (s: any, db: any) => Promise<any>) => cb({}, await getDbMock()));
  return { getDbMock, tenantOpMock, withTenantTxMock };
});
const embedMock = vi.hoisted(() => vi.fn());
vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  tenantOp: tenantOpMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/documents/ingestion.js', () => ({
  internalEmbeddingProvider: () => ({
    model: 'embedding-test', version: '1', dimensions: 2,
    embed: embedMock,
  }),
}));

import { config } from '../src/config.js';
import { retrieveAuthorizedContext } from '../src/rag/retrieval.js';
import type { AuthContext } from '../src/authz/permissions.js';

const auth: AuthContext = {
  userId: '11111111-1111-4111-8111-111111111111', tenantId: '22222222-2222-4222-8222-222222222222',
  sessionId: '33333333-3333-4333-8333-333333333333', roleId: '44444444-4444-4444-8444-444444444444',
  email: 'user@example.test', displayName: 'User', roleName: 'User', clearance: 'INTERNAL', permissions: ['document:read'],
};

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      insertMany: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      aggregate: vi.fn().mockImplementation(() => ({ toArray: vi.fn().mockResolvedValue([]) })),
    };
  }
  return mockCollections[name];
}

function resetDbMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset(); coll.findOne.mockResolvedValue(null);
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
    coll.aggregate.mockReset();
    coll.aggregate.mockImplementation(() => ({ toArray: vi.fn().mockResolvedValue([]) }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

// Chunk row in the MongoDB aggregate output shape.
const row = {
  _id: 'c1',
  content: 'the quick brown fox jumps over the lazy dog',
  documentId: 'd1',
  classification: 'INTERNAL',
  page: null,
  section: null,
  sourceLocation: null,
  vectorScore: 0.9,
};

let chunkRows: Record<string, unknown>[] = [row];

describe('retrieval similarity threshold', () => {
  beforeEach(() => {
    resetDbMocks();
    embedMock.mockReset();
    embedMock.mockResolvedValue([[0.1, 0.2]]);
    config.RAG_SIMILARITY_THRESHOLD = 0;
    chunkRows = [row];

    // Authorized document for the chunk.
    const docsColl = getMockCollection('documents');
    docsColl.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([
        { _id: 'd1', filename: 'doc.md', classification: 'INTERNAL' },
      ]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));

    const chunksColl = getMockCollection('document_chunks');
    chunksColl.aggregate.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue(chunkRows),
    }));
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
    // No database query runs when the embedding is invalid: getDb is never called.
    expect(getDbMock).not.toHaveBeenCalled();
  });
});
