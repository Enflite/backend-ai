# Enflite private AI platform

Self-hosted React and Fastify application for authenticated chat, controlled internal models, tenant-scoped conversations, enterprise documents, secure pgvector retrieval, grounded citations, audited tools, and a SyteLine adapter boundary.

## Local preparation

Requirements are Node.js 20+ for the backend, the frontend toolchain from `frontend/.mise.toml`, PostgreSQL 16 with `pgcrypto` and `vector`, private S3-compatible storage, and the internal services needed for the flow being exercised.

```bash
cd backend
npm ci
cp .env.example .env
npm run migrate
npm run dev
```

In another terminal:

```bash
cd frontend
pnpm install --frozen-lockfile
cp .env.example .env
pnpm dev
```

Docker Compose prepares PostgreSQL and the API for development. The optional GPU profile starts vLLM. Object storage, embeddings, malware scanning, binary extraction, and SyteLine still require configured internal services; the application does not substitute fake production responses.

## API surface

- `POST /api/v1/auth/login`, `/auth/refresh`, `/auth/logout`; `GET /api/v1/me`
- `GET /api/v1/models`
- CRUD under `/api/v1/conversations` and message history
- `POST /api/v1/chat` using SSE `meta`, `delta`, `done`, and `error` events
- `POST/GET/DELETE /api/v1/documents`, retry ingestion, and `POST /api/v1/rag/search`
- `GET /api/v1/tools` and `POST /api/v1/tools/:name/execute`
- `GET /api/v1/audit`, `/health`, and `/ready`

The client sends model registry IDs only. Provider URLs, storage credentials, embedding credentials, and tool credentials remain server-side.

## Validation

```bash
cd backend
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high

cd ../frontend
pnpm typecheck
pnpm build

cd ..
docker compose config
docker build --target prod -t enflite/backend-ai:local backend
```

See `docs/architecture-security.md`, `docs/deployment.md`, `docs/threat-model.md`, and `docs/cmmc-nist.md` for the implemented boundaries, infrastructure dependencies, residual risk, and compliance control areas.
