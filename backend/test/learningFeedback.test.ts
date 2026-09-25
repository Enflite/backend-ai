/**
 * learningFeedback.test.ts — tenant-scoped feedback store (ADR-015).
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - createFeedback binds tenantId/userId from the caller's auth context and
 *    never trusts request input for them.
 *  - Classification above the caller's clearance fails closed.
 *  - curateFeedback only transitions pending → approved/rejected (terminal
 *    states cannot be re-curated).
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL MONGODB ATLAS:
 *  - That indexes exist and the migration chain applies cleanly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));

import {
  createFeedback,
  curateFeedback,
  listFeedback,
  FeedbackContext,
} from '../src/learning/feedbackStore.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
const CONV = 'c1111111-1111-4111-8111-111111111111';

const CTX_A: FeedbackContext = { tenantId: TENANT_A, userId: USER_A1, clearance: 'CONFIDENTIAL' };

const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => ({
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
      })),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    };
  }
  return mockCollections[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  getDbMock.mockResolvedValue({ collection: (name: string) => getMockCollection(name) });
  for (const coll of Object.values(mockCollections)) {
    coll.findOne.mockReset().mockResolvedValue(null);
    coll.findOneAndUpdate.mockReset().mockResolvedValue(null);
    coll.insertOne.mockReset().mockResolvedValue({ acknowledged: true });
    coll.updateOne.mockReset().mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.find.mockReset().mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
    }));
  }
});

describe('createFeedback', () => {
  it('binds tenantId and userId from the auth context', async () => {
    const doc = await createFeedback(CTX_A, {
      conversationId: CONV,
      messageId: 'msg-1',
      rating: 'up',
    });
    expect(doc.tenantId).toBe(TENANT_A);
    expect(doc.userId).toBe(USER_A1);
    expect(doc.status).toBe('pending');
    const inserted = getMockCollection('feedback').insertOne.mock.calls[0][0];
    expect(inserted.tenantId).toBe(TENANT_A);
    expect(inserted.userId).toBe(USER_A1);
  });

  it('defaults classification to the caller clearance', async () => {
    const doc = await createFeedback(CTX_A, { conversationId: CONV, messageId: 'msg-1', rating: 'up' });
    expect(doc.classification).toBe('CONFIDENTIAL');
  });

  it('rejects classification above the caller clearance', async () => {
    await expect(
      createFeedback(CTX_A, { conversationId: CONV, messageId: 'msg-1', rating: 'up', classification: 'CUI' })
    ).rejects.toThrow();
    expect(getMockCollection('feedback').insertOne).not.toHaveBeenCalled();
  });

  it('trims and stores corrections on down ratings', async () => {
    const doc = await createFeedback(CTX_A, {
      conversationId: CONV, messageId: 'msg-1', rating: 'down', correction: '  fixed answer  ',
    });
    expect(doc.correction).toBe('fixed answer');
  });

  it('rejects empty corrections', async () => {
    await expect(
      createFeedback(CTX_A, { conversationId: CONV, messageId: 'msg-1', rating: 'down', correction: '   ' })
    ).rejects.toThrow();
  });
});

describe('curateFeedback', () => {
  it('transitions pending → approved and records the reviewer', async () => {
    const updated = { _id: 'f1', status: 'approved', reviewedBy: USER_A1 };
    getMockCollection('feedback').findOneAndUpdate.mockResolvedValue(updated);
    const doc = await curateFeedback(CTX_A, 'f1', 'approved');
    expect(doc.status).toBe('approved');
    const filter = getMockCollection('feedback').findOneAndUpdate.mock.calls[0][0];
    expect(filter).toMatchObject({ _id: 'f1', tenantId: TENANT_A, status: 'pending' });
    expect(getMockCollection('feedback').findOneAndUpdate.mock.calls[0][1].$set.reviewedBy).toBe(USER_A1);
  });

  it('throws when the row is already curated (no pending match)', async () => {
    getMockCollection('feedback').findOneAndUpdate.mockResolvedValue(null);
    await expect(curateFeedback(CTX_A, 'f1', 'approved')).rejects.toMatchObject({ code: 'FEEDBACK_NOT_FOUND' });
  });
});

describe('listFeedback', () => {
  it('always filters by the caller tenant', async () => {
    const rows = [{ _id: 'f1', tenantId: TENANT_A }];
    getMockCollection('feedback').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue(rows),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      skip: vi.fn().mockReturnThis(),
    }));
    const result = await listFeedback(CTX_A, { status: 'pending' });
    expect(result).toEqual(rows);
    const filter = getMockCollection('feedback').find.mock.calls[0][0];
    expect(filter.tenantId).toBe(TENANT_A);
    expect(filter.tenantId).not.toBe(TENANT_B);
  });
});
