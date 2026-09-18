# Deployment and operations

Use `backend/.env.example` and `frontend/.env.example` as inventories, not deployable secrets. Supply secrets through the deployment secret manager. Run migrations before rolling out the API. The production database principal must be a non-owner without `BYPASSRLS`; otherwise PostgreSQL owners bypass RLS and only the application query filters remain.

Required production dependencies are PostgreSQL 16 with `pgcrypto` and `vector` (>= 0.7.0 for the HNSW vector index), S3-compatible private object storage, an HTTP malware scanner, approved OpenAI-compatible chat and embedding services, TLS termination, and an enterprise identity integration. SyteLine is optional. Document extraction (PDF, DOCX, XLSX, HTML, CSV, Markdown, text) runs locally inside the API process with bounded archive expansion; no separate extractor service is required.

The backend container is multi-stage, deterministic (`npm ci`), non-root, and exposes `/health` and database-aware `/ready`. `COOKIE_SECURE=true`, `MALWARE_SCAN_MODE=http`, `MALWARE_SCANNER_ENDPOINT`, explicit `CORS_ORIGIN`, short access-token lifetime (`JWT_EXPIRES_IN`, default `15m`), and high-entropy `JWT_SECRET` (>= 32 chars, documented placeholders are refused at startup) are mandatory in production. Do not expose model, embedding, storage, scanner, database, or SyteLine endpoints directly to browsers.

The server shuts down gracefully on SIGTERM/SIGINT: it stops accepting connections, lets in-flight requests finish, then drains the PostgreSQL pool. Crashed ingestion jobs are reclaimed on the next startup (`recoverIngestionJobs`), including documents stuck in PENDING/PROCESSING without an active job row.

`npm run build` compiles TypeScript and copies `src/db/migrations` into `dist/src/db/migrations`; run migrations in production with `npm run migrate:prod` (never `tsx` outside development). Migrations apply in filename order and are append-only; 004 renames the legacy `COMPLETED` document status to `READY`.

Create operator accounts with `npm run create-user -- --email <email>`: the password is read from a no-echo TTY prompt unless `--password` or `CREATE_USER_PASSWORD` is supplied (the flag exposes the password in shell history and process listings; prefer the prompt). Minimum length is 12 characters and `UNKNOWN` clearance is rejected.

Optional tuning: `RAG_SIMILARITY_THRESHOLD` (0–1, default 0 = disabled) drops low-relevance chunks after the hybrid rerank so weak matches never reach model context.

Validation without the actual internal providers can cover builds, migrations, policies, request boundaries, and adapters, but it cannot establish real inference quality, embeddings, scanning, extraction, storage, or SyteLine connectivity.
