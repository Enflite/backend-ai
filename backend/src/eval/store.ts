/**
 * store.ts — persistence for eval runs and case results.
 *
 * Platform-level tables (eval_runs, eval_case_results): no tenant_id, like
 * `models`. All access goes through the raw query() helper, which is why
 * this file is on the RAW_QUERY_ALLOWLIST in
 * backend/test/rlsEnforcement.test.ts (with justification). It never touches
 * tenant tables.
 */
import { query } from '../db/pool.js';
import type { EvalCaseResult, EvalRunSummary } from './types.js';

export interface EvalRunRow {
  id: string;
  model_id: string;
  model_version: string;
  provider: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  summary: EvalRunSummary;
  created_at: Date;
  created_by: string | null;
}

export interface EvalCaseResultRow {
  id: string;
  run_id: string;
  case_id: string;
  category: string;
  severity: string;
  passed: boolean;
  score: number;
  details: unknown;
  latency_ms: number;
}

export async function createRun(input: {
  modelId: string;
  modelVersion: string;
  provider: string;
  createdBy: string | null;
}): Promise<string> {
  const rows = (
    await query<{ id: string }>(
      `INSERT INTO eval_runs (model_id, model_version, provider, status, created_by)
       VALUES ($1, $2, $3, 'running', $4) RETURNING id`,
      [input.modelId, input.modelVersion, input.provider, input.createdBy]
    )
  ).rows;
  return rows[0]!.id;
}

export async function saveCaseResult(runId: string, result: EvalCaseResult): Promise<void> {
  await query(
    `INSERT INTO eval_case_results
       (run_id, case_id, category, severity, passed, score, details, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`,
    [
      runId,
      result.caseId,
      result.category,
      result.severity,
      result.passed,
      result.score,
      JSON.stringify(result.details ?? {}),
      result.latencyMs,
    ]
  );
}

export async function finishRun(runId: string, summary: EvalRunSummary): Promise<void> {
  await query(
    `UPDATE eval_runs
     SET status = 'completed', total = $2, passed = $3, failed = $4, summary = $5::jsonb
     WHERE id = $1`,
    [runId, summary.total, summary.passed, summary.failed, JSON.stringify(summary)]
  );
}

export async function failRun(runId: string, reason: string): Promise<void> {
  await query(`UPDATE eval_runs SET status = 'failed', summary = $2::jsonb WHERE id = $1`, [
    runId,
    JSON.stringify({ reason }),
  ]);
}

export async function getRun(runId: string): Promise<{ run: EvalRunRow; results: EvalCaseResultRow[] } | null> {
  const runRows = (await query<EvalRunRow>(`SELECT * FROM eval_runs WHERE id = $1`, [runId])).rows;
  const run = runRows[0];
  if (!run) return null;
  const results = (
    await query<EvalCaseResultRow>(
      `SELECT * FROM eval_case_results WHERE run_id = $1 ORDER BY case_id ASC`,
      [runId]
    )
  ).rows;
  return { run, results };
}

export async function listRuns(modelId: string, limit = 50): Promise<EvalRunRow[]> {
  return (
    await query<EvalRunRow>(
      `SELECT * FROM eval_runs WHERE model_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [modelId, limit]
    )
  ).rows;
}

export async function getModelVersion(modelId: string): Promise<string | null> {
  const rows = (await query<{ version: string }>(`SELECT version FROM models WHERE id = $1`, [modelId])).rows;
  return rows[0]?.version ?? null;
}

export async function getLatestRunForVersion(
  modelId: string,
  modelVersion: string
): Promise<EvalRunRow | null> {
  const rows = (
    await query<EvalRunRow>(
      `SELECT * FROM eval_runs
       WHERE model_id = $1 AND model_version = $2
       ORDER BY created_at DESC LIMIT 1`,
      [modelId, modelVersion]
    )
  ).rows;
  return rows[0] ?? null;
}

export async function getP0Failures(runId: string): Promise<string[]> {
  const rows = (
    await query<{ case_id: string }>(
      `SELECT case_id FROM eval_case_results
       WHERE run_id = $1 AND severity = 'p0' AND passed = false
       ORDER BY case_id ASC`,
      [runId]
    )
  ).rows;
  return rows.map((r) => r.case_id);
}

export interface RunComparison {
  runA: string;
  runB: string;
  byCategory: Record<string, { passedA: number; passedB: number; totalA: number; totalB: number; delta: number }>;
  /** Cases passing in A but failing in B — regressions. */
  regressions: string[];
  /** Cases failing in A but passing in B — improvements. */
  improvements: string[];
  passedA: number;
  passedB: number;
  totalA: number;
  totalB: number;
}

/**
 * Compare two runs: per-category pass deltas plus the regression list
 * (cases that passed in A but fail in B). Used by GET /admin/eval/compare
 * and by the promotion workflow.
 */
export async function compareRuns(runA: string, runB: string): Promise<RunComparison | null> {
  const [a, b] = await Promise.all([getRun(runA), getRun(runB)]);
  if (!a || !b) return null;

  const verdictA = new Map(a.results.map((r) => [r.case_id, r.passed]));
  const verdictB = new Map(b.results.map((r) => [r.case_id, r.passed]));
  const allCaseIds = new Set([...verdictA.keys(), ...verdictB.keys()]);

  const regressions: string[] = [];
  const improvements: string[] = [];
  for (const caseId of allCaseIds) {
    const pa = verdictA.get(caseId);
    const pb = verdictB.get(caseId);
    if (pa === true && pb === false) regressions.push(caseId);
    if (pa === false && pb === true) improvements.push(caseId);
  }
  regressions.sort();
  improvements.sort();

  const byCategory: RunComparison['byCategory'] = {};
  const categories = new Set([...a.results.map((r) => r.category), ...b.results.map((r) => r.category)]);
  for (const category of categories) {
    const ra = a.results.filter((r) => r.category === category);
    const rb = b.results.filter((r) => r.category === category);
    const passedA = ra.filter((r) => r.passed).length;
    const passedB = rb.filter((r) => r.passed).length;
    byCategory[category] = {
      passedA,
      passedB,
      totalA: ra.length,
      totalB: rb.length,
      delta: passedB - passedA,
    };
  }

  return {
    runA,
    runB,
    byCategory,
    regressions,
    improvements,
    passedA: a.run.passed,
    passedB: b.run.passed,
    totalA: a.run.total,
    totalB: b.run.total,
  };
}
