-- 016_eval_results.sql
--
-- Platform-level tables for the automated AI evaluation framework
-- (backend/src/eval/*). Like `models`, these carry no tenant_id: eval runs
-- are an admin activity (gated by `model:manage`), not tenant data, so they
-- are intentionally outside the RLS tenant policies. See the justification
-- comment on the RAW_QUERY_ALLOWLIST entry for eval/store.ts in
-- backend/test/rlsEnforcement.test.ts.

CREATE TABLE eval_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id UUID NOT NULL REFERENCES models(id),
  model_version TEXT NOT NULL,
  provider TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  total INTEGER NOT NULL DEFAULT 0,
  passed INTEGER NOT NULL DEFAULT 0,
  failed INTEGER NOT NULL DEFAULT 0,
  summary JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES users(id)
);

CREATE TABLE eval_case_results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES eval_runs(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  category TEXT NOT NULL,
  severity TEXT NOT NULL,
  passed BOOLEAN NOT NULL,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  details JSONB NOT NULL DEFAULT '{}',
  latency_ms INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX idx_eval_runs_model ON eval_runs(model_id, created_at DESC);
CREATE INDEX idx_eval_case_results_run ON eval_case_results(run_id);
