-- 025_capability_routing_rls.sql — Phase 6: RLS defense in depth for
-- model_routing_policies (created in 024).
--
-- Follows the 003/004 tenant_isolation pattern (see 021_retention.sql):
-- ENABLE + FORCE ROW LEVEL SECURITY, with the tenant_isolation policy
-- reading app.tenant_id. Application queries go through tenantQuery() and
-- are already scoped by tenant_id in SQL; RLS is the second layer so a
-- missing WHERE clause cannot leak one tenant's routing policy to another.
-- Idempotent: RLS is (re)asserted unconditionally; only the policy creation
-- is conditional.

ALTER TABLE model_routing_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE model_routing_policies FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'tenant_isolation' AND tablename = 'model_routing_policies'
  ) THEN
    EXECUTE 'CREATE POLICY tenant_isolation ON model_routing_policies USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)';
  END IF;
END $$;
