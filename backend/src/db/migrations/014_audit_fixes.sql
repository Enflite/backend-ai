-- 014_audit_fixes.sql
-- Index fixes from the query-pattern audit (transactional-safe; no
-- non-transactional marker needed -- these are plain CREATE/DROP INDEX).
--
-- NOTE: migration 008_query_performance.sql already applied the five CREATE
-- INDEX statements below. They are repeated here with IF NOT EXISTS so this
-- file matches the audit checklist and stays a no-op on fully-migrated
-- databases; the genuinely new changes are the three DROP INDEX statements
-- at the end:
--
--  - idx_model_access_tenant_user / idx_model_access_tenant_role: serve the
--    two equality legs of the chat-path model_access OR-condition so the
--    planner can bitmapOr them with tenant scoping.
--  - idx_ingestion_jobs_tenant_pending / idx_ingestion_jobs_tenant_stale:
--    tenant-scoped partial indexes matching the ingestion worker's
--    PENDING-claim and PROCESSING-stale-reclaim predicates.
--  - idx_documents_tenant_created: serves GET /documents ordering
--    (tenant_id, created_at DESC) on non-deleted documents.
--  - DROP idx_audit_events_user: no query filters audit_events by user_id;
--    audit reads are (tenant_id) or (tenant_id, action) via
--    idx_audit_events_tenant_created / idx_audit_events_tenant_action_created.
--  - DROP idx_documents_tenant_classification: no query filters documents by
--    (classification, status); classification appears only as a residual
--    predicate (<> 'UNKNOWN') after id or tenant/status predicates.
--  - DROP idx_users_email: redundant -- users.email is UNIQUE, which already
--    carries its own btree index; the extra index was pure write overhead on
--    user create/update.
--
-- The remaining drops from the audit (idx_document_chunks_tenant_document,
-- idx_audit_events_action, idx_messages_tenant) were already applied by 008.

-- 1. model_access OR legs (no-op if 008 applied)
CREATE INDEX IF NOT EXISTS idx_model_access_tenant_user ON model_access (tenant_id, user_id);
CREATE INDEX IF NOT EXISTS idx_model_access_tenant_role ON model_access (tenant_id, role_id);

-- 2. Ingestion worker scans, tenant-scoped partial indexes (no-op if 008 applied)
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_tenant_pending
  ON document_ingestion_jobs (tenant_id, created_at) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS idx_ingestion_jobs_tenant_stale
  ON document_ingestion_jobs (tenant_id, locked_at) WHERE status = 'PROCESSING';

-- 3. Document list ordering (no-op if 008 applied)
CREATE INDEX IF NOT EXISTS idx_documents_tenant_created
  ON documents (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- 4. Drop redundant / unused indexes (new in this migration)
DROP INDEX IF EXISTS idx_audit_events_user;
DROP INDEX IF EXISTS idx_documents_tenant_classification;
DROP INDEX IF EXISTS idx_users_email;
