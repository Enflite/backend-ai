/**
 * store.ts — persistence for eval runs and case results.
 *
 * Platform-level collections (eval_runs, eval_case_results): no tenantId,
 * like `models`. All access goes through getDb() directly — never through
 * tenant-scoped helpers. It never touches tenant collections.
 *
 * Storage note: MongoDB documents use camelCase fields with the UUID in
 * `_id` (ADR-014). The public EvalRunRow/EvalCaseResultRow interfaces keep
 * their original snake_case shape so existing consumers (compare.ts) are
 * unaffected; the to* mappers convert between the two.
 */
import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo.js';
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

/** MongoDB document shape for the `eval_runs` collection (ADR-014). */
interface EvalRunRowDoc {
  _id: string;
  modelId: string;
  modelVersion: string;
  provider: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  summary: EvalRunSummary;
  createdAt: Date;
  createdBy: string | null;
}

function toEvalRunRow(doc: EvalRunRowDoc): EvalRunRow {
  return {
    id: doc._id,
    model_id: doc.modelId,
    model_version: doc.modelVersion,
    provider: doc.provider,
    status: doc.status,
    total: doc.total,
    passed: doc.passed,
    failed: doc.failed,
    summary: doc.summary,
    created_at: doc.createdAt,
    created_by: doc.createdBy,
  };
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

/** MongoDB document shape for the `eval_case_results` collection. */
interface EvalCaseResultRowDoc {
  _id: string;
  runId: string;
  caseId: string;
  category: string;
  severity: string;
  passed: boolean;
  score: number;
  details: unknown;
  latencyMs: number;
}

function toEvalCaseResultRow(doc: EvalCaseResultRowDoc): EvalCaseResultRow {
  return {
    id: doc._id,
    run_id: doc.runId,
    case_id: doc.caseId,
    category: doc.category,
    severity: doc.severity,
    passed: doc.passed,
    score: doc.score,
    details: doc.details,
    latency_ms: doc.latencyMs,
  };
}

/** Initial summary for a run that has not executed any cases yet. */
function emptySummary(runId: string, modelId: string, modelVersion: string): EvalRunSummary {
  return {
    runId,
    modelId,
    modelVersion,
    total: 0,
    passed: 0,
    failed: 0,
    byCategory: {},
    p0Failed: [],
    byDimension: {},
    skipped: 0,
  };
}

export async function createRun(input: {
  modelId: string;
  modelVersion: string;
  provider: string;
  createdBy: string | null;
}): Promise<string> {
  const db = await getDb();
  const id = randomUUID();
  const doc: EvalRunRowDoc = {
    _id: id,
    modelId: input.modelId,
    modelVersion: input.modelVersion,
    provider: input.provider,
    status: 'running',
    total: 0,
    passed: 0,
    failed: 0,
    summary: emptySummary(id, input.modelId, input.modelVersion),
    createdAt: new Date(),
    createdBy: input.createdBy,
  };
  await db.collection<EvalRunRowDoc>('eval_runs').insertOne(doc);
  return id;
}

export async function saveCaseResult(runId: string, result: EvalCaseResult): Promise<void> {
  const db = await getDb();
  await db.collection<EvalCaseResultRowDoc>('eval_case_results').insertOne({
    _id: randomUUID(),
    runId,
    caseId: result.caseId,
    category: result.category,
    severity: result.severity,
    passed: result.passed,
    score: result.score,
    details: result.details ?? {},
    latencyMs: result.latencyMs,
  });
}

export async function finishRun(runId: string, summary: EvalRunSummary): Promise<void> {
  const db = await getDb();
  await db.collection<EvalRunRowDoc>('eval_runs').updateOne(
    { _id: runId },
    {
      $set: {
        status: 'completed',
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        summary,
      },
    }
  );
}

export async function failRun(runId: string, reason: string): Promise<void> {
  const db = await getDb();
  await db.collection<EvalRunRowDoc>('eval_runs').updateOne(
    { _id: runId },
    {
      $set: {
        status: 'failed',
        // The failure reason is not part of EvalRunSummary; it is stored as
        // an extra property (tolerated by compare.ts's Partial cast),
        // preserving the PostgreSQL behavior of summary = '{"reason": ...}'.
        summary: { reason } as unknown as EvalRunSummary,
      },
    }
  );
}

export async function getRun(runId: string): Promise<{ run: EvalRunRow; results: EvalCaseResultRow[] } | null> {
  const db = await getDb();
  const runDoc = await db.collection<EvalRunRowDoc>('eval_runs').findOne({ _id: runId });
  if (!runDoc) return null;
  const resultDocs = await db
    .collection<EvalCaseResultRowDoc>('eval_case_results')
    .find({ runId })
    .sort({ caseId: 1 })
    .toArray();
  return { run: toEvalRunRow(runDoc), results: resultDocs.map(toEvalCaseResultRow) };
}

export async function listRuns(modelId: string, limit = 50): Promise<EvalRunRow[]> {
  const db = await getDb();
  const docs = await db
    .collection<EvalRunRowDoc>('eval_runs')
    .find({ modelId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .toArray();
  return docs.map(toEvalRunRow);
}

export async function getModelVersion(modelId: string): Promise<string | null> {
  const db = await getDb();
  const model = await db
    .collection<{ _id: string; version: string }>('models')
    .findOne({ _id: modelId }, { projection: { version: 1 } });
  return model?.version ?? null;
}

export async function getLatestRunForVersion(
  modelId: string,
  modelVersion: string
): Promise<EvalRunRow | null> {
  const db = await getDb();
  const doc = await db
    .collection<EvalRunRowDoc>('eval_runs')
    .find({ modelId, modelVersion })
    .sort({ createdAt: -1 })
    .limit(1)
    .next();
  return doc ? toEvalRunRow(doc) : null;
}

export async function getP0Failures(runId: string): Promise<string[]> {
  // llm-judge verdicts (details.judge = 'llm-judge') never gate promotion on
  // their own — they are measurement instruments with error bars — so they
  // are excluded here even when they ran (mock or real judge mode).
  //
  // MongoDB $ne matches documents where the field is missing entirely,
  // which is exactly the PostgreSQL `IS DISTINCT FROM` semantics being
  // replaced (a missing details.judge is distinct from 'llm-judge').
  const db = await getDb();
  const rows = await db
    .collection<EvalCaseResultRowDoc>('eval_case_results')
    .find(
      {
        runId,
        severity: 'p0',
        passed: false,
        'details.judge': { $ne: 'llm-judge' },
      },
      { projection: { caseId: 1 } }
    )
    .sort({ caseId: 1 })
    .toArray();
  return rows.map((r) => r.caseId);
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
