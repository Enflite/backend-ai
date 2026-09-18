-- Production vector-search performance.
-- Append-only; historical migrations remain unchanged.
--
-- Adds an HNSW index on document chunk embeddings so nearest-neighbor
-- retrieval (ORDER BY embedding <=> $1 LIMIT 8) does not degrade into a
-- sequential scan as the corpus grows. Cosine distance (<=>) matches the
-- operator class below. Guarded on pgvector >= 0.7.0 (HNSW support); older
-- deployments keep working without the index.
DO $$
DECLARE
  v INT[];
BEGIN
  SELECT string_to_array(extversion, '.')::int[] INTO v
  FROM pg_extension WHERE extname = 'vector';
  IF v IS NOT NULL AND v >= ARRAY[0, 7, 0] THEN
    CREATE INDEX IF NOT EXISTS idx_document_chunks_embedding_hnsw
      ON document_chunks USING hnsw (embedding vector_cosine_ops);
  ELSE
    RAISE NOTICE 'pgvector version too old for HNSW; skipping vector index';
  END IF;
END $$;

-- Frequently filtered together with the vector ordering in retrieval and
-- ingestion cleanup.
CREATE INDEX IF NOT EXISTS idx_document_chunks_document_created
  ON document_chunks (tenant_id, document_id, created_at DESC);

-- Audit event lookups are action-scoped in the API (/api/v1/audit?action=...).
CREATE INDEX IF NOT EXISTS idx_audit_events_tenant_action_created
  ON audit_events (tenant_id, action, created_at DESC);
