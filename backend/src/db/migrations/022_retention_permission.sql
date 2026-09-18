-- 022_retention_permission.sql
-- The retention/legal-hold surface (purge policy, legal holds) is an
-- admin/security function: grant it to Admin and Security Admin only.
-- Follows the 019 grant pattern; idempotent for re-runs.

INSERT INTO permissions (name) VALUES ('retention:manage')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name = 'retention:manage'
  AND r.name IN ('Admin', 'Security Admin')
ON CONFLICT DO NOTHING;
