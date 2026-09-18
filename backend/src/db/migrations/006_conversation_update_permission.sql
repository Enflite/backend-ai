-- Grant a dedicated write permission for renaming conversations. Previously the
-- PATCH /conversations/:id endpoint was gated by conversation:read, so read-only
-- roles could mutate conversation titles. Append-only: do not modify migrations
-- that may already be deployed.

INSERT INTO permissions (name) VALUES ('conversation:update') ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name IN ('Admin', 'User', 'Developer') AND p.name = 'conversation:update'
ON CONFLICT DO NOTHING;
