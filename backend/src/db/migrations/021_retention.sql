-- 021_retention.sql — data retention and legal hold (Phase 5c).
--
-- retention_policies: per-tenant overrides for the global
-- RETENTION_*_DAYS config. A NULL column falls back to the global default;
-- NULL/0 at the effective level disables purging for that table (keep
-- forever). Only one row per tenant.
--
-- legal_hold: when true, the row (and, for conversations, its messages) is
-- exempt from purging. Set/cleared through the retention API by holders of
-- the retention:manage permission; audited as LEGAL_HOLD_SET/CLEARED.

CREATE TABLE IF NOT EXISTS retention_policies (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  conversations_days INTEGER NULL CHECK (conversations_days IS NULL OR conversations_days >= 0),
  messages_days INTEGER NULL CHECK (messages_days IS NULL OR messages_days >= 0),
  audit_events_days INTEGER NULL CHECK (audit_events_days IS NULL OR audit_events_days >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS legal_hold BOOLEAN NOT NULL DEFAULT false;

-- Purge scans: expired rows per tenant excluding legal holds.
CREATE INDEX IF NOT EXISTS idx_conversations_retention_purge
  ON conversations (tenant_id, updated_at) WHERE legal_hold = false;
CREATE INDEX IF NOT EXISTS idx_messages_retention_purge
  ON messages (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_events_retention_purge
  ON audit_events (tenant_id, created_at) WHERE legal_hold = false;

-- RLS defense in depth, following the 003/004 tenant_isolation pattern.
-- RLS is (re)asserted unconditionally; only the policy creation is
-- conditional, so a half-applied state cannot leave the table unprotected.
ALTER TABLE retention_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_policies FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename = 'retention_policies') THEN
    EXECUTE 'CREATE POLICY tenant_isolation ON retention_policies USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)';
  END IF;
END $$;
