# Development

Copy `backend/.env.example` and provide test-only secrets. `docker compose up mongodb minio minio-init` prepares MongoDB and private S3-compatible storage. For inference: `docker compose up ollama` starts the bundled Ollama service (or run `backend/scripts/setup-ollama-windows.ps1` on a native Windows host), then `docker exec <compose-project>-ollama-1 ollama pull llama3.1:8b`, `ollama pull nomic-embed-text`, and `ollama pull qwen2.5vl:7b` (vision model for image attachments) if the images weren't pre-pulled. Run backend migrations before `npm run dev`; run the frontend with its documented pnpm command.

Create users with `npm run create-user -- --email <email>`; the password comes from a no-echo TTY prompt unless `BACKEND_CREATE_USER_PASSWORD` is set (`--password` is not accepted).

Document ingestion uses the Ollama embedding provider by default
(`nomic-embed-text`, 768 dims) — no separate embedding service needed for
local dev. To use an OpenAI-compatible embedding endpoint instead
(e.g. vLLM `/v1/embeddings`), set `EMBEDDING_PROVIDER=openai-compatible`
plus `EMBEDDING_BASE_URL`/`EMBEDDING_MODEL`/`EMBEDDING_DIMENSIONS`. Warning:
embedding model/dimensions are pinned into `document_chunks` — switching
providers on an existing database requires re-ingestion. `disabled-development` permits non-CUI parsing when no malware scanner is present, but records no clean verdict and cannot start in production. CUI remains quarantined without a clean scanner verdict.

Validation commands are:

```sh
cd backend && npm ci && npm run migrate && npm test && npm run typecheck && npm run build
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build
docker compose config --quiet
```

Real inference, scanner behavior, and production object-storage policy must be validated against the deployed internal services. Tests must not substitute development adapters in a production configuration.
