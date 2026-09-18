/**
 * evalStore.test.ts — eval persistence against a mocked pg pool.
 * Asserts the SQL each store function issues (text + params) and how rows
 * are mapped. No live Postgres.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { query } = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ query }));

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

beforeEach(() => {
  vi.clearAllMocks();
});

function rows<T>(data: T[]) {
  return { rows: data, rowCount: data.length };
}

describe('eval store', () => {
  it('createRun inserts a running run and returns its id', async () => {
    vi.mocked(query).mockResolvedValue(rows([{ id: 'run-1' }]));
    const id = await createRun({ modelId: 'model-1', modelVersion: '1.0', provider: 'mock', createdBy: 'user-1' });
    expect(id).toBe('run-1');
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('INSERT INTO eval_runs');
    expect(text).toContain("'running'");
    expect(params).toEqual(['model-1', '1.0', 'mock', 'user-1']);
  });

  it('saveCaseResult persists the verdict with JSON details', async () => {
    vi.mocked(query).mockResolvedValue(rows([]));
    await saveCaseResult('run-1', {
      caseId: 'c1',
      category: 'refusal',
      severity: 'p0',
      passed: true,
      score: 1,
      details: { judge: 'refusal' },
      latencyMs: 12,
    });
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('INSERT INTO eval_case_results');
    expect(params).toEqual(['run-1', 'c1', 'refusal', 'p0', true, 1, '{"judge":"refusal"}', 12]);
  });

  it('finishRun marks the run completed with totals + summary', async () => {
    vi.mocked(query).mockResolvedValue(rows([]));
    const summary = {
      runId: 'run-1', modelId: 'm', modelVersion: 'v', total: 2, passed: 1, failed: 1,
      byCategory: {}, p0Failed: [] as string[], byDimension: {}, skipped: 0,
    };
    await finishRun('run-1', summary);
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain("status = 'completed'");
    expect(params?.[0]).toBe('run-1');
    expect(JSON.parse(params?.[4] as string)).toMatchObject({ total: 2, passed: 1 });
  });

  it('failRun marks the run failed with a reason', async () => {
    vi.mocked(query).mockResolvedValue(rows([]));
    await failRun('run-1', 'boom');
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain("status = 'failed'");
    expect(JSON.parse(params?.[1] as string)).toEqual({ reason: 'boom' });
  });

  it('getRun returns null for unknown ids, else run + results', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([]));
    expect(await getRun('nope')).toBeNull();

    vi.mocked(query)
      .mockResolvedValueOnce(rows([{ id: 'run-1', model_id: 'm' }]))
      .mockResolvedValueOnce(rows([{ case_id: 'c1', passed: true }]));
    const found = await getRun('run-1');
    expect(found?.run.id).toBe('run-1');
    expect(found?.results).toHaveLength(1);
  });

  it('listRuns filters by model, newest first', async () => {
    vi.mocked(query).mockResolvedValue(rows([{ id: 'run-1' }]));
    const out = await listRuns('model-1');
    expect(out).toHaveLength(1);
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('WHERE model_id = $1');
    expect(text).toContain('ORDER BY created_at DESC');
    expect(params).toEqual(['model-1', 50]);
  });

  it('getModelVersion returns the version or null', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([{ version: '3.2' }]));
    expect(await getModelVersion('m')).toBe('3.2');
    vi.mocked(query).mockResolvedValueOnce(rows([]));
    expect(await getModelVersion('m')).toBeNull();
  });

  it('getLatestRunForVersion scopes to model + version', async () => {
    vi.mocked(query).mockResolvedValue(rows([{ id: 'run-9' }]));
    const run = await getLatestRunForVersion('m', '2.0');
    expect(run?.id).toBe('run-9');
    const [text, params] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain('model_version = $2');
    expect(params).toEqual(['m', '2.0']);
  });

  it('getP0Failures returns failing p0 case ids', async () => {
    vi.mocked(query).mockResolvedValue(rows([{ case_id: 'c1' }, { case_id: 'c2' }]));
    expect(await getP0Failures('run-1')).toEqual(['c1', 'c2']);
    const [text] = vi.mocked(query).mock.calls[0]!;
    expect(text).toContain("severity = 'p0'");
    expect(text).toContain('passed = false');
  });

  it('compareRuns reports deltas, regressions, and improvements', async () => {
    const resultsA = [
      { case_id: 'keep-pass', category: 'coding', passed: true },
      { case_id: 'regressed', category: 'coding', passed: true },
      { case_id: 'improved', category: 'refusal', passed: false },
    ];
    const resultsB = [
      { case_id: 'keep-pass', category: 'coding', passed: true },
      { case_id: 'regressed', category: 'coding', passed: false },
      { case_id: 'improved', category: 'refusal', passed: true },
    ];
    // Dispatch on run id: robust to the Promise.all interleaving of the two getRun calls.
    vi.mocked(query).mockImplementation(async (text: string, params?: unknown[]) => {
      const t = String(text);
      if (t.includes('FROM eval_case_results')) return rows(params?.[0] === 'a' ? resultsA : resultsB);
      if (t.includes('FROM eval_runs')) return rows([{ id: params?.[0], passed: 2, failed: 1, total: 3 }]);
      return rows([]);
    });
    const cmp = await compareRuns('a', 'b');
    expect(cmp?.regressions).toEqual(['regressed']);
    expect(cmp?.improvements).toEqual(['improved']);
    expect(cmp?.byCategory['coding']).toMatchObject({ passedA: 2, passedB: 1, delta: -1 });
    expect(cmp?.byCategory['refusal']).toMatchObject({ passedA: 0, passedB: 1, delta: 1 });
  });

  it('compareRuns returns null when a run is missing', async () => {
    vi.mocked(query).mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([{ id: 'b' }]));
    // getRun('a') -> null; getRun('b') needs run + results calls
    vi.mocked(query).mockResolvedValueOnce(rows([]));
    expect(await compareRuns('a', 'b')).toBeNull();
  });
});
