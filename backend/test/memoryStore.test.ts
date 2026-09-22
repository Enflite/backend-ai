/**
 * memoryStore.test.ts — tenant-scoped user memory store.
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - Every CRUD operation binds BOTH tenantId and userId from the
 *    caller's auth context — never from request input — so tenant A's
 *    context cannot produce a query that touches tenant B's documents.
 *  - Write-side classification is asserted against the caller's clearance
 *    (UNKNOWN fails closed via canAccessClassification).
 *  - A simulated isolated-database check: with the collection faked to
 *    filter by the bound (tenantId, userId) params, a tenant-A caller never
 *    sees tenant-B documents.
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL MONGODB ATLAS:
 *  - That the mandatory tenantId filter on every query actually blocks a
 *    query issued with a missing/mismatched tenantId, or that the migration
 *    chain applies cleanly. Those need a live-database CI job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));

import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  MemoryContext,
} from '../src/memory/store.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
const USER_B1 = 'b1111111-1111-4111-8111-111111111111';

const CTX_A: MemoryContext = { tenantId: TENANT_A, userId: USER_A1, clearance: 'CONFIDENTIAL' };

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    const findChain = () => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    });
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => findChain()),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'deleteOne', 'deleteMany']) {
      coll[m].mockReset();
      if (m === 'findOne') coll[m].mockResolvedValue(null);
      else if (m === 'findOneAndUpdate') coll[m].mockResolvedValue(null);
      else if (m === 'updateOne' || m === 'updateMany') coll[m].mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
      else if (m === 'insertOne') coll[m].mockResolvedValue({ acknowledged: true });
      else if (m === 'deleteOne' || m === 'deleteMany') coll[m].mockResolvedValue({ deletedCount: 1 });
    }
    coll.find.mockReset();
    coll.find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
      project: vi.fn().mockReturnThis(),
    }));
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

function lastInsertOne() {
  const coll = getMockCollection('memory_facts');
  const calls = coll.insertOne.mock.calls;
  return calls[calls.length - 1]![0];
}

function lastFindOne() {
  const coll = getMockCollection('memory_facts');
  const calls = coll.findOne.mock.calls;
  return calls[calls.length - 1]![0];
}

function lastFind() {
  const coll = getMockCollection('memory_facts');
  const calls = coll.find.mock.calls;
  return calls[calls.length - 1]![0];
}

function lastFindOneAndUpdate() {
  const coll = getMockCollection('memory_facts');
  const calls = coll.findOneAndUpdate.mock.calls;
  return { filter: calls[calls.length - 1]![0], update: calls[calls.length - 1]![1] };
}

function lastDeleteOne() {
  const coll = getMockCollection('memory_facts');
  const calls = coll.deleteOne.mock.calls;
  return calls[calls.length - 1]![0];
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

describe('createMemory', () => {
  it('scopes the INSERT to the caller tenant and user', async () => {
    await createMemory(CTX_A, { fact: 'prefers concise summaries' });
    const doc = lastInsertOne();
    expect(doc.tenantId).toBe(TENANT_A);
    expect(doc.userId).toBe(USER_A1);
    expect(doc.fact).toBe('prefers concise summaries');
    expect(doc._id).toBeDefined();
    // tenantOp was called with the caller's tenant
    expect(tenantOpMock).toHaveBeenCalledWith(TENANT_A, expect.any(Function));
  });

  it('defaults classification to INTERNAL for non-PUBLIC clearances', async () => {
    await createMemory(CTX_A, { fact: 'x' });
    expect(lastInsertOne().classification).toBe('INTERNAL');
  });

  it('defaults classification to PUBLIC for PUBLIC-cleared callers', async () => {
    await createMemory({ ...CTX_A, clearance: 'PUBLIC' }, { fact: 'x' });
    expect(lastInsertOne().classification).toBe('PUBLIC');
  });

  it('rejects a classification above the caller clearance', async () => {
    await expect(
      createMemory({ ...CTX_A, clearance: 'PUBLIC' }, { fact: 'x', classification: 'CONFIDENTIAL' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
    expect(getMockCollection('memory_facts').insertOne).not.toHaveBeenCalled();
  });

  it('rejects UNKNOWN classification (fails closed)', async () => {
    await expect(
      createMemory(CTX_A, { fact: 'x', classification: 'UNKNOWN' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
  });
});

describe('getMemory / listMemories', () => {
  it('getMemory predicates _id, tenantId, AND userId', async () => {
    const doc = {
      _id: 'm1', tenantId: TENANT_A, userId: USER_A1, fact: 'x',
      category: 'fact', classification: 'INTERNAL', source: 'user-stated',
      createdAt: new Date(), updatedAt: new Date(),
    };
    getMockCollection('memory_facts').findOne.mockResolvedValue(doc);
    const row = await getMemory(CTX_A, 'm1-id-uuid');
    expect(row.id).toBe('m1');
    const filter = lastFindOne();
    expect(filter).toEqual({ _id: 'm1-id-uuid', tenantId: TENANT_A, userId: USER_A1 });
  });

  it('getMemory throws MEMORY_NOT_FOUND when another tenant owns the row', async () => {
    getMockCollection('memory_facts').findOne.mockResolvedValue(null);
    await expect(getMemory(CTX_A, 'someone-elses-id')).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    });
    // The module asked for the caller's tenant+user — it cannot reach
    // another tenant's document even if the id is known.
    expect(lastFindOne()).toEqual({ _id: 'someone-elses-id', tenantId: TENANT_A, userId: USER_A1 });
  });

  it('listMemories scopes to tenant+user and orders most-recent-first', async () => {
    await listMemories(CTX_A, { limit: 10, offset: 5 });
    const filter = lastFind();
    expect(filter).toEqual({ tenantId: TENANT_A, userId: USER_A1 });
    // Verify sort/limit/skip were chained
    const findResult = getMockCollection('memory_facts').find.mock.results[0]!.value;
    expect(findResult.sort).toHaveBeenCalledWith({ updatedAt: -1 });
    expect(findResult.skip).toHaveBeenCalledWith(5);
    expect(findResult.limit).toHaveBeenCalledWith(10);
  });

  it('listMemories supports a category filter', async () => {
    await listMemories(CTX_A, { category: 'preference' });
    const filter = lastFind();
    expect(filter).toEqual({ tenantId: TENANT_A, userId: USER_A1, category: 'preference' });
  });
});

describe('updateMemory / deleteMemory', () => {
  it('updateMemory predicates tenant+user and rejects over-clearance classification', async () => {
    const doc = {
      _id: 'm1', tenantId: TENANT_A, userId: USER_A1, fact: 'new text',
      category: 'fact', classification: 'INTERNAL', source: 'user-stated',
      createdAt: new Date(), updatedAt: new Date(),
    };
    getMockCollection('memory_facts').findOneAndUpdate.mockResolvedValue(doc);
    await updateMemory(CTX_A, 'm1', { fact: 'new text' });
    const { filter, update } = lastFindOneAndUpdate();
    expect(filter).toEqual({ _id: 'm1', tenantId: TENANT_A, userId: USER_A1 });
    expect(update.$set.fact).toBe('new text');
    expect(update.$set.updatedAt).toBeInstanceOf(Date);

    await expect(
      updateMemory({ ...CTX_A, clearance: 'INTERNAL' }, 'm1', { classification: 'CUI' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
  });

  it('updateMemory with no fields is rejected', async () => {
    await expect(updateMemory(CTX_A, 'm1', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('updateMemory throws MEMORY_NOT_FOUND for another user’s row', async () => {
    getMockCollection('memory_facts').findOneAndUpdate.mockResolvedValue(null);
    await expect(updateMemory(CTX_A, 'm1', { fact: 'x' })).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    });
  });

  it('deleteMemory predicates tenant+user and throws when nothing was deleted', async () => {
    getMockCollection('memory_facts').deleteOne.mockResolvedValue({ deletedCount: 1 });
    await deleteMemory(CTX_A, 'm1');
    expect(lastDeleteOne()).toEqual({ _id: 'm1', tenantId: TENANT_A, userId: USER_A1 });

    getMockCollection('memory_facts').deleteOne.mockResolvedValue({ deletedCount: 0 });
    await expect(deleteMemory(CTX_A, 'm1')).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });
});

describe('cross-tenant isolation (simulated database)', () => {
  it('a tenant-A caller never sees tenant-B documents through this module', async () => {
    const docs = [
      { _id: 'a1', tenantId: TENANT_A, userId: USER_A1, fact: 'A fact', category: 'fact', classification: 'INTERNAL', source: 'user-stated', createdAt: new Date(), updatedAt: new Date() },
      { _id: 'b1', tenantId: TENANT_B, userId: USER_B1, fact: 'B fact', category: 'fact', classification: 'INTERNAL', source: 'user-stated', createdAt: new Date(), updatedAt: new Date() },
    ];
    getMockCollection('memory_facts').find.mockImplementation((filter: any) => {
      // Behave like the real database: documents are returned only for the
      // bound (tenantId, userId) pair.
      const filtered = docs.filter(
        (d) => d.tenantId === filter.tenantId && d.userId === filter.userId
      );
      return {
        toArray: vi.fn().mockResolvedValue(filtered),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
      };
    });
    const seen = await listMemories(CTX_A, {});
    expect(seen.map((r) => r.id)).toEqual(['a1']);
    const seenB = await listMemories({ tenantId: TENANT_B, userId: USER_B1, clearance: 'CONFIDENTIAL' }, {});
    expect(seenB.map((r) => r.id)).toEqual(['b1']);
  });
});
