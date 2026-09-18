-- 017_model_lifecycle.sql: model approval/promotion lifecycle.
--
-- Lifecycle states:
--   REGISTERED -> DOWNLOADING -> VALIDATING -> EVALUATING
--     -> PENDING_APPROVAL -> APPROVED -> CANARY -> ACTIVE
--     -> DEPRECATED -> RETIRED
--   DISABLED is an admin kill-switch reachable from ACTIVE/CANARY/DEPRECATED
--   (and can return to ACTIVE); RETIRED is terminal.
--
-- Only ACTIVE and CANARY models are servable by the AI Gateway. APPROVED
-- means "passed evaluation and is cleared for activation" but serves no
-- traffic until explicitly activated. The gateway's model registry filters
-- on the servable set; see backend/src/ai/gateway/modelRegistry.ts.
--
-- Legacy status mapping (from 001_init.sql):
--   UNVERIFIED -> REGISTERED, TESTING -> EVALUATING, APPROVED -> ACTIVE
--   (existing approved models keep serving), DISABLED -> DISABLED,
--   RETIRED -> RETIRED.

-- The legacy check constraint (auto-named models_status_check by 001_init.sql)
-- must be dropped BEFORE the status remap below: the new lifecycle states
-- ('REGISTERED', 'ACTIVE', ...) are not in the legacy list, so the UPDATEs
-- would violate the old constraint on any database (fresh or upgraded).
-- 017 never succeeded anywhere in its previous ordering (migrations are
-- transactional, so the failed file was never recorded), making this
-- reorder safe to apply in place.
ALTER TABLE models DROP CONSTRAINT IF EXISTS models_status_check;

UPDATE models SET status = 'REGISTERED' WHERE status = 'UNVERIFIED';
UPDATE models SET status = 'EVALUATING' WHERE status = 'TESTING';
UPDATE models SET status = 'ACTIVE' WHERE status = 'APPROVED';

ALTER TABLE models ADD CONSTRAINT models_status_check CHECK (status IN (
  'REGISTERED', 'DOWNLOADING', 'VALIDATING', 'EVALUATING', 'PENDING_APPROVAL',
  'APPROVED', 'CANARY', 'ACTIVE', 'DEPRECATED', 'DISABLED', 'RETIRED'
)) NOT VALID;

-- Promotion bookkeeping. approved_by/approved_at are set on the
-- PENDING_APPROVAL -> APPROVED transition (which requires the Phase 2 eval
-- promotion gate to pass); last_eval_run_id points at the eval run that
-- cleared the gate.
ALTER TABLE models ADD COLUMN IF NOT EXISTS lifecycle_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE models ADD COLUMN IF NOT EXISTS approved_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE models ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ;
ALTER TABLE models ADD COLUMN IF NOT EXISTS last_eval_run_id UUID REFERENCES eval_runs(id) ON DELETE SET NULL;

-- Admin-controlled serving defaults: which model serves a tenant+capability.
-- The gateway resolves these when the caller does not pick a model.
-- capability is a free-form slot name (e.g. 'chat', 'syteline', 'coding');
-- the set of meaningful capabilities is documented in docs/inference.md.
CREATE TABLE IF NOT EXISTS model_serving_defaults (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability <> ''),
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_models_lifecycle_status ON models(status) WHERE status IN ('ACTIVE', 'CANARY');
