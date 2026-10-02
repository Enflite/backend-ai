# Heroku go-live guide

Deploys backend-ai to Heroku for the **Claude-only launch** (`OLLAMA_ENABLED=false`,
PR #46): no Ollama host, no GPU box, no model pulls. The backend API and the
frontend ship as **two separate Heroku apps** because the backend does not serve
the Vite SPA — `frontend/dist` needs its own static host.

## What you need first

1. Heroku CLI logged in (`heroku auth:whoami`).
2. **MongoDB Atlas** cluster (M0+). The backend is MongoDB-only — the PostgreSQL
   references in older docs are stale (ADR-014 moved migrations to MongoDB).
   Add Heroku to the Atlas IP allowlist: on M0–M5 there is no VPC peering, so
   allow `0.0.0.0/0` (Atlas still requires the DB username/password).
3. **S3-compatible object storage** for document/attachment bytes (AWS S3 or the
   Bucketeer add-on). The backend has no local-disk storage backend — uploads go
   from memory straight to S3.
4. **An HTTP malware scanner reachable from Heroku** (e.g. a ClamAV REST wrapper
   on a small VPS, or a cloud scanning API). This is a hard requirement: with
   `NODE_ENV=production` the server **refuses to boot** unless
   `MALWARE_SCAN_MODE=http` and `MALWARE_SCANNER_ENDPOINT` is set. There is no
   bypass — do not weaken this gate.
5. **Anthropic API key** (`ANTHROPIC_API_KEY`). This is the serving model.

## Deploy the backend API

The repo is a monorepo (`backend/`, `frontend/`); the Heroku Node.js buildpack
needs a `package.json` at the app root, so the backend deploys as its own app
via **git subtree push**. One concrete method — use it for every deploy:

```bash
# One-time setup
heroku create enflite-ai-api --stack heroku-24
heroku buildpacks:set heroku/nodejs --app enflite-ai-api

# Every deploy (from the repo root, on main)
git subtree push --prefix backend heroku main
```

What happens on Heroku's side, in order: `npm ci` → `npm run build` (tsc +
copies migrations into `dist/`) → **release phase** runs
`npm run migrate:prod` (`backend/Procfile`) against Atlas → the `web` dyno
starts `npm start` (`node dist/src/server.js`). The release phase runs with the
app's config vars, so migrations can reach MongoDB. If the release phase fails,
the deploy is rejected and the old dynos keep serving.

The backend reads `PORT` from the environment and binds `0.0.0.0`; Heroku sets
`PORT` automatically. App entry points live at the subtree root:
`backend/Procfile`, `backend/app.json`.

Set the config vars (or fill them in when the Heroku Button prompts via
`app.json` — secrets are marked required, `JWT_SECRET` auto-generates):

| Var | Secret? | Value |
|---|---|---|
| `NODE_ENV` | no | `production` |
| `COOKIE_SECURE` | no | `true` (boot refuses otherwise in production) |
| `OLLAMA_ENABLED` | no | `false` — keep off for the Claude-only launch |
| `MONGODB_URI` | **yes** | Atlas connection string |
| `JWT_SECRET` | **yes** | generated, ≥ 32 chars (placeholders are refused at boot) |
| `ANTHROPIC_API_KEY` | **yes** | Anthropic key |
| `CORS_ORIGIN` | no | exact `https://` URL of the frontend app — no wildcards (config validation rejects them) |
| `OBJECT_STORAGE_ENDPOINT` | no | e.g. `https://s3.us-east-1.amazonaws.com` |
| `OBJECT_STORAGE_BUCKET` | no | `enflite-ai-documents` |
| `OBJECT_STORAGE_REGION` | no | `us-east-1` |
| `OBJECT_STORAGE_ACCESS_KEY` | **yes** | storage key |
| `OBJECT_STORAGE_SECRET_KEY` | **yes** | storage secret |
| `OBJECT_STORAGE_FORCE_PATH_STYLE` | no | `false` for AWS S3, `true` for MinIO-style |
| `MALWARE_SCAN_MODE` | no | `http` (only accepted value in production) |
| `MALWARE_SCANNER_ENDPOINT` | no* | scanner URL, e.g. `https://scanner.example.com/scan` (*not a secret key, but keep it private) |

Verify: `heroku open --app enflite-ai-api` → `/health` should answer; `/ready`
reports database, object storage, and embeddings checks (embeddings shows
`disabled` while Ollama is off — non-critical, chat is unaffected).

## Deploy the frontend

The frontend is a static SPA served by `heroku-buildpack-static`
(`frontend/static.json` routes every path to `index.html`; hashed assets get
immutable caching). **Vite bakes `VITE_API_BASE_URL` in at build time**, so
deploy the backend first, then point the frontend at its URL:

```bash
# One-time setup
heroku create enflite-ai-web --stack heroku-24
heroku buildpacks:set heroku/nodejs --app enflite-ai-web
heroku buildpacks:add https://github.com/heroku/heroku-buildpack-static --app enflite-ai-web
heroku config:set VITE_API_BASE_URL=https://enflite-ai-api-abc123.herokuapp.com/api/v1 --app enflite-ai-web

# Every deploy (from the repo root, on main)
git subtree push --prefix frontend heroku-frontend main
# (add a second remote: heroku git:remote --app enflite-ai-web --remote heroku-frontend)
```

The Node.js buildpack runs `npm ci` + `npm run build` (reading
`VITE_API_BASE_URL` from config vars), then the static buildpack serves `dist/`
per `static.json`. To repoint the API URL later, set the config var and redeploy
— a rebuild is required.

Then set the backend's `CORS_ORIGIN` to the frontend's Heroku URL and redeploy
the backend (or just restart it — config vars don't need a rebuild for the API).

## Document search on Heroku (optional)

With `OLLAMA_ENABLED=false` and the default `EMBEDDING_PROVIDER=ollama`,
embedding/indexing operations fail with a clear error: chat works, but document
uploads cannot be embedded for RAG. To get document search on Heroku, use an
OpenAI-compatible embedding endpoint (1536 dimensions — the production boot
guard requires exactly 1536):

```bash
heroku config:set EMBEDDING_PROVIDER=openai-compatible \
  EMBEDDING_BASE_URL=https://api.openai.com/v1 \
  EMBEDDING_MODEL=text-embedding-3-small \
  EMBEDDING_API_KEY=<redacted> \
  --app enflite-ai-api
```

Warning: switching embedding providers on an
existing deployment invalidates previously ingested chunks — re-ingest documents
afterwards.

## Gotchas

- **Dyno sleeping.** Eco/dyno sleeping puts the API to sleep after inactivity;
  the first chat of the day then waits through a cold start plus the MongoDB
  reconnect. Run the API on a dyno type that doesn't sleep (`basic` or better,
  declared in `backend/app.json`).
- **Ephemeral filesystem.** Anything written to local disk vanishes on dyno
  restart or redeploy:
  - Repo code indexing clones into `REPO_WORKDIR` (`/data/repos` default). The
    indexed chunks live in MongoDB and survive, but a restart forces a re-clone
    on the next sync. Acceptable for now; a persistent add-on volume is the
    future fix.
  - `syteline.form_*` projects are written under `SYTELINE_FORM_PROJECTS_DIR`
    (default `./form-projects`) — download generated projects promptly.
  - Document bytes are safe: they go to S3, never local disk.
- **Release phase runs migrations.** It is idempotent (`schema_migrations`
  tracks applied versions); re-running a green deploy is safe.
- **Log drains, not files.** `heroku logs --tail --app enflite-ai-api` for
  output; add a logging add-on for retention.
- **Scaling.** Start with one `web` dyno. The in-process rate/concurrency
  limiters are per-dyno; if you scale past one dyno, front the app with a shared
  limiter (see `docs/deployment.md`).
- **Ollama later.** When the Ollama host exists, set `OLLAMA_ENABLED=true` and
  `OLLAMA_BASE_URL` — no code deploy needed, just config vars and a restart.
  The privacy router's fail-closed behavior is unchanged.
