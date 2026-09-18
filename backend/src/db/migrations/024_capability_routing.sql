-- 024_capability_routing.sql — Phase 6: admin-configurable capability routing policy.
--
-- model_routing_policies records, per tenant+capability, HOW the capability
-- router should choose and fall back:
--   strategy        — the tenant's declared routing intent for this capability:
--                      'quality' (prefer the best-scoring model), 'latency'
--                      (prefer the fastest), or 'cost' (prefer the cheapest).
--                      The strategy is recorded at decision time (MODEL_USED /
--                      MODEL_CAPABILITY_FALLBACK audit metadata) so operators
--                      can segment telemetry by intent; the actual model bound
--                      to a capability remains the admin-configured serving
--                      default, chosen with eval scores and TTFT telemetry in
--                      hand (see docs/capabilities.md §1 — the strategy is a
--                      declared intent, not an automatic optimizer).
--   fallback_to_chat — when the capability's serving default is missing,
--                      stale, or fails authorization, fall back to the tenant's
--                      chat default instead of failing the turn. Audited as
--                      MODEL_CAPABILITY_FALLBACK. When false, a missing
--                      capability model fails the turn closed (NO_APPROVED_MODEL).
--
-- Rows are optional: a missing row means the platform default
-- (strategy='quality', fallback_to_chat=true).

CREATE TABLE IF NOT EXISTS model_routing_policies (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  capability TEXT NOT NULL CHECK (capability <> ''),
  strategy TEXT NOT NULL DEFAULT 'quality'
    CHECK (strategy IN ('quality', 'latency', 'cost')),
  fallback_to_chat BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, capability)
);

CREATE INDEX IF NOT EXISTS idx_model_routing_policies_tenant
  ON model_routing_policies(tenant_id);
