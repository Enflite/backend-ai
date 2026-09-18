-- 019_syteline_permission.sql
-- Grant the Phase 5 SyteLine read-only tool surface its own permission so
-- ERP access is granted and revoked independently of generic tool use.
-- Follows the 002_seed.sql grant pattern; idempotent for re-runs.

INSERT INTO permissions (name) VALUES ('syteline:read')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name = 'syteline:read'
  AND r.name IN ('User', 'Admin', 'AI Admin', 'Developer')
ON CONFLICT DO NOTHING;
