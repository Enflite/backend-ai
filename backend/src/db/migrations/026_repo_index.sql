-- 026_repo_index.sql
-- Multi-repository code indexing (repo-aware coding across all of the
-- organization's repositories, not just pasted files).
--
-- - `repos`: the registry of indexed repositories. A repo is either cloned
--   from `git_url` (private hosts authenticate with the GITHUB_TOKEN server
--   secret, never stored here) or read from `local_path` on the backend
--   host. Exactly one source must be set.
-- - `repo_code_chunks`: embedded code chunks, namespaced per repo. Retrieval
--   filters on tenant, repo status, classification, and the embedding
--   model/version/dimensions that produced the vector — the same provenance
--   pinning document_chunks uses.
-- - `repo_files`: the exact indexed content of every file (one row per
--   file), so `repo.readFile` returns byte-exact content instead of
--   re-stitching overlapping chunks. Written atomically with the chunks.
--
-- Tenant isolation follows the 003 pattern (RLS + FORCE RLS is defense in
-- depth; every access goes through tenantQuery()).

CREATE TABLE repos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  git_url TEXT CHECK (git_url IS NULL OR char_length(git_url) BETWEEN 1 AND 500),
  local_path TEXT CHECK (local_path IS NULL OR char_length(local_path) BETWEEN 1 AND 500),
  default_branch TEXT NOT NULL DEFAULT 'main' CHECK (char_length(default_branch) BETWEEN 1 AND 100),
  classification TEXT NOT NULL DEFAULT 'INTERNAL'
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  status TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SYNCING', 'READY', 'FAILED')),
  commit_sha TEXT CHECK (commit_sha IS NULL OR char_length(commit_sha) = 40),
  chunk_count INTEGER NOT NULL DEFAULT 0 CHECK (chunk_count >= 0),
  last_synced_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT repos_source_check CHECK (num_nonnulls(git_url, local_path) = 1),
  CONSTRAINT repos_name_unique UNIQUE (tenant_id, name)
);
CREATE INDEX idx_repos_tenant_status ON repos(tenant_id, status);

CREATE TABLE repo_code_chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 500),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  content TEXT NOT NULL CHECK (char_length(content) > 0),
  -- Fixed at 1536 dimensions, matching document_chunks (004): the platform's
  -- approved embedding providers are 1536-dimensional, and HNSW requires a
  -- declared dimension. The indexer refuses to sync with any other
  -- embedding dimension (REPO_EMBEDDING_DIMENSIONS_UNSUPPORTED).
  embedding VECTOR(1536) NOT NULL,
  classification TEXT NOT NULL
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  embedding_model TEXT,
  embedding_version TEXT,
  embedding_dimensions INTEGER CHECK (embedding_dimensions IS NULL OR embedding_dimensions > 0),
  commit_sha TEXT CHECK (commit_sha IS NULL OR char_length(commit_sha) = 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT repo_code_chunks_unique UNIQUE (repo_id, path, chunk_index)
);
CREATE INDEX idx_repo_code_chunks_tenant_repo ON repo_code_chunks(tenant_id, repo_id);
CREATE INDEX idx_repo_code_chunks_embedding_hnsw ON repo_code_chunks
  USING hnsw (embedding vector_cosine_ops);

-- Exact indexed file content: one row per file, written atomically with the
-- chunk set so repo.readFile never re-stitches overlapping chunks.
CREATE TABLE repo_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  path TEXT NOT NULL CHECK (char_length(path) BETWEEN 1 AND 500),
  content TEXT NOT NULL CHECK (char_length(content) > 0),
  classification TEXT NOT NULL
    CHECK (classification IN ('PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI', 'UNKNOWN')),
  commit_sha TEXT CHECK (commit_sha IS NULL OR char_length(commit_sha) = 40),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT repo_files_unique UNIQUE (tenant_id, repo_id, path)
);
CREATE INDEX idx_repo_files_tenant_repo_path ON repo_files(tenant_id, repo_id, path);

-- Tenant isolation (defense in depth; see 003 / 013).
DO $$
DECLARE table_name TEXT;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['repos', 'repo_code_chunks', 'repo_files']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      table_name
    );
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
  END LOOP;
END $$;

-- Repo tool permissions: code search/read is granted and revoked
-- independently of generic tool use, mirroring the 019 syteline:read
-- pattern. Idempotent for re-runs.
INSERT INTO permissions (name) VALUES ('repo:read'), ('repo:manage')
ON CONFLICT (name) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name = 'repo:read'
  AND r.name IN ('User', 'Admin', 'AI Admin', 'Developer')
ON CONFLICT DO NOTHING;

-- repo:manage governs repo registration/sync/deletion: admins only.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE p.name = 'repo:manage'
  AND r.name IN ('Admin', 'AI Admin')
ON CONFLICT DO NOTHING;
