/**
 * runner.ts — executes an eval suite against a chat function.
 *
 * Two chat functions ship:
 *  - mockChatFn(cases): scripted. Returns each case's mockResponse. This is
 *    what CI uses — deterministic, no model, no GPU, no network.
 *  - gatewayChatFn(modelId, auth): the REAL AI gateway path (gatewayStream,
 *    non-streaming accumulation). Config-gated by EVAL_LIVE_PROVIDER: when
 *    unset, live mode is REFUSED with a clear error. Live results are never
 *    faked — if the provider is unreachable the case fails loudly.
 *
 * llm-judge cases run under one of three judge modes (resolveJudgeMode):
 *  - mock (default, CI-safe): the deterministic mockJudge.ts — scripted
 *    rules, verdicts labeled judgeModel 'mock-judge'. Zero skips in CI.
 *  - real: llmJudge.ts against the platform's own gateway pointed at
 *    EVAL_JUDGE_MODEL. NEVER RUNS IN CI — refused when CI=true unless
 *    EVAL_JUDGE_ALLOW_CI=1 is set explicitly.
 *  - skip: llm-judge cases are skipped (never failed), the pre-mock behavior.
 *    Only when explicitly requested via EVAL_JUDGE_MODE=skip / --judge-mode skip.
 *
 * Judge verdicts (mock or real) are measurement instruments with error bars:
 * they are recorded with judgeModel + rubricVersion, and they NEVER gate
 * promotion on their own — llm-judge results are excluded from p0Failed and
 * from the per-dimension aggregates that feed the promotion gate.
 *
 * Runs are sequential (deterministic case ordering, no provider stampede).
 */
import { randomUUID } from 'node:crypto';
import { judgeResponse } from './judges.js';
import { recordEvalRun } from '../observability/metrics.js';
import { evaluateWithMockJudge, MOCK_JUDGE_MODEL_ID } from './mockJudge.js';
import {
  defaultRubric,
  evaluateWithJudgeModel,
  type JudgeChatFn,
  type JudgeFn,
} from './llmJudge.js';
import type {
  EvalCase,
  EvalCaseResult,
  EvalCategory,
  EvalRunSummary,
  EvalToolDef,
  QualityDimension,
} from './types.js';

export interface RunnerMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatResult {
  content: string;
  toolCalls?: Array<{ name: string; args: unknown }>;
}

export type ChatFn = (
  messages: RunnerMessage[],
  tools?: EvalToolDef[]
) => Promise<ChatResult>;

export interface RunEvalOptions {
  modelId: string;
  modelVersion: string;
  categories?: EvalCategory[];
  severities?: Array<'p0' | 'p1' | 'p2'>;
  dimensions?: QualityDimension[];
  onCaseResult?: (result: EvalCaseResult) => void | Promise<void>;
  /**
   * Chat transport for the judge model. Only used for llm-judge cases in
   * real judge mode (EVAL_JUDGE_MODEL set); in mock mode the runner uses
   * the deterministic mock judge and needs no transport.
   */
  judgeChat?: JudgeChatFn;
  /**
   * Overrides EVAL_JUDGE_MODE resolution. The CLI sets this from
   * --judge-mode; the HTTP route leaves it unset (env-driven).
   */
  judgeMode?: JudgeMode;
  /**
   * Candidate model id, used only for the self-judging warning: when the
   * judge model equals the candidate, scores inflate and a warning is
   * logged. Never used for any security decision.
   */
  candidateModelId?: string;
}

/** Which judge scores llm-judge cases for this run. */
export type JudgeMode = 'mock' | 'real' | 'skip';

/**
 * Resolves the judge mode. An explicit value (CLI --judge-mode) wins;
 * otherwise EVAL_JUDGE_MODE is honored; when neither is set the mode is
 * 'real' iff EVAL_JUDGE_MODEL is configured, else 'mock'. 'skip' is never
 * the default — skipping llm-judge cases is always an explicit choice.
 */
export function resolveJudgeMode(explicit?: string): JudgeMode {
  const raw = (explicit ?? process.env.EVAL_JUDGE_MODE ?? '').trim().toLowerCase();
  if (raw === 'mock' || raw === 'real' || raw === 'skip') return raw;
  if (raw !== '') {
    throw new Error(
      `Invalid judge mode "${explicit ?? process.env.EVAL_JUDGE_MODE}": expected mock|real|skip`
    );
  }
  return process.env.EVAL_JUDGE_MODEL ? 'real' : 'mock';
}

/**
 * Enforces the NEVER-RUN-IN-CI policy for real-judge mode. Real judge calls
 * are live model calls with their own error bars; they must never run as
 * part of automated CI. The only override is the explicit
 * EVAL_JUDGE_ALLOW_CI=1 — a deliberate, auditable opt-in, not an accident.
 */
export function assertRealJudgeAllowed(): void {
  if (process.env.CI === 'true' && process.env.EVAL_JUDGE_ALLOW_CI !== '1') {
    throw new Error(
      'Real-judge mode refused: llm-judge verdicts NEVER RUN IN CI. ' +
        'Use EVAL_JUDGE_MODE=mock for the deterministic CI judge, or set ' +
        'EVAL_JUDGE_ALLOW_CI=1 to explicitly override (not recommended).'
    );
  }
}

/**
 * Self-judging inflates scores. Warn loudly, but only once per judge model
 * id per process — a 10-case run should not print the same warning 10 times.
 * The verdict is still recorded with the judge model id so the inflation
 * stays traceable. Exported for tests.
 */
const warnedSelfJudgeModels = new Set<string>();
export function warnSelfJudgeOnce(judgeModel: string, caseId: string): void {
  if (warnedSelfJudgeModels.has(judgeModel)) return;
  warnedSelfJudgeModels.add(judgeModel);
  console.warn(
    `[eval] WARNING: judge model "${judgeModel}" is the same as the candidate under eval ` +
      `(case ${caseId}). Self-judging inflates scores — use a different judge model.`
  );
}

export interface LlmJudgeOutcome {
  skipped: boolean;
  reason?: string;
  judgeModel?: string;
  rubricVersion?: string;
  passed?: boolean;
  score?: number;
  rationale?: string;
}

/**
 * Executes the llm-judge for one case, per the resolved judge mode:
 *
 *  - skip: the case is SKIPPED, never failed, and the reason is logged.
 *  - mock: the deterministic mockJudge.ts scores the response — the CI
 *    default, so llm-judge cases run (zero skips) without any model.
 *  - real: llmJudge.ts scores via the judge model over the provided
 *    judgeChat transport. Refused when CI=true unless EVAL_JUDGE_ALLOW_CI=1
 *    (NEVER RUN IN CI); refused without EVAL_JUDGE_MODEL; warns when the
 *    judge model equals the candidate (self-judging inflates scores).
 *
 * Deterministic judges run in CI and can gate promotion; llm-judge verdicts
 * (mock or real) never gate CI on their own — the caller excludes them from
 * p0Failed and from the promotion-gate dimension aggregates.
 */
export interface RunLlmJudgeOptions {
  /** Overrides EVAL_JUDGE_MODE resolution for this call. */
  mode?: JudgeMode;
  /** Candidate model id — only used for the self-judging warning. */
  candidateModelId?: string;
}

export async function runLlmJudge(
  c: EvalCase,
  response: ChatResult,
  judgeChat?: JudgeChatFn,
  options?: RunLlmJudgeOptions
): Promise<LlmJudgeOutcome> {
  const dimension = c.judge.dimension;
  if (!dimension) {
    return { skipped: true, reason: 'judge misconfigured: llm-judge requires a dimension; case skipped, not failed' };
  }
  const mode = options?.mode ?? resolveJudgeMode();
  if (mode === 'skip') {
    const reason =
      'EVAL_JUDGE_MODE=skip: llm-judge cases skipped by explicit request; case skipped, not failed';
    console.warn(`[eval] skipping llm-judge case ${c.id}: ${reason}`);
    return { skipped: true, reason };
  }

  const { rubric, version } =
    c.judge.rubric !== undefined ? { rubric: c.judge.rubric, version: 'custom' } : defaultRubric(dimension);
  const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
  const request = {
    dimension,
    rubric,
    rubricVersion: version,
    response: response.content,
    prompt: lastUser?.content,
    caseId: c.id,
  };

  let judge: JudgeFn;
  if (mode === 'mock') {
    // Deterministic CI path: no model, no network, verdicts labeled
    // 'mock-judge' so they can never be mistaken for model judgments.
    judge = evaluateWithMockJudge;
  } else {
    assertRealJudgeAllowed();
    const configured = process.env.EVAL_JUDGE_MODEL;
    if (!configured) {
      throw new Error(
        'EVAL_JUDGE_MODE=real requires EVAL_JUDGE_MODEL to be set to the judge model id'
      );
    }
    if (!judgeChat) {
      const reason =
        'judge model is configured but no judge chat transport was provided to the runner; case skipped, not failed';
      console.warn(`[eval] skipping llm-judge case ${c.id}: ${reason}`);
      return { skipped: true, reason, judgeModel: configured };
    }
    if (options?.candidateModelId && options.candidateModelId === configured) {
      warnSelfJudgeOnce(configured, c.id);
    }
    judge = (req) => evaluateWithJudgeModel(req, judgeChat, configured);
  }

  const verdict = await judge(request);
  return {
    skipped: false,
    judgeModel: verdict.judgeModel,
    rubricVersion: verdict.rubricVersion,
    passed: verdict.passed,
    score: verdict.score,
    rationale: verdict.rationale,
  };
}

/**
 * Scripted chat function for CI: returns each case's mockResponse, matched
 * by the case's last user message. Cases without a mockResponse, or a
 * message that matches no case, FAIL LOUDLY — a scripted run must never
 * silently invent a response.
 */
export function mockChatFn(cases: EvalCase[]): ChatFn {
  const byUserMessage = new Map<string, EvalCase>();
  for (const c of cases) {
    const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
    if (lastUser) byUserMessage.set(lastUser.content, c);
  }
  return async (messages: RunnerMessage[]): Promise<ChatResult> => {
    const lastUser = [...messages].reverse().find((m) => m.role === 'user');
    const c = lastUser ? byUserMessage.get(lastUser.content) : undefined;
    if (!c) {
      throw new Error(
        'mockChatFn: no eval case matches the given messages; scripted runs cannot invent responses'
      );
    }
    if (c.mockResponse === undefined) {
      throw new Error(`mockChatFn: case ${c.id} has no mockResponse; scripted runs cannot invent responses`);
    }
    const mock = c.mockResponse;
    if (typeof mock === 'string') return { content: mock };
    return { content: mock.content ?? '', toolCalls: mock.toolCalls };
  };
}

/**
 * Live adapter: see live.ts (gatewayChatFn). Kept out of this module so the
 * mock/CI path never imports the gateway or the database config.
 */

export async function runEval(
  cases: EvalCase[],
  chatFn: ChatFn,
  opts: RunEvalOptions
): Promise<{ results: EvalCaseResult[]; summary: EvalRunSummary }> {
  const runId = randomUUID();
  const runStart = Date.now();
  const judgeMode = opts.judgeMode ?? resolveJudgeMode();
  const filtered = cases.filter(
    (c) =>
      (!opts.categories || opts.categories.includes(c.category)) &&
      (!opts.severities || opts.severities.includes(c.severity)) &&
      (!opts.dimensions || (c.dimensions ?? []).some((d) => opts.dimensions!.includes(d)))
  );
  const dimensionsByCase = new Map(cases.map((c) => [c.id, c.dimensions ?? []]));

  const results: EvalCaseResult[] = [];
  for (const c of filtered) {
    const started = Date.now();
    let result: EvalCaseResult;
    try {
      const response = await chatFn(c.messages, c.tools);
      if (c.judge.kind === 'llm-judge') {
        const outcome = await runLlmJudge(c, response, opts.judgeChat, {
          mode: judgeMode,
          candidateModelId: opts.candidateModelId,
        });
        result = {
          caseId: c.id,
          category: c.category,
          severity: c.severity,
          passed: outcome.skipped ? false : outcome.passed === true,
          score: outcome.skipped ? 0 : (outcome.score ?? 0),
          skipped: outcome.skipped ? true : undefined,
          details: {
            judge: 'llm-judge',
            dimension: c.judge.dimension,
            skipped: outcome.skipped,
            reason: outcome.reason,
            judgeModel: outcome.judgeModel,
            rubricVersion: outcome.rubricVersion,
            score: outcome.score,
            rationale: outcome.rationale,
          },
          latencyMs: Date.now() - started,
        };
      } else {
        const verdict = judgeResponse(
          c.judge,
          { content: response.content, toolCalls: response.toolCalls },
          c.ragContext ?? []
        );
        result = {
          caseId: c.id,
          category: c.category,
          severity: c.severity,
          passed: verdict.passed,
          score: verdict.score,
          details: { judge: c.judge.kind, ...((verdict.details ?? {}) as Record<string, unknown>) },
          latencyMs: Date.now() - started,
        };
      }
    } catch (error) {
      // A chatFn that throws (network, provider, mock mismatch) is a case
      // failure, never a silent skip.
      result = {
        caseId: c.id,
        category: c.category,
        severity: c.severity,
        passed: false,
        score: 0,
        details: {
          judge: c.judge.kind,
          reason: 'chatFn threw',
          error: error instanceof Error ? error.message : String(error),
        },
        latencyMs: Date.now() - started,
      };
    }
    results.push(result);
    await opts.onCaseResult?.(result);
  }

  // Skipped cases (llm-judge in skip mode) are reported but excluded from
  // every aggregate: they ran nothing, so they prove nothing. llm-judge
  // verdicts that DID run (mock or real) count in the totals and the
  // per-category table, but are excluded from p0Failed and byDimension:
  // they are measurement instruments with error bars and never gate
  // promotion on their own.
  const executed = results.filter((r) => !r.skipped);
  const byCategory: Record<string, { passed: number; total: number }> = {};
  const byDimension: Record<string, { passed: number; total: number }> = {};
  let passed = 0;
  let skipped = 0;
  const p0Failed: string[] = [];
  for (const r of results) {
    if (r.skipped) {
      skipped += 1;
      continue;
    }
    const isJudgeVerdict =
      typeof r.details === 'object' &&
      r.details !== null &&
      (r.details as { judge?: unknown }).judge === 'llm-judge';
    const bucket = (byCategory[r.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (r.passed) {
      passed += 1;
      bucket.passed += 1;
    } else if (r.severity === 'p0' && !isJudgeVerdict) {
      p0Failed.push(r.caseId);
    }
    if (!isJudgeVerdict) {
      for (const dimension of dimensionsByCase.get(r.caseId) ?? []) {
        const dbucket = (byDimension[dimension] ??= { passed: 0, total: 0 });
        dbucket.total += 1;
        if (r.passed) dbucket.passed += 1;
      }
    }
  }

  const summary: EvalRunSummary = {
    runId,
    modelId: opts.modelId,
    modelVersion: opts.modelVersion,
    total: executed.length,
    passed,
    failed: executed.length - passed,
    byCategory,
    p0Failed,
    byDimension,
    skipped,
  };
  // Domain RED metric for eval runs: a failed P0 gate is an 'error'-grade
  // signal for operators watching the promotion pipeline.
  recordEvalRun(
    p0Failed.length > 0 ? 'error' : summary.failed > 0 ? 'failed' : 'passed',
    (Date.now() - runStart) / 1000
  );
  return { results, summary };
}
