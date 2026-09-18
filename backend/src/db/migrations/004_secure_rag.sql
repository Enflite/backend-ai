-- Secure RAG lifecycle, durable ingestion, ACLs, and embedding provenance.
-- Append-only: do not modify migrations that may already be deployed.

INSERT INTO permissions (name) VALUES ('document:classify') ON CONFLICT (name) DO NOTHING;
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r CROSS JOIN permissions p
WHERE r.name IN ('Admin', 'Security Admin') AND p.name = 'document:classify'
ON CONFLICT DO NOTHING;

CREATE TABLE departments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  UNIQUE (tenant_id, name)
);

CREATE TABLE security_groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 120),
  UNIQUE (tenant_id, name)
);

CREATE TABLE department_memberships (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  department_id UUID NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (department_id, user_id)
);

CREATE TABLE security_group_memberships (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id UUID NOT NULL REFERENCES security_groups(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, user_id)
);

ALTER TABLE documents ADD COLUMN department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE documents ADD COLUMN source_system TEXT;
ALTER TABLE documents ADD COLUMN retention_policy TEXT;
ALTER TABLE documents DROP CONSTRAINT documents_status_check;
UPDATE documents SET status = 'READY' WHERE status = 'COMPLETED';
ALTER TABLE documents ADD CONSTRAINT documents_status_check
  CHECK (status IN ('PENDING', 'PROCESSING', 'READY', 'FAILED', 'QUARANTINED', 'DELETED'));

ALTER TABLE document_permissions ADD COLUMN department_id UUID REFERENCES departments(id) ON DELETE CASCADE;
ALTER TABLE document_permissions ADD COLUMN group_id UUID REFERENCES security_groups(id) ON DELETE CASCADE;
ALTER TABLE document_permissions DROP CONSTRAINT document_permissions_check;
ALTER TABLE document_permissions DROP CONSTRAINT document_permissions_document_id_user_id_role_id_key;
ALTER TABLE document_permissions ADD CONSTRAINT document_permissions_principal_check
  CHECK (
    (user_id IS NOT NULL)::int + (role_id IS NOT NULL)::int +
    (department_id IS NOT NULL)::int + (group_id IS NOT NULL)::int = 1
  );
ALTER TABLE document_permissions ADD CONSTRAINT document_permissions_principal_unique
  UNIQUE NULLS NOT DISTINCT (document_id, user_id, role_id, department_id, group_id);
DROP INDEX idx_document_permissions_lookup;
CREATE INDEX idx_document_permissions_lookup
  ON document_permissions(tenant_id, document_id, user_id, role_id, department_id, group_id);

ALTER TABLE document_chunks ADD COLUMN classification TEXT;
UPDATE document_chunks dc SET classification = d.classification FROM documents d WHERE d.id = dc.document_id;
ALTER TABLE document_chunks ALTER COLUMN classification SET NOT NULL;
ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_classification_check
  CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI'));
ALTER TABLE document_chunks ADD COLUMN embedding_model TEXT;
ALTER TABLE document_chunks ADD COLUMN embedding_version TEXT;
ALTER TABLE document_chunks ADD COLUMN embedding_dimensions INTEGER;
UPDATE document_chunks SET embedding_model = 'legacy', embedding_version = 'unknown',
  embedding_dimensions = vector_dims(embedding);
ALTER TABLE document_chunks ALTER COLUMN embedding_model SET NOT NULL;
ALTER TABLE document_chunks ALTER COLUMN embedding_version SET NOT NULL;
ALTER TABLE document_chunks ALTER COLUMN embedding_dimensions SET NOT NULL;
ALTER TABLE document_chunks ADD CONSTRAINT document_chunks_embedding_dimensions_check
  CHECK (embedding_dimensions = 1536 AND vector_dims(embedding) = embedding_dimensions);
ALTER TABLE document_chunks ALTER COLUMN embedding TYPE VECTOR(1536) USING embedding::VECTOR(1536);
CREATE INDEX idx_document_chunks_embedding_hnsw ON document_chunks
  USING hnsw (embedding vector_cosine_ops);

CREATE TABLE document_ingestion_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  request_id TEXT,
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 10),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_ingestion_jobs_active_document ON document_ingestion_jobs(document_id)
  WHERE status IN ('PENDING', 'PROCESSING');
CREATE INDEX idx_ingestion_jobs_pending ON document_ingestion_jobs(available_at, created_at)
  WHERE status = 'PENDING';

DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'departments', 'security_groups', 'department_memberships',
    'security_group_memberships', 'document_ingestion_jobs'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;
