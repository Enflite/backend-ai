-- 008_query_performance.sql
-- Query-plan and index fixes from the query-pattern audit:
--  1. model_access OR-condition (ma.user_id = $2 OR ma.role_id = $3) on the hot
--     chat path could not use idx_model_access_tenant_model; add per-leg indexes
--     so the planner can bitmapOr the two equality legs with tenant scoping.
--  2. Ingestion worker scans run under RLS (tenant_id filter appended) but the
--     pending index had no tenant_id; add tenant-scoped partial indexes matching
--     the actual worker predicates.
--  3. GET /documents ordering (tenant_id, created_at DESC) had no serving index.
--  4. Drop indexes that are strict prefixes of others or serve no query in the
--     codebase (pure write overhead on hot insert paths):
--       - idx_document_chunks_tenant_document: strict prefix of
--         idx_document_chunks_document_created; document_id probes are covered
--         by UNIQUE(document_id, chunk_index).
--       - idx_audit_events_action: every audit read filters tenant_id, covered
--         by idx_audit_events_tenant_action_created.
--       - idx_messages_tenant: all message reads are conversation-scoped via
--         idx_messages_conversation.
--     NOTE: these drops are based on repository query analysis. Operators who
--     run ad-hoc cross-tenant audit/message queries should verify their
--     patterns against the surviving composite indexes before applying.
--     RLS on memberships is deliberately NOT enabled here: login resolves a
--     user's memberships by user_id before any tenant context exists
--     (auth/routes.ts membershipsFor), and an RLS policy keyed on
--     app.tenant_id would return zero rows and break every login. Membership
--     reads are already explicitly user/tenant filtered in code.

-- 1. model_access OR legs
CREATE INDEX IF NOT EXISTS idx_model_access_tenant_user ON model_access (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_model_access_tenant_role ON model_access (tenant_id, role_id);

-- 2. Ingestion worker scans, tenant-scoped
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_tenant_pending
  ON document_ingestion_jobs (tenant_id, created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_tenant_stale
  ON document_ingestion_jobs (tenant_id, locked_at) WHERE status = 'PROCESSING';

-- 3. Document list ordering
CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- 4. Drop redundant / unused indexes
DROP INDEX IF EXISTS idx_document_chunks_tenant_document;
DROP INDEX IF EXISTS idx_audit_events_action;
DROP INDEX IF EXISTS idx_messages_tenant;
