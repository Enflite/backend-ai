-- 011_remove_dead_permissions.sql
-- tool:admin and user:manage were granted to roles but gated no route; dead
-- permissions invite future mis-wiring, so they are removed outright.
-- tenant:manage is retained: it authorizes document reclassification by
-- non-owners.

DELETE FROM role_permissions
WHERE permission_id IN (SELECT id FROM permissions WHERE name IN ('tool:admin', 'user:manage'));
DELETE FROM permissions WHERE name IN ('tool:admin', 'user:manage');
