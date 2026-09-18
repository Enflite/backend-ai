-- Enterprise security, document/RAG, model policy, session, and tool foundation.
-- This migration is append-only; historical migrations remain unchanged.

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS classification TEXT NOT NULL DEFAULT 'INTERNAL';
ALTER TABLE conversations ADD CONSTRAINT conversations_classification_check
  CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')) NOT VALID;

ALTER TABLE messages ADD COLUMN IF NOT EXISTS citations JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE models ADD COLUMN IF NOT EXISTS model_identifier TEXT;
ALTER TABLE models ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE models ADD COLUMN IF NOT EXISTS deployment JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE models ADD COLUMN IF NOT EXISTS allowed_classifications TEXT[] NOT NULL
  DEFAULT ARRAY['PUBLIC','INTERNAL']::TEXT[];
UPDATE models SET model_identifier = name WHERE model_identifier IS NULL;
ALTER TABLE models ALTER COLUMN model_identifier SET NOT NULL;
ALTER TABLE models ADD CONSTRAINT models_allowed_classifications_check
  CHECK (allowed_classifications <@ ARRAY['PUBLIC','INTERNAL','CONFIDENTIAL','PROPRIETARY','CUI']::TEXT[]) NOT VALID;

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES models(id) ON DELETE RESTRICT;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS model_id UUID REFERENCES models(id) ON DELETE RESTRICT;
UPDATE conversations c SET model_id = m.id FROM models m WHERE c.model_id IS NULL AND c.model = m.name;
UPDATE messages msg SET model_id = m.id FROM models m WHERE msg.model_id IS NULL AND msg.model = m.name;

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  refresh_token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_sessions_active ON sessions(id, user_id, tenant_id, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE model_access (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  model_id UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((role_id IS NOT NULL)::int + (user_id IS NOT NULL)::int = 1),
  UNIQUE NULLS NOT DISTINCT (tenant_id, model_id, role_id, user_id)
);
CREATE INDEX idx_model_access_tenant_model ON model_access(tenant_id, model_id);
INSERT INTO model_access (tenant_id, model_id, role_id)
SELECT t.id, m.id, r.id
FROM tenants t CROSS JOIN models m CROSS JOIN roles r
WHERE m.status = 'APPROVED' AND r.name IN ('User', 'Admin', 'AI Admin', 'Developer')
ON CONFLICT DO NOTHING;

CREATE TABLE documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  owner_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  filename TEXT NOT NULL CHECK (char_length(filename) BETWEEN 1 AND 255),
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT NOT NULL CHECK (checksum_sha256 ~ '^[a-f0-9]{64}$'),
  object_key TEXT NOT NULL UNIQUE,
  classification TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'PROCESSING', 'COMPLETED', 'FAILED', 'QUARANTINED')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ,
  UNIQUE (tenant_id, checksum_sha256)
);
CREATE INDEX idx_documents_tenant_owner ON documents(tenant_id, owner_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX idx_documents_tenant_classification ON documents(tenant_id, classification, status) WHERE deleted_at IS NULL;

CREATE TABLE document_permissions (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID REFERENCES roles(id) ON DELETE CASCADE,
  can_read BOOLEAN NOT NULL DEFAULT true,
  can_delete BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((user_id IS NOT NULL)::int + (role_id IS NOT NULL)::int = 1),
  UNIQUE NULLS NOT DISTINCT (document_id, user_id, role_id)
);
CREATE INDEX idx_document_permissions_lookup ON document_permissions(tenant_id, document_id, user_id, role_id);

CREATE TABLE document_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (char_length(content) > 0),
  embedding VECTOR NOT NULL,
  page INTEGER CHECK (page IS NULL OR page > 0),
  section TEXT,
  source_location TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX idx_document_chunks_tenant_document ON document_chunks(tenant_id, document_id);

CREATE TABLE tool_executions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id TEXT NOT NULL,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  tool_name TEXT NOT NULL,
  action TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
  authorization_decision TEXT NOT NULL,
  classification TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  status TEXT NOT NULL CHECK (status IN ('DENIED', 'PENDING', 'SUCCEEDED', 'FAILED')),
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX idx_tool_executions_tenant_created ON tool_executions(tenant_id, created_at DESC);

-- RLS is defense in depth. The runtime database role must not own/bypass these tables.
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['conversations','messages','audit_events','sessions','model_access','documents','document_permissions','document_chunks','tool_executions']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
  END LOOP;
END $$;

DROP POLICY tenant_isolation ON audit_events;
CREATE POLICY tenant_isolation ON audit_events
  USING (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  )
  WITH CHECK (
    tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid
    OR (tenant_id IS NULL AND NULLIF(current_setting('app.tenant_id', true), '') IS NULL)
  );
