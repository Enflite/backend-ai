/**
 * compare.ts — promotion gate for model lifecycle.
 *
 * A model version is eligible for promotion only if:
 *  1. it has a completed eval run for its CURRENT version, and
 *  2. that run has zero p0 failures (among cases that actually ran), and
 *  3. it did not regress vs the previous completed run on the charter's
 *     grounding/honesty dimensions ('grounding-citations',
 *     'honesty-calibration') — charter §5: "a candidate that regresses on
 *     grounding or honesty cannot be auto-promoted".
 *
 * Skipped cases (llm-judge without a judge model) never block promotion:
 * they ran nothing, so they prove nothing.
 *
 * Phase 3's lifecycle transitions will call getPromotionGate() before
 * moving a model to APPROVED.
 */
import {
  getLatestRunForVersion,
  getModelVersion,
  getP0Failures,
  listRuns,
  type EvalRunRow,
} from './store.js';
import type { EvalRunSummary } from './types.js';

/** Charter dimensions whose regression blocks auto-promotion. */
export const PROMOTION_GUARDED_DIMENSIONS = ['grounding-citations', 'honesty-calibration'] as const;

export interface DimensionRegression {
  dimension: string;
  previous: number;
  current: number;
}

export interface PromotionGateResult {
  eligible: boolean;
  latestRunId: string | null;
  p0Failing: string[];
  reason: string;
  dimensionRegressions?: DimensionRegression[];
}

function summaryOf(run: EvalRunRow): EvalRunSummary {
  const s = (run.summary ?? {}) as Partial<EvalRunSummary>;
  return {
    runId: run.id,
    modelId: run.model_id,
    modelVersion: run.model_version,
    total: s.total ?? 0,
    passed: s.passed ?? 0,
    failed: s.failed ?? 0,
    byCategory: s.byCategory ?? {},
    p0Failed: s.p0Failed ?? [],
    byDimension: s.byDimension ?? {},
    skipped: s.skipped ?? 0,
  };
}

function passRate(bucket: { passed: number; total: number } | undefined): number | null {
  if (!bucket || bucket.total === 0) return null;
  return bucket.passed / bucket.total;
}

/**
 * Compare the latest run's per-dimension pass rates against the previous
 * completed run for the model. Returns regressions on the guarded
 * dimensions only.
 */
export function dimensionRegressions(
  latest: EvalRunSummary,
  previous: EvalRunSummary | null
): DimensionRegression[] {
  if (!previous) return [];
  const out: DimensionRegression[] = [];
  for (const dimension of PROMOTION_GUARDED_DIMENSIONS) {
    const cur = passRate(latest.byDimension[dimension]);
    const prev = passRate(previous.byDimension[dimension]);
    if (cur === null || prev === null) continue;
    if (cur < prev) out.push({ dimension, previous: prev, current: cur });
  }
  return out;
}

export async function getPromotionGate(modelId: string): Promise<PromotionGateResult> {
  const version = await getModelVersion(modelId);
  if (!version) {
    return { eligible: false, latestRunId: null, p0Failing: [], reason: 'model not found' };
  }
  const latest = await getLatestRunForVersion(modelId, version);
  if (!latest) {
    return {
      eligible: false,
      latestRunId: null,
      p0Failing: [],
      reason: `no eval run found for model version ${version}`,
    };
  }
  if (latest.status !== 'completed') {
    return {
      eligible: false,
      latestRunId: latest.id,
      p0Failing: [],
      reason: `latest eval run for version ${version} is not completed (status: ${latest.status})`,
    };
  }

  const p0Failing = await getP0Failures(latest.id);
  if (p0Failing.length > 0) {
    return {
      eligible: false,
      latestRunId: latest.id,
      p0Failing,
      reason: `${p0Failing.length} p0 case(s) failing in the latest run for version ${version}`,
    };
  }

  // Grounding/honesty regression check against the previous completed run.
  const runs = await listRuns(modelId, 10);
  const previous = runs.find((r) => r.id !== latest.id && r.status === 'completed') ?? null;
  const regressions = dimensionRegressions(summaryOf(latest), previous ? summaryOf(previous) : null);
  if (regressions.length > 0) {
    const detail = regressions
      .map(
        (r) =>
          `${r.dimension}: ${(r.previous * 100).toFixed(1)}% -> ${(r.current * 100).toFixed(1)}% pass rate`
      )
      .join('; ');
    return {
      eligible: false,
      latestRunId: latest.id,
      p0Failing: [],
      reason: `quality regression on guarded dimension(s) vs previous run: ${detail}`,
      dimensionRegressions: regressions,
    };
  }

  return {
    eligible: true,
    latestRunId: latest.id,
    p0Failing: [],
    reason: `latest run for version ${version} is clean: 0 p0 failures, no grounding/honesty regression`,
  };
}
