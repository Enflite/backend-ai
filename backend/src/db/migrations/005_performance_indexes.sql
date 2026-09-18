-- Production query performance for the secure RAG pipeline.
-- Append-only; historical migrations remain unchanged.
--
-- 004_secure_rag owns the HNSW vector index. This migration adds the
-- composite B-tree indexes the hot queries need around it:
--
-- Frequently filtered together with the vector ordering in retrieval and
-- ingestion cleanup.
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_created
  ON document_chunks (tenant_id, document_id, created_at DESC);

-- Audit event lookups are action-scoped in the API (/api/v1/audit?action=...).
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action_created
  ON audit_events (tenant_id, action, created_at DESC);
