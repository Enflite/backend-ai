/**
 * evalStore.test.ts — eval persistence against a mocked MongoDB.
 * Asserts the operations each store function issues (collection + filter/update)
 * and how documents are mapped. No live MongoDB.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));

import {
  compareRuns,
  createRun,
  failRun,
  finishRun,
  getLatestRunForVersion,
  getModelVersion,
  getP0Failures,
  getRun,
  listRuns,
  saveCaseResult,
} from '../src/eval/store.js';

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    const findChain = () => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        project: vi.fn().mockReturnThis(),
        next: vi.fn().mockResolvedValue(null),
      };
      // Make mockReturnThis work properly for chaining
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    };
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      find: vi.fn().mockImplementation(() => findChain()),
      findOneAndUpdate: vi.fn().mockResolvedValue(null),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
    };
  }
  return mockCollections[name];
}

function resetMocks() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    for (const m of ['findOne', 'findOneAndUpdate', 'updateOne', 'updateMany', 'insertOne', 'deleteMany']) {
      coll[m].mockReset();
      if (m === 'findOne') coll[m].mockResolvedValue(null);
      else if (m === 'findOneAndUpdate') coll[m].mockResolvedValue(null);
      else if (m === 'updateOne' || m === 'updateMany') coll[m].mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
      else if (m === 'insertOne') coll[m].mockResolvedValue({ acknowledged: true, insertedId: 'mock-id' });
      else if (m === 'deleteMany') coll[m].mockResolvedValue({ deletedCount: 0 });
    }
    coll.find.mockReset();
    coll.find.mockImplementation(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  resetMocks();
});

describe('eval store', () => {
  it('createRun inserts a running run and returns its id', async () => {
    const id = await createRun({ modelId: 'model-1', modelVersion: '1.0', provider: 'mock', createdBy: 'user-1' });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const coll = getMockCollection('eval_runs');
    expect(coll.insertOne).toHaveBeenCalledTimes(1);
    const doc = coll.insertOne.mock.calls[0]![0];
    expect(doc.modelId).toBe('model-1');
    expect(doc.modelVersion).toBe('1.0');
    expect(doc.provider).toBe('mock');
    expect(doc.createdBy).toBe('user-1');
    expect(doc.status).toBe('running');
    expect(doc._id).toBe(id);
  });

  it('saveCaseResult persists the verdict with details object', async () => {
    await saveCaseResult('run-1', {
      caseId: 'c1',
      category: 'refusal',
      severity: 'p0',
      passed: true,
      score: 1,
      details: { judge: 'refusal' },
      latencyMs: 12,
    });
    const coll = getMockCollection('eval_case_results');
    expect(coll.insertOne).toHaveBeenCalledTimes(1);
    const doc = coll.insertOne.mock.calls[0]![0];
    expect(doc.runId).toBe('run-1');
    expect(doc.caseId).toBe('c1');
    expect(doc.category).toBe('refusal');
    expect(doc.severity).toBe('p0');
    expect(doc.passed).toBe(true);
    expect(doc.score).toBe(1);
    expect(doc.details).toEqual({ judge: 'refusal' });
    expect(doc.latencyMs).toBe(12);
  });

  it('finishRun marks the run completed with totals + summary', async () => {
    const summary = {
      runId: 'run-1', modelId: 'm', modelVersion: 'v', total: 2, passed: 1, failed: 1,
      byCategory: {}, p0Failed: [] as string[], byDimension: {}, skipped: 0,
    };
    await finishRun('run-1', summary);
    const coll = getMockCollection('eval_runs');
    expect(coll.updateOne).toHaveBeenCalledTimes(1);
    const [filter, update] = coll.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: 'run-1' });
    expect(update.$set.status).toBe('completed');
    expect(update.$set.total).toBe(2);
    expect(update.$set.passed).toBe(1);
    expect(update.$set.summary).toMatchObject({ total: 2, passed: 1 });
  });

  it('failRun marks the run failed with a reason', async () => {
    await failRun('run-1', 'boom');
    const coll = getMockCollection('eval_runs');
    const [filter, update] = coll.updateOne.mock.calls[0]!;
    expect(filter).toEqual({ _id: 'run-1' });
    expect(update.$set.status).toBe('failed');
    expect(update.$set.summary).toEqual({ reason: 'boom' });
  });

  it('getRun returns null for unknown ids, else run + results', async () => {
    const runsColl = getMockCollection('eval_runs');
    const resultsColl = getMockCollection('eval_case_results');

    runsColl.findOne.mockResolvedValueOnce(null);
    expect(await getRun('nope')).toBeNull();

    const runDoc = {
      _id: 'run-1', modelId: 'm', modelVersion: 'v', provider: 'mock',
      status: 'completed', total: 1, passed: 1, failed: 0,
      summary: {}, createdAt: new Date(), createdBy: null,
    };
    const resultDoc = {
      _id: 'r1', runId: 'run-1', caseId: 'c1', category: 'refusal',
      severity: 'p0', passed: true, score: 1, details: {}, latencyMs: 5,
    };
    runsColl.findOne.mockResolvedValueOnce(runDoc);
    resultsColl.find.mockImplementationOnce(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([resultDoc]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    const found = await getRun('run-1');
    expect(found?.run.id).toBe('run-1');
    expect(found?.results).toHaveLength(1);
    expect(found?.results[0]!.case_id).toBe('c1');
  });

  it('listRuns filters by model, newest first', async () => {
    const runDoc = {
      _id: 'run-1', modelId: 'model-1', modelVersion: 'v', provider: 'mock',
      status: 'completed', total: 1, passed: 1, failed: 0,
      summary: {}, createdAt: new Date(), createdBy: null,
    };
    const coll = getMockCollection('eval_runs');
    coll.find.mockImplementationOnce(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([runDoc]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    const out = await listRuns('model-1');
    expect(out).toHaveLength(1);
    const [filter] = coll.find.mock.calls[0]!;
    expect(filter).toEqual({ modelId: 'model-1' });
    const chain = coll.find.mock.results[0]!.value;
    expect(chain.sort).toHaveBeenCalledWith({ createdAt: -1 });
    expect(chain.limit).toHaveBeenCalledWith(50);
  });

  it('getModelVersion returns the version or null', async () => {
    const modelsColl = getMockCollection('models');
    modelsColl.findOne.mockResolvedValueOnce({ _id: 'm', version: '3.2' });
    expect(await getModelVersion('m')).toBe('3.2');
    modelsColl.findOne.mockResolvedValueOnce(null);
    expect(await getModelVersion('m')).toBeNull();
  });

  it('getLatestRunForVersion scopes to model + version', async () => {
    const runDoc = {
      _id: 'run-9', modelId: 'm', modelVersion: '2.0', provider: 'mock',
      status: 'completed', total: 1, passed: 1, failed: 0,
      summary: {}, createdAt: new Date(), createdBy: null,
    };
    const coll = getMockCollection('eval_runs');
    coll.find.mockImplementationOnce(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([runDoc]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(runDoc),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    const run = await getLatestRunForVersion('m', '2.0');
    expect(run?.id).toBe('run-9');
    const [filter] = coll.find.mock.calls[0]!;
    expect(filter).toEqual({ modelId: 'm', modelVersion: '2.0' });
  });

  it('getP0Failures returns failing p0 case ids', async () => {
    const coll = getMockCollection('eval_case_results');
    const resultDocs = [
      { _id: 'r1', runId: 'run-1', caseId: 'c1', category: 'x', severity: 'p0', passed: false, score: 0, details: {}, latencyMs: 1 },
      { _id: 'r2', runId: 'run-1', caseId: 'c2', category: 'x', severity: 'p0', passed: false, score: 0, details: {}, latencyMs: 1 },
    ];
    coll.find.mockImplementationOnce(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue(resultDocs),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    expect(await getP0Failures('run-1')).toEqual(['c1', 'c2']);
    const [filter] = coll.find.mock.calls[0]!;
    expect(filter.runId).toBe('run-1');
    expect(filter.severity).toBe('p0');
    expect(filter.passed).toBe(false);
    // llm-judge verdicts are excluded via $ne
    expect(filter['details.judge']).toEqual({ $ne: 'llm-judge' });
  });

  it('getP0Failures excludes llm-judge verdicts: they never gate promotion', async () => {
    const coll = getMockCollection('eval_case_results');
    coll.find.mockImplementationOnce(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    await getP0Failures('run-1');
    const [filter] = coll.find.mock.calls[0]!;
    expect(filter['details.judge']).toEqual({ $ne: 'llm-judge' });
  });

  it('compareRuns reports deltas, regressions, and improvements', async () => {
    const mkRunDoc = (id: string) => ({
      _id: id, modelId: 'm', modelVersion: 'v', provider: 'mock',
      status: 'completed', total: 3, passed: 2, failed: 1,
      summary: {}, createdAt: new Date(), createdBy: null,
    });
    const mkResultDoc = (runId: string, caseId: string, category: string, passed: boolean) => ({
      _id: `${runId}-${caseId}`, runId, caseId, category,
      severity: 'p1', passed, score: passed ? 1 : 0, details: {}, latencyMs: 1,
    });
    const resultsA = [
      mkResultDoc('a', 'keep-pass', 'coding', true),
      mkResultDoc('a', 'regressed', 'coding', true),
      mkResultDoc('a', 'improved', 'refusal', false),
    ];
    const resultsB = [
      mkResultDoc('b', 'keep-pass', 'coding', true),
      mkResultDoc('b', 'regressed', 'coding', false),
      mkResultDoc('b', 'improved', 'refusal', true),
    ];
    const runsColl = getMockCollection('eval_runs');
    const resultsColl = getMockCollection('eval_case_results');
    // Dispatch on run id: robust to the Promise.all interleaving of the two getRun calls.
    runsColl.findOne.mockImplementation(async (filter: any) => mkRunDoc(filter._id));
    resultsColl.find.mockImplementation((filter: any) => {
      const docs = filter.runId === 'a' ? resultsA : resultsB;
      const chain: any = {
        toArray: vi.fn().mockResolvedValue(docs),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    const cmp = await compareRuns('a', 'b');
    expect(cmp?.regressions).toEqual(['regressed']);
    expect(cmp?.improvements).toEqual(['improved']);
    expect(cmp?.byCategory['coding']).toMatchObject({ passedA: 2, passedB: 1, delta: -1 });
    expect(cmp?.byCategory['refusal']).toMatchObject({ passedA: 0, passedB: 1, delta: 1 });
  });

  it('compareRuns returns null when a run is missing', async () => {
    const runsColl = getMockCollection('eval_runs');
    const resultsColl = getMockCollection('eval_case_results');
    runsColl.findOne.mockImplementation(async (filter: any) => {
      if (filter._id === 'a') return null;
      return {
        _id: 'b', modelId: 'm', modelVersion: 'v', provider: 'mock',
        status: 'completed', total: 1, passed: 1, failed: 0,
        summary: {}, createdAt: new Date(), createdBy: null,
      };
    });
    resultsColl.find.mockImplementation(() => {
      const chain: any = {
        toArray: vi.fn().mockResolvedValue([]),
        sort: vi.fn(),
        limit: vi.fn(),
        project: vi.fn(),
        next: vi.fn().mockResolvedValue(null),
      };
      chain.sort.mockImplementation(() => chain);
      chain.limit.mockImplementation(() => chain);
      chain.project.mockImplementation(() => chain);
      return chain;
    });
    expect(await compareRuns('a', 'b')).toBeNull();
  });
});
