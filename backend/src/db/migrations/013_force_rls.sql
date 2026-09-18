-- 013_force_rls.sql
-- Harden tenant isolation: with plain ENABLE ROW LEVEL SECURITY the table
-- *owner* bypasses row-security policies, so a deployment whose runtime role
-- owns the tables would silently lose tenant isolation. FORCE ROW LEVEL
-- SECURITY applies the tenant_isolation policies even to table owners.
-- This is safe for the application because every read/write of these tables
-- goes through tenantQuery(), which always sets app.tenant_id; the only
-- non-tenant-context queries in the codebase (users, memberships, permissions,
-- tenants, schema_migrations) are on tables without RLS.

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'conversations', 'messages', 'audit_events', 'sessions', 'model_access',
    'documents', 'document_permissions', 'document_chunks', 'tool_executions',
    'departments', 'security_groups', 'department_memberships',
    'security_group_memberships', 'document_ingestion_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;
