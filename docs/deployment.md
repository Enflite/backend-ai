# Deployment and operations

Use `backend/.env.example` and `frontend/.env.example` as inventories, not deployable secrets. Supply secrets through the deployment secret manager. Run migrations before rolling out the API. The production database principal must be a non-owner without `BYPASSRLS`; otherwise PostgreSQL owners bypass RLS and only the application query filters remain.

Required production dependencies are PostgreSQL 16 with `pgcrypto` and `vector`, S3-compatible private object storage, malware scanner, internal document extractor for binary formats, approved OpenAI-compatible chat and embedding services, TLS termination, and an enterprise identity integration. SyteLine is optional.

The backend container is multi-stage, deterministic (`npm ci`), non-root, and exposes `/health` and database-aware `/ready`. `COOKIE_SECURE=true`, `MALWARE_SCAN_MODE=http`, `MALWARE_SCANNER_ENDPOINT`, explicit `CORS_ORIGIN`, short access-token lifetime, and high-entropy `JWT_SECRET` are mandatory in production. Do not expose model, embedding, storage, scanner, database, or SyteLine endpoints directly to browsers.

Validation without the actual internal providers can cover builds, migrations, policies, request boundaries, and adapters, but it cannot establish real inference quality, embeddings, scanning, extraction, storage, or SyteLine connectivity.
