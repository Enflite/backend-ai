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
 * Runs are sequential (deterministic case ordering, no provider stampede).
 */
import { randomUUID } from 'node:crypto';
import { judgeResponse } from './judges.js';
import { recordEvalRun } from '../observability/metrics.js';
import {
  defaultRubric,
  evaluateWithJudgeModel,
  type JudgeChatFn,
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
   * Chat transport for the judge model. Only used for llm-judge cases when
   * EVAL_JUDGE_MODEL is configured; when absent (CI, mock CLI runs) those
   * cases are skipped.
   */
  judgeChat?: JudgeChatFn;
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
 * Executes the llm-judge for one case. This is a deliberate stub at the
 * runner level: when no judge model is configured (EVAL_JUDGE_MODEL unset —
 * always the case in CI) the case is SKIPPED, never failed, and the reason
 * is logged. Deterministic judges run in CI and can gate promotion;
 * llm-judge cases never gate CI on their own.
 */
export async function runLlmJudge(
  c: EvalCase,
  response: ChatResult,
  judgeChat?: JudgeChatFn
): Promise<LlmJudgeOutcome> {
  const dimension = c.judge.dimension;
  if (!dimension) {
    return { skipped: true, reason: 'judge misconfigured: llm-judge requires a dimension; case skipped, not failed' };
  }
  const judgeModel = process.env.EVAL_JUDGE_MODEL;
  if (!judgeModel) {
    const reason =
      'EVAL_JUDGE_MODEL is not configured — llm-judge cases require a judge model and never run in CI; case skipped, not failed';
    console.warn(`[eval] skipping llm-judge case ${c.id}: ${reason}`);
    return { skipped: true, reason };
  }
  if (!judgeChat) {
    const reason =
      'judge model is configured but no judge chat transport was provided to the runner; case skipped, not failed';
    console.warn(`[eval] skipping llm-judge case ${c.id}: ${reason}`);
    return { skipped: true, reason, judgeModel };
  }
  const { rubric, version } =
    c.judge.rubric !== undefined ? { rubric: c.judge.rubric, version: 'custom' } : defaultRubric(dimension);
  const lastUser = [...c.messages].reverse().find((m) => m.role === 'user');
  const verdict = await evaluateWithJudgeModel(
    {
      dimension,
      rubric,
      rubricVersion: version,
      response: response.content,
      prompt: lastUser?.content,
      caseId: c.id,
    },
    judgeChat,
    judgeModel
  );
  return {
    skipped: false,
    judgeModel,
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
        const outcome = await runLlmJudge(c, response, opts.judgeChat);
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

  // Skipped cases (llm-judge without a judge model) are reported but excluded
  // from every aggregate: they ran nothing, so they prove nothing.
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
    const bucket = (byCategory[r.category] ??= { passed: 0, total: 0 });
    bucket.total += 1;
    if (r.passed) {
      passed += 1;
      bucket.passed += 1;
    } else if (r.severity === 'p0') {
      p0Failed.push(r.caseId);
    }
    for (const dimension of dimensionsByCase.get(r.caseId) ?? []) {
      const dbucket = (byDimension[dimension] ??= { passed: 0, total: 0 });
      dbucket.total += 1;
      if (r.passed) dbucket.passed += 1;
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
