/**
 * reliabilityEval.test.ts — the reliability eval corpus is self-consistent.
 *
 * Uses the REAL judges (backend/src/eval/judges.ts), not reimplementations:
 * every reliability case's mockResponse must PASS its own judge, and the
 * anti-examples must FAIL — proving the deterministic judges actually
 * discriminate (a "pass" means the graceful-degradation behavior is present,
 * not that the judge is vacuous).
 */
import { describe, expect, it } from 'vitest';
import { RELIABILITY_CASES } from '../src/eval/cases/reliability.js';
import { EVAL_CORPUS } from '../src/eval/cases/index.js';
import { judgeResponse, type JudgeInput } from '../src/eval/judges.js';
import type { EvalCase } from '../src/eval/types.js';

function mockToInput(c: EvalCase): JudgeInput {
  if (c.mockResponse === undefined) throw new Error(`${c.id}: missing mockResponse`);
  return typeof c.mockResponse === 'string'
    ? { content: c.mockResponse }
    : { content: c.mockResponse.content ?? '', toolCalls: c.mockResponse.toolCalls };
}

function ragChunks(c: EvalCase): Array<{ chunkId: string }> {
  return (c.ragContext ?? []).map((r) => ({ chunkId: r.chunkId }));
}

describe('reliability corpus wiring', () => {
  it('is registered in EVAL_CORPUS with no duplicate or missing ids', () => {
    const ids = new Set(EVAL_CORPUS.map((c) => c.id));
    for (const c of RELIABILITY_CASES) {
      expect(ids.has(c.id), `${c.id} registered`).toBe(true);
    }
    expect(new Set(RELIABILITY_CASES.map((c) => c.id)).size).toBe(RELIABILITY_CASES.length);
  });

  it('covers all three failure modes with at least two cases each', () => {
    const groups = ['capacity', 'tool-failure', 'partial-retrieval'];
    for (const g of groups) {
      const n = RELIABILITY_CASES.filter((c) => c.id.startsWith(`reliability-${g}-`)).length;
      expect(n, `reliability-${g}-* count`).toBeGreaterThanOrEqual(2);
    }
  });

  it('last user messages are unique across the whole corpus', () => {
    // mockChatFn keys scripted responses by last user message: a collision
    // silently judges two cases against one mock (this bit us during authoring).
    const seen = new Map<string, string>();
    const collisions: string[] = [];
    for (const c of EVAL_CORPUS) {
      const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
      if (!lastUser) continue;
      const prev = seen.get(lastUser.content);
      if (prev) collisions.push(`${prev} <-> ${c.id}`);
      else seen.set(lastUser.content, c.id);
    }
    expect(collisions, 'last-user-message collisions').toEqual([]);
  });

  it('every case is deterministic (no llm-judge), has a mock, and valid dimensions', () => {
    const validDimensions = new Set([
      'helpfulness', 'honesty-calibration', 'instruction-following',
      'grounding-citations', 'tool-competence', 'multi-turn-coherence',
      'refusal-correctness', 'tone',
    ]);
    for (const c of RELIABILITY_CASES) {
      expect(c.judge.kind, `${c.id} judge kind`).not.toBe('llm-judge');
      expect(c.mockResponse, `${c.id} mockResponse`).toBeDefined();
      expect(c.category, `${c.id} category`).toBe('reliability');
      for (const d of c.dimensions ?? []) {
        expect(validDimensions.has(d), `${c.id} dimension ${d}`).toBe(true);
      }
    }
  });
});

describe('reliability corpus self-consistency (real judges)', () => {
  it('every mockResponse passes its own judge', () => {
    const failures: string[] = [];
    for (const c of RELIABILITY_CASES) {
      const verdict = judgeResponse(c.judge, mockToInput(c), ragChunks(c));
      if (!verdict.passed) failures.push(`${c.id}: ${JSON.stringify(verdict.details)}`);
    }
    expect(failures, `${failures.length} reliability self-consistency failures`).toEqual([]);
  });
});

describe('reliability judges discriminate (anti-examples fail)', () => {
  const byId = new Map(RELIABILITY_CASES.map((c) => [c.id, c]));

  it('an invented completion fails the capacity honesty cases', () => {
    const invented: JudgeInput = {
      content: 'Processing complete — here is your summary of the Q3 sales report.',
    };
    const busyVerdict = judgeResponse(byId.get('reliability-capacity-001')!.judge, invented);
    const noInventionVerdict = judgeResponse(byId.get('reliability-capacity-002')!.judge, invented);
    expect(busyVerdict.passed, 'capacity-001 rejects invented completion').toBe(false);
    expect(noInventionVerdict.passed, 'capacity-002 rejects invented completion').toBe(false);
  });

  it('policy narration and hallucinated PO records fail the tool-failure honesty case', () => {
    const bad: JudgeInput = {
      content:
        'Per my guidelines, policy prevents me from showing raw records, but I found ' +
        '12 purchase orders including PO-90042.',
    };
    const verdict = judgeResponse(byId.get('reliability-tool-failure-002')!.judge, bad);
    expect(verdict.passed, 'tool-failure-002 rejects policy narration + invented records').toBe(false);
  });

  it('a confabulated 2025 figure fails the partial-retrieval honesty case', () => {
    const confabulated: JudgeInput = {
      content: 'The 2025 window is 60 days, definitely — guaranteed by the new policy.',
    };
    const verdict = judgeResponse(
      byId.get('reliability-partial-retrieval-002')!.judge,
      confabulated,
      ragChunks(byId.get('reliability-partial-retrieval-002')!),
    );
    expect(verdict.passed, 'partial-retrieval-002 rejects confabulation').toBe(false);
  });
});
