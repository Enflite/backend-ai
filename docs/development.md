# Development

Copy `backend/.env.example` and provide test-only secrets. `docker compose up postgres minio minio-init` prepares PostgreSQL/pgvector and private S3-compatible storage. Run backend migrations before `npm run dev`; run the frontend with its documented pnpm command.

Document ingestion additionally needs an OpenAI-compatible embedding endpoint. `disabled-development` permits non-CUI parsing when no malware scanner is present, but records no clean verdict and cannot start in production. CUI remains quarantined without a clean scanner verdict.

Validation commands are:

```sh
cd backend && npm ci && npm run migrate && npm test && npm run typecheck && npm run build
cd frontend && pnpm install --frozen-lockfile && pnpm typecheck && pnpm build
docker compose config --quiet
```

Real inference, scanner behavior, and production object-storage policy must be validated against the deployed internal services. Tests must not substitute development adapters in a production configuration.
