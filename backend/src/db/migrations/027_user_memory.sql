-- 027_user_memory.sql — Tenant-scoped user memory (`memory_facts`).
--
-- Long-lived facts/preferences the assistant remembers about a user across
-- conversations (e.g. "prefers concise summaries", "works on Project
-- Falcon"). Facts are strictly user-private: every row carries tenant_id +
-- user_id, every query is scoped by both, and RLS with the
-- tenant_isolation policy (following the 021/025 pattern) is the second
-- layer so a missing WHERE clause cannot leak one tenant's memories to
-- another. RLS is (re)asserted unconditionally; only the policy creation is
-- conditional, so the migration is idempotent on re-run.
--
-- Access control summary:
--   * CRUD is user-scoped: a user can only ever see or touch their own rows
--     (tenant_id = caller's tenant AND user_id = caller's user).
--   * Classification on write may not exceed the caller's clearance
--     (assertClassificationAllowed, like conversations).
--   * Prompt injection filters facts so a fact's classification never exceeds
--     the turn's request classification; UNKNOWN fails closed.
--   * No role — including Security Admin — is granted another user's
--     memories; the grants below only add the two new permissions to the
--     self-service roles, and the store/routes always bind to the caller's
--     own user_id.

CREATE TABLE IF NOT EXISTS memory_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  user_id UUID NOT NULL,
  fact TEXT NOT NULL CHECK (char_length(fact) BETWEEN 1 AND 2000),
  category TEXT NOT NULL DEFAULT 'fact'
    CHECK (category IN ('preference', 'fact', 'project')),
  classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  source TEXT NOT NULL DEFAULT 'user-stated'
    CHECK (source IN ('user-stated', 'inferred')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Most-recent-first per-user listing (the injection path orders by
-- updated_at DESC), covering the tenant+user scoping predicates.
CREATE INDEX IF NOT EXISTS idx_memory_facts_tenant_user
  ON memory_facts (tenant_id, user_id, updated_at DESC);

ALTER TABLE memory_facts ENABLE ROW LEVEL SECURITY;
ALTER TABLE memory_facts FORCE ROW LEVEL SECURITY;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE policyname = 'tenant_isolation' AND tablename = 'memory_facts'
  ) THEN
    EXECUTE 'CREATE POLICY tenant_isolation ON memory_facts USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)';
  END IF;
END $$;

-- Self-service memory permissions (following the 019/022 grant pattern):
-- users manage their OWN memories; no cross-user access exists by design.
INSERT INTO permissions (name) VALUES ('memory:read'), ('memory:write')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name IN ('memory:read', 'memory:write')
  AND r.name IN ('User', 'Admin', 'AI Admin', 'Developer')
ON CONFLICT DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name = 'memory:read'
  AND r.name = 'Read Only'
ON CONFLICT DO NOTHING;
