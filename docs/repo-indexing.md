# Repository code indexing (repo.search / repo.readFile)

Multi-repo code search for coding turns: administrators register git
repositories per tenant; the backend clones, embeds, and indexes them into
`repo_code_chunks` (pgvector HNSW); chat models use the `repo.search` and
`repo.readFile` tools to find and read code with repo/path/commit
provenance. The model never sees git URLs, tokens, or host filesystems.

## Registration and sync

Admins (role with `repo:manage`) register repositories through the REST API:

- `POST /api/v1/repos` — body: `{ name, gitUrl }` or `{ name, localPath }`
  (exactly one). `gitUrl` must be `https://` on a host in
  `REPO_GIT_HOST_ALLOWLIST` (default `github.com`). `localPath` must be an
  absolute path **inside `REPO_LOCAL_ROOT`** (default `/data/repos-local`)
  that the backend can read — registrations outside the root are rejected
  at registration and re-checked at every sync, so the admin API can never
  become a read primitive for arbitrary server paths.
- `GET /api/v1/repos/discover` — list every repo `GITHUB_TOKEN` can see in
  `GITHUB_ORG` (public and private), each flagged `registered` for this
  tenant. This is the "use all of my existing repos" entry point.
- `POST /api/v1/repos/import` — register all not-yet-registered org repos
  in one call (name, clone URL, default branch; classification INTERNAL).
  Import does not sync; follow with `POST /api/v1/repos/sync`.
- `GET /api/v1/repos` — list the tenant's repos with sync state.
- `GET /api/v1/repos/:id` — one repo's sync state.
- `POST /api/v1/repos/:id/sync` — clone (first sync) or fetch+reset to the
  default branch, then reindex. Returns 202 immediately; a sync already in
  flight is shared, not duplicated.
- `POST /api/v1/repos/sync` — sync every repo for the tenant (best
  effort; per-repo errors are reported, not thrown).
- `DELETE /api/v1/repos/:id` — delete the repo and its chunks.

Sync state (`repos.sync_status`, `indexed_commit_sha`, `indexed_at`,
`last_error`, `chunk_count`) is visible on every repo object, so the model
and operators can see which commit the index reflects. Chunks are replaced
atomically per sync; a failed sync never leaves a half-written index.

## What gets indexed

`walkRepoFiles` collects text files only: dependency directories
(`node_modules`, `vendor`, `.venv`, ...), VCS metadata, build outputs,
minified bundles, lockfiles, binaries (null-byte sniff), and files over
`REPO_MAX_FILE_BYTES` are skipped. Symlinks are never followed. Files are
chunked with `REPO_CHUNK_MAX_CHARS`/`REPO_CHUNK_OVERLAP` and embedded with
the same internal embedding provider as document RAG (`EMBEDDING_PROVIDER`),
so both `openai-compatible` and `ollama` embeddings work. Each chunk pins
`embedding_model`, `embedding_version`, `embedding_dimensions`, the indexed
commit SHA, and the repo-relative path. Search filters on all of these, so
a re-sync to a new commit or an embedding-model swap can never silently
serve stale or dimension-mismatched vectors.

## Tools

| Tool | Permission | Purpose |
|---|---|---|
| `repo.search` | `repo:read` | Semantic search over indexed code. `{ query, repos?, pathPrefix?, topK? }` — natural-language query; results carry repo, path, commit SHA, and a snippet. |
| `repo.readFile` | `repo:read` | Read a file as indexed: `{ repo, path }`. The path is normalized and must stay inside the repo — `..` escapes and absolute paths are rejected. Returns the file content with its indexed commit. |

Both tools are non-destructive, classification-gated, timeout-bounded
(`AI_TOOL_TIMEOUT_MS`), and audited like every other tool. `repo.readFile`
reads the exact indexed file row, so what the model reads is
byte-exact content as indexed at that commit — not the current working tree
and not re-stitched chunks.

## Coding turns

When the chat route offers the repo tools (coding-capable role +
`repo:read`), the system prompt tells the model to use `repo.search` to
locate symbols and `repo.readFile` for the full file before answering
code questions, instead of guessing at paths. Prompt version `2.4.0`.

## Provider parity (vLLM and Ollama)

The system prompt — including the SyteLine domain-expertise pack — is
assembled in `chat/routes.ts` and passed to the AI gateway unchanged. The
gateway dispatches to vLLM/OpenAI-compatible or Ollama providers with the
identical message array (byte-for-byte; covered by a regression test in
`test/gateway.test.ts`). The SyteLine knowledge pack therefore reaches the
Ollama dev backend exactly as it reaches production vLLM. Ollama remains
dev-only: the provider factory refuses to construct it unless
`ALLOW_DEV_PROVIDERS` is enabled.

## Security properties

- The GitHub token lives only in server config (`GITHUB_TOKEN`), passed to
  git via `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_*` config env so it never
  appears in a URL, process listing, database row, or log. Leave it empty
  for public-only indexing.
- Clones go to `REPO_WORKDIR` (default `/data/repos`) under
  `<tenantId>/<repoId>` UUID directories; the model cannot choose paths or
  URLs. Branch names that could be parsed as git options (leading dash,
  `..`, stray slashes) are rejected at registration.
- `localPath` registrations are confined to `REPO_LOCAL_ROOT` (default
  `/data/repos-local`): symlinks are resolved and paths outside the root
  are rejected at registration and re-checked at every sync.
- All repo queries are tenant-scoped (`app.tenant_id` + forced RLS) with
  `classification <= clearance` filtering, exactly like document RAG.
- The model cannot register, sync, or delete repos — those routes need
  `repo:manage`, and tools expose only search/read.

## Operations

- The backend image ships `git`; compose mounts a persistent
  `repodata` volume at `/data/repos` so syncs survive restarts.
- Embedding a large org takes minutes; syncs run in the background
  (`POST /repos/:id/sync` and `POST /repos/sync` return 202 immediately;
  poll `GET /repos` for `SYNCING` → `READY`/`FAILED`). Schedule periodic
  `/repos/sync` calls from your job runner for freshness.
- Private repos require `GITHUB_TOKEN` with `repo` read scope for the
  Enflite org. The same token powers `GET /repos/discover` and
  `POST /repos/import` against `GITHUB_API_BASE` (default
  `https://api.github.com`) for org `GITHUB_ORG` (default `Enflite`):
  import everything at once, then `POST /repos/sync` to index it all.
- The index requires 1536-dimensional embeddings (migration 026 pins
  `repo_code_chunks.embedding` to `VECTOR(1536)`, matching
  `document_chunks`); syncs with any other embedding dimension fail fast
  with `REPO_EMBEDDING_DIMENSIONS_UNSUPPORTED`.
- The per-repo sync mutex is process-local: overlapping triggers in one
  backend instance serialize, but two backend instances could sync the same
  repo concurrently. Index swaps are atomic (last writer wins), so this is
  wasted work, not corruption — run a single syncing instance or schedule
  `/repos/sync` from one job runner.
