/**
 * evalJudge.test.ts — tests for the llm-judge wiring: judge modes, the
 * deterministic mock judge, the real-judge path, and the NEVER-RUN-IN-CI /
 * never-gate safeguards.
 *
 * Covers:
 *  - mockJudge.ts: verdict contract (LlmJudgeResponse shape), determinism,
 *    scripted pass/fail rules, and that every corpus llm-judge mockResponse
 *    passes (guards the zero-skip CI run).
 *  - resolveJudgeMode: env/flag resolution, invalid values rejected.
 *  - assertRealJudgeAllowed: CI=true refuses real-judge mode unless
 *    EVAL_JUDGE_ALLOW_CI=1.
 *  - runLlmJudge/runEval: mock selected when EVAL_JUDGE_MODEL is unset (no
 *    skips); real path selected when it is set (gateway stubbed); rubric
 *    version recorded on every verdict; explicit skip mode still skips;
 *    self-judge warning; judge verdicts never appear in p0Failed or the
 *    promotion-gate dimension aggregates.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';

import { evaluateWithMockJudge, MOCK_JUDGE_MODEL_ID } from '../src/eval/mockJudge.js';
import {
  assertRealJudgeAllowed,
  mockChatFn,
  resolveJudgeMode,
  runEval,
  runLlmJudge,
} from '../src/eval/runner.js';
import { defaultRubric } from '../src/eval/llmJudge.js';
import { EVAL_CORPUS } from '../src/eval/cases/index.js';
import { EVAL_SEED_CORPUS } from '../src/eval/corpus.js';
import type { EvalCase, QualityDimension } from '../src/eval/types.js';

const DIMENSIONS: QualityDimension[] = [
  'helpfulness', 'honesty-calibration', 'instruction-following',
  'grounding-citations', 'tool-competence', 'multi-turn-coherence',
  'refusal-correctness', 'tone',
];

const ENV_KEYS = ['EVAL_JUDGE_MODEL', 'EVAL_JUDGE_MODE', 'EVAL_JUDGE_ALLOW_CI', 'CI'] as const;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  vi.restoreAllMocks();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k]!;
  }
  vi.restoreAllMocks();
});

function mockRequest(overrides: Record<string, unknown> = {}) {
  return {
    dimension: 'helpfulness' as QualityDimension,
    rubric: 'rubric text',
    rubricVersion: '2026-09-v1',
    response: 'A substantive response with enough length to be judged properly by the scripted rules.',
    caseId: 'case-1',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// mockJudge verdict contract
// ---------------------------------------------------------------------------

describe('evaluateWithMockJudge', () => {
  it('returns a valid LlmJudgeResponse for every dimension', async () => {
    for (const dimension of DIMENSIONS) {
      const v = await evaluateWithMockJudge(mockRequest({ dimension }));
      expect(v.dimension).toBe(dimension);
      expect(v.score).toBeGreaterThanOrEqual(0);
      expect(v.score).toBeLessThanOrEqual(1);
      expect(typeof v.passed).toBe('boolean');
      expect(typeof v.rationale).toBe('string');
      // Rubric version travels with the verdict; the judge is labeled mock.
      expect(v.rubricVersion).toBe('2026-09-v1');
      expect(v.judgeModel).toBe(MOCK_JUDGE_MODEL_ID);
      expect(v.rationale).toMatch(/MOCK verdict/);
    }
  });

  it('is deterministic: same request, same verdict', async () => {
    const a = await evaluateWithMockJudge(mockRequest());
    const b = await evaluateWithMockJudge(mockRequest());
    expect(a).toEqual(b);
  });

  it('passes the default rubric version through untouched', async () => {
    const v = await evaluateWithMockJudge(mockRequest({ rubricVersion: 'custom' }));
    expect(v.rubricVersion).toBe('custom');
  });

  it('fails an empty response', async () => {
    const v = await evaluateWithMockJudge(mockRequest({ response: '   ' }));
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
    expect(v.judgeModel).toBe(MOCK_JUDGE_MODEL_ID);
  });

  it('fails a too-short response', async () => {
    const v = await evaluateWithMockJudge(mockRequest({ response: 'Too short.' }));
    expect(v.passed).toBe(false);
    expect(v.score).toBeLessThan(0.5);
  });

  it('fails placeholder text', async () => {
    const v = await evaluateWithMockJudge(
      mockRequest({ response: 'Here is your answer: [TODO] fill in the refund policy details later.' })
    );
    expect(v.passed).toBe(false);
    expect(v.score).toBe(0);
  });

  it('fails scripted anti-patterns per dimension (not vacuous)', async () => {
    const tone = await evaluateWithMockJudge(
      mockRequest({
        dimension: 'tone',
        response:
          "I'm so sorry!!! I sincerely apologize for the inconvenience caused by this terrible mistake.",
      })
    );
    expect(tone.passed).toBe(false);

    const honesty = await evaluateWithMockJudge(
      mockRequest({
        dimension: 'honesty-calibration',
        response:
          'This will definitely fix the issue and is guaranteed to work without a doubt, trust me on this one.',
      })
    );
    expect(honesty.passed).toBe(false);

    const helpfulness = await evaluateWithMockJudge(
      mockRequest({
        dimension: 'helpfulness',
        response:
          "I don't know the answer to your question and I cannot help with this particular request at all.",
      })
    );
    expect(helpfulness.passed).toBe(false);
  });

  it('every corpus llm-judge mockResponse passes the mock judge (zero-skip CI run)', async () => {
    const cases = [...EVAL_CORPUS, ...EVAL_SEED_CORPUS].filter((c) => c.judge.kind === 'llm-judge');
    expect(cases.length).toBeGreaterThan(0);
    const failures: string[] = [];
    for (const c of cases) {
      const dimension = c.judge.dimension!;
      const { version } =
        c.judge.rubric !== undefined ? { version: 'custom' } : defaultRubric(dimension);
      const response =
        typeof c.mockResponse === 'string' ? c.mockResponse : (c.mockResponse?.content ?? '');
      const v = await evaluateWithMockJudge({
        dimension,
        rubric: c.judge.rubric ?? defaultRubric(dimension).rubric,
        rubricVersion: version,
        response,
        caseId: c.id,
      });
      if (!v.passed) failures.push(`${c.id}: ${v.rationale}`);
    }
    expect(failures, `${failures.length} corpus mockResponses fail the mock judge`).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// resolveJudgeMode
// ---------------------------------------------------------------------------

describe('resolveJudgeMode', () => {
  it('defaults to mock when nothing is configured (CI-safe)', () => {
    expect(resolveJudgeMode()).toBe('mock');
  });

  it('selects real when EVAL_JUDGE_MODEL is set', () => {
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    expect(resolveJudgeMode()).toBe('real');
  });

  it('honors EVAL_JUDGE_MODE over EVAL_JUDGE_MODEL', () => {
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    process.env.EVAL_JUDGE_MODE = 'mock';
    expect(resolveJudgeMode()).toBe('mock');
    process.env.EVAL_JUDGE_MODE = 'skip';
    expect(resolveJudgeMode()).toBe('skip');
  });

  it('an explicit flag value wins over the env', () => {
    process.env.EVAL_JUDGE_MODE = 'skip';
    expect(resolveJudgeMode('real')).toBe('real');
  });

  it('rejects invalid modes', () => {
    process.env.EVAL_JUDGE_MODE = 'sometimes';
    expect(() => resolveJudgeMode()).toThrow(/mock\|real\|skip/);
    expect(() => resolveJudgeMode('bogus')).toThrow(/mock\|real\|skip/);
  });
});

// ---------------------------------------------------------------------------
// assertRealJudgeAllowed — NEVER RUN IN CI
// ---------------------------------------------------------------------------

describe('assertRealJudgeAllowed', () => {
  it('allows real-judge mode outside CI', () => {
    expect(() => assertRealJudgeAllowed()).not.toThrow();
  });

  it('refuses real-judge mode when CI=true', () => {
    process.env.CI = 'true';
    expect(() => assertRealJudgeAllowed()).toThrow(/NEVER RUN IN CI/);
  });

  it('allows real-judge mode when CI=true only with the explicit override', () => {
    process.env.CI = 'true';
    process.env.EVAL_JUDGE_ALLOW_CI = '1';
    expect(() => assertRealJudgeAllowed()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runLlmJudge mode wiring
// ---------------------------------------------------------------------------

const llmCase: EvalCase = {
  id: 'judge-case-1',
  category: 'reasoning',
  title: 't',
  description: 'd',
  messages: [{ role: 'user', content: 'Help me.' }],
  judge: { kind: 'llm-judge', dimension: 'helpfulness' },
  mockResponse: 'Here is a substantive, actionable answer with concrete steps you can take right now.',
  severity: 'p2',
  dimensions: ['helpfulness'],
};

describe('runLlmJudge judge modes', () => {
  it('runs the mock judge when EVAL_JUDGE_MODEL is unset: no skips', async () => {
    const outcome = await runLlmJudge(llmCase, { content: llmCase.mockResponse as string });
    expect(outcome.skipped).toBe(false);
    expect(outcome.judgeModel).toBe(MOCK_JUDGE_MODEL_ID);
    expect(outcome.rubricVersion).toBe('2026-09-v1');
    expect(outcome.passed).toBe(true);
    expect(outcome.rationale).toMatch(/MOCK verdict/);
  });

  it('selects the real path when EVAL_JUDGE_MODEL is set (gateway stubbed)', async () => {
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    const judgeChat = vi.fn().mockResolvedValue({
      content: '{"score": 0.9, "passed": true, "rationale": "warm and direct"}',
    });
    const outcome = await runLlmJudge(llmCase, { content: 'a response' }, judgeChat);
    expect(outcome.skipped).toBe(false);
    expect(outcome).toMatchObject({
      passed: true,
      score: 0.9,
      judgeModel: 'judge-1',
      rubricVersion: '2026-09-v1',
      rationale: 'warm and direct',
    });
    expect(judgeChat).toHaveBeenCalledTimes(1);
  });

  it('skips only when skip mode is explicitly requested', async () => {
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await runLlmJudge(
      llmCase,
      { content: 'a response' },
      undefined,
      { mode: 'skip' }
    );
    expect(outcome.skipped).toBe(true);
    expect(outcome.reason).toMatch(/EVAL_JUDGE_MODE=skip/);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('judge-case-1'));
  });

  it('refuses real-judge mode when CI=true unless explicitly overridden', async () => {
    process.env.CI = 'true';
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    const judgeChat = vi.fn().mockResolvedValue({ content: '{"score": 1, "passed": true}' });
    await expect(runLlmJudge(llmCase, { content: 'x' }, judgeChat)).rejects.toThrow(/NEVER RUN IN CI/);
    expect(judgeChat).not.toHaveBeenCalled();

    process.env.EVAL_JUDGE_ALLOW_CI = '1';
    const outcome = await runLlmJudge(llmCase, { content: 'x' }, judgeChat);
    expect(outcome.skipped).toBe(false);
    expect(outcome.judgeModel).toBe('judge-1');
  });

  it('throws in real mode without EVAL_JUDGE_MODEL instead of silently skipping', async () => {
    const judgeChat = vi.fn().mockResolvedValue({ content: '{"score": 1, "passed": true}' });
    await expect(
      runLlmJudge(llmCase, { content: 'x' }, judgeChat, { mode: 'real' })
    ).rejects.toThrow(/EVAL_JUDGE_MODEL/);
  });

  it('warns when the judge model is the candidate (self-judging inflates scores)', async () => {
    process.env.EVAL_JUDGE_MODEL = 'candidate-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const judgeChat = vi.fn().mockResolvedValue({
      content: '{"score": 1, "passed": true, "rationale": "great"}',
    });
    const opts = { candidateModelId: 'candidate-1' };
    await runLlmJudge(llmCase, { content: 'x' }, judgeChat, opts);
    // Warn-once: a full run must not repeat the warning per case.
    await runLlmJudge(llmCase, { content: 'x' }, judgeChat, opts);
    const selfJudgeWarnings = warn.mock.calls.filter(([msg]) =>
      String(msg).includes('same as the candidate')
    );
    expect(selfJudgeWarnings).toHaveLength(1);
  });

  it('does not warn when judge and candidate differ', async () => {
    process.env.EVAL_JUDGE_MODEL = 'judge-1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const judgeChat = vi.fn().mockResolvedValue({
      content: '{"score": 1, "passed": true, "rationale": "great"}',
    });
    await runLlmJudge(llmCase, { content: 'x' }, judgeChat, { candidateModelId: 'candidate-9' });
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('same as the candidate'));
  });

  it('still skips a misconfigured case (no dimension), never failing it', async () => {
    const bad: EvalCase = { ...llmCase, judge: { kind: 'llm-judge' } };
    const outcome = await runLlmJudge(bad, { content: 'x' });
    expect(outcome.skipped).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runEval: zero skips in mock mode, verdicts never gate
// ---------------------------------------------------------------------------

describe('runEval judge wiring', () => {
  it('zero skips under the default mock mode; verdicts carry judgeModel + rubric version', async () => {
    const { results, summary } = await runEval([llmCase], mockChatFn([llmCase]), {
      modelId: 'm',
      modelVersion: 'v',
    });
    expect(summary.skipped).toBe(0);
    expect(summary.total).toBe(1);
    expect(summary.passed).toBe(1);
    const details = results[0]!.details as Record<string, unknown>;
    expect(details).toMatchObject({
      judge: 'llm-judge',
      judgeModel: MOCK_JUDGE_MODEL_ID,
      rubricVersion: '2026-09-v1',
    });
  });

  it('seed corpus: llm-judge cases run under mock (none skipped), deterministic cases unaffected', async () => {
    const { results, summary } = await runEval(EVAL_SEED_CORPUS, mockChatFn(EVAL_SEED_CORPUS), {
      modelId: 'm',
      modelVersion: 'v',
    });
    expect(results).toHaveLength(16);
    expect(summary.skipped).toBe(0);
    expect(summary.total).toBe(16);
    expect(summary.passed).toBe(16);
    expect(summary.failed).toBe(0);
    expect(summary.p0Failed).toEqual([]);
    const judged = results.filter((r) => !r.skipped && (r.details as { judge?: unknown }).judge === 'llm-judge');
    expect(judged.map((r) => r.caseId).sort()).toEqual(['seed-helpfulness-llm-016', 'seed-tone-llm-015']);
    // Deterministic dimension breakdown is unchanged by judge verdicts.
    expect(summary.byDimension['grounding-citations']).toEqual({ passed: 2, total: 2 });
    expect(summary.byDimension['helpfulness']).toEqual({ passed: 2, total: 2 });
  });

  it('judge verdicts never gate: a failing p0 llm-judge case is not in p0Failed', async () => {
    const p0JudgeCase: EvalCase = {
      ...llmCase,
      id: 'judge-p0-1',
      severity: 'p0',
      // Empty mock response fails the mock judge outright.
      mockResponse: '',
    };
    const { results, summary } = await runEval([p0JudgeCase], mockChatFn([p0JudgeCase]), {
      modelId: 'm',
      modelVersion: 'v',
    });
    expect(results[0]!.passed).toBe(false);
    expect(summary.failed).toBe(1);
    // ...but the failure is a measurement-instrument signal, not a gate.
    expect(summary.p0Failed).toEqual([]);
    expect(summary.byDimension['helpfulness']).toBeUndefined();
  });

  it('explicit skip mode restores the old skip behavior', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { summary } = await runEval([llmCase], mockChatFn([llmCase]), {
      modelId: 'm',
      modelVersion: 'v',
      judgeMode: 'skip',
    });
    expect(summary.skipped).toBe(1);
    expect(summary.total).toBe(0);
  });
});
