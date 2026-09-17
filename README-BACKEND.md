# Backend AI Foundation

Private AI platform backend built with Fastify, TypeScript, PostgreSQL (with pgvector), JWT authentication with Argon2id, RBAC authorization, audit logging, and an approved-models AI Gateway with SSE streaming chat.

## Quick Start

### Option 1: Docker Compose

Start PostgreSQL and the backend:

```bash
docker compose up
```

To run with an internal vLLM instance using GPU:

```bash
docker compose --profile gpu up
```

### Option 2: Local Development

Prerequisites: Node.js >= 20, PostgreSQL with `pgcrypto` and `vector` extensions.

1. Install dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Configure environment:
   ```bash
   cp .env.example .env
   # Edit .env to set your DATABASE_URL, JWT_SECRET, etc.
   ```

3. Run migrations:
   ```bash
   npm run migrate
   ```

4. Create an initial user:
   ```bash
   npm run create-user -- --email admin@example.com --password securePassword123! --role Admin
   ```

5. Start dev server:
   ```bash
   npm run dev
   ```

## Endpoints

### Health & Readiness
- `GET /health` — Health check (`{ "status": "ok" }`)
- `GET /ready` — Readiness check verifying database connectivity

### Authentication (`/api/v1/auth`)
- `POST /api/v1/auth/login` — Authenticate with email and password, rate limited to 10 req/min
- `POST /api/v1/auth/dev-login` — Development bypass login (disabled in production)
- `GET /api/v1/me` — Return authenticated user context and permissions

### Audit (`/api/v1/audit`)
- `GET /api/v1/audit` — Tenant-scoped audit events (requires `audit:read`, supports `?action=&limit=&offset=`)

### Models (`/api/v1/models`)
- `GET /api/v1/models` — List approved models (requires `model:use`)

### Conversations (`/api/v1/conversations`)
- `GET /api/v1/conversations` — List user conversations in tenant (requires `conversation:read`)
- `POST /api/v1/conversations` — Create a new conversation (requires `chat:create`)
- `GET /api/v1/conversations/:id` — Get conversation details (requires `conversation:read`)
- `GET /api/v1/conversations/:id/messages` — Get conversation messages (requires `conversation:read`)
- `PATCH /api/v1/conversations/:id` — Update conversation title (requires `conversation:read`)
- `DELETE /api/v1/conversations/:id` — Delete conversation and audit action (requires `conversation:delete`)

### Chat Streaming (`/api/v1/chat`)
- `POST /api/v1/chat` — Stream chat completions via Server-Sent Events (`text/event-stream`). Emits `meta`, `delta`, `done`, and `error` events.

## Registering a Real vLLM Endpoint

Models are managed exclusively via the database registry. To point the approved model to a production or external vLLM server:

```sql
UPDATE models
SET endpoint = 'http://your-vllm-host:8000/v1'
WHERE status = 'APPROVED';
```

Clients never supply provider endpoints; all inference calls route securely through the AI Gateway.

## Testing & Verification

Run tests:
```bash
cd backend
npm test
```

Run typechecking:
```bash
cd backend
npm run typecheck
```

Validate Docker Compose configuration:
```bash
docker compose config
```

## Explicitly Out of Scope

The following capabilities are tracked for subsequent PRs and are intentionally not present in PR 1:
- RAG (Retrieval-Augmented Generation) pipeline
- Document upload and ingestion
- Vector embeddings and similarity search
- Citations
- Tool gateway and SyteLine integration
- Model evaluation and red-teaming
- OpenTelemetry instrumentation and metrics
- Frontend UI integration
