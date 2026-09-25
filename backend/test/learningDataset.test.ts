/**
 * learningDataset.test.ts — SFT dataset builder (ADR-015).
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live MongoDB):
 *  - buildExample reconstructs the (user turn, assistant turn) pair from the
 *    messages collection: correction wins for down+correction, the original
 *    answer is used for up ratings.
 *  - down ratings WITHOUT a correction are skipped (no training signal).
 *  - buildDataset only consumes approved feedback and names are unique per
 *    tenant; datasetToJsonl renders one JSON object per line.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock, tenantOpMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  const tenantOpMock = vi.fn(async (_tenantId: string, cb: (db: any) => Promise<any>) => cb(await getDbMock()));
  return { getDbMock, tenantOpMock };
});
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock, tenantOp: tenantOpMock }));

import {
  buildDataset,
  buildExample,
  datasetToJsonl,
  FinetuneDatasetDoc,
} from '../src/learning/dataset.js';
import { FeedbackContext, FeedbackDoc } from '../src/learning/feedbackStore.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
const CONV = 'c1111111-1111-4111-8111-111111111111';
const CTX_A: FeedbackContext = { tenantId: TENANT_A, userId: USER_A1, clearance: 'CONFIDENTIAL' };

function fb(overrides: Partial<FeedbackDoc>): FeedbackDoc {
  return {
    _id: 'fb-1', tenantId: TENANT_A, userId: USER_A1, conversationId: CONV,
    messageId: 'msg-assistant-1', rating: 'down', classification: 'INTERNAL',
    status: 'approved', createdAt: new Date(), updatedAt: new Date(),
    ...overrides,
  } as FeedbackDoc;
}

const MESSAGES = [
  { _id: 'msg-user-1', conversationId: CONV, tenantId: TENANT_A, role: 'user', content: 'Why is order 123 late?', createdAt: new Date('2026-01-01') },
  { _id: 'msg-assistant-1', conversationId: CONV, tenantId: TENANT_A, role: 'assistant', content: 'Wrong answer.', createdAt: new Date('2026-01-02') },
];

const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn(),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
    };
  }
  return mockCollections[name];
}

function mockFind(toResolve: any[]) {
  getMockCollection('messages').find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue(toResolve),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }));
  getMockCollection('feedback').find.mockImplementation(() => ({
    toArray: vi.fn().mockResolvedValue(toResolve),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  getDbMock.mockResolvedValue({ collection: (name: string) => getMockCollection(name) });
  for (const coll of Object.values(mockCollections)) {
    coll.findOne.mockReset().mockResolvedValue(null);
    coll.find.mockReset();
    coll.insertOne.mockReset().mockResolvedValue({ acknowledged: true });
  }
});

describe('buildExample', () => {
  it('uses the correction as the assistant turn for down+correction', async () => {
    mockFind(MESSAGES);
    const { example, skipped } = await buildExample(CTX_A, fb({ correction: 'Right answer.' }));
    expect(skipped).toBe(false);
    expect(example!.messages).toEqual([
      { role: 'user', content: 'Why is order 123 late?' },
      { role: 'assistant', content: 'Right answer.' },
    ]);
    expect(example!.sourceFeedbackId).toBe('fb-1');
  });

  it('uses the original answer for up ratings', async () => {
    mockFind(MESSAGES);
    const { example, skipped } = await buildExample(CTX_A, fb({ rating: 'up', correction: undefined }));
    expect(skipped).toBe(false);
    expect(example!.messages[1]).toEqual({ role: 'assistant', content: 'Wrong answer.' });
  });

  it('prefers the correction even on up ratings', async () => {
    mockFind(MESSAGES);
    const { example, skipped } = await buildExample(CTX_A, fb({ rating: 'up', correction: 'Fixed detail.' }));
    expect(skipped).toBe(false);
    expect(example!.messages[1]).toEqual({ role: 'assistant', content: 'Fixed detail.' });
  });

  it('skips down ratings without a correction', async () => {
    const { example, skipped } = await buildExample(CTX_A, fb({ rating: 'down', correction: undefined }));
    expect(skipped).toBe(true);
    expect(example).toBeNull();
  });

  it('skips when the rated message is gone', async () => {
    mockFind([]);
    const { skipped } = await buildExample(CTX_A, fb({ correction: 'x' }));
    expect(skipped).toBe(true);
  });

  it('skips when there is no preceding user turn', async () => {
    mockFind([{ _id: 'msg-assistant-1', conversationId: CONV, tenantId: TENANT_A, role: 'assistant', content: 'Hi', createdAt: new Date() }]);
    const { skipped } = await buildExample(CTX_A, fb({ correction: 'x' }));
    expect(skipped).toBe(true);
  });
});

describe('buildDataset', () => {
  it('builds from approved feedback only and stores the doc', async () => {
    mockFind(MESSAGES);
    getMockCollection('finetune_datasets').findOne.mockResolvedValue(null);
    getMockCollection('feedback').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([fb({ correction: 'Right answer.' })]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    }));
    const dataset = await buildDataset(CTX_A, { name: 'v1' });
    expect(dataset.exampleCount).toBe(1);
    expect(dataset.status).toBe('ready');
    expect(dataset.tenantId).toBe(TENANT_A);
    expect(getMockCollection('finetune_datasets').insertOne).toHaveBeenCalled();
  });

  it('rejects duplicate dataset names per tenant', async () => {
    getMockCollection('finetune_datasets').findOne.mockResolvedValue({ _id: 'd1', name: 'v1' });
    await expect(buildDataset(CTX_A, { name: 'v1' })).rejects.toMatchObject({ code: 'DATASET_NAME_TAKEN' });
  });

  it('rejects empty datasets', async () => {
    mockFind(MESSAGES);
    getMockCollection('finetune_datasets').findOne.mockResolvedValue(null);
    getMockCollection('feedback').find.mockImplementation(() => ({
      toArray: vi.fn().mockResolvedValue([fb({ rating: 'down', correction: undefined })]),
      sort: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
    }));
    await expect(buildDataset(CTX_A, { name: 'v1' })).rejects.toMatchObject({ code: 'DATASET_EMPTY' });
  });
});

describe('datasetToJsonl', () => {
  it('renders one JSON object per line', () => {
    const doc = {
      examples: [
        { messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }], sourceFeedbackId: 'f1', classification: 'INTERNAL' },
      ],
    } as FinetuneDatasetDoc;
    const jsonl = datasetToJsonl(doc);
    expect(jsonl.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(jsonl)).toEqual({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }] });
  });
});
