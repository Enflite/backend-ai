# Enflite AI — private AI platform

Enflite's private, self-hosted AI chat platform — think ChatGPT, but running entirely on our own infrastructure. It talks to models we control (Ollama by default), keeps every tenant's data isolated, and plugs into SyteLine and internal documents.

This guide takes you from a fresh Windows machine to a running app in the browser. PowerShell is the primary path; macOS/Linux notes are included where commands differ.

## 1. What to install first

Work top to bottom. Check each one off before moving on.

- [ ] **Git** — https://git-scm.com/download/win (macOS/Linux: https://git-scm.com/downloads)
- [ ] **Node.js 22 LTS** — https://nodejs.org/en/download (the repo requires Node ≥ 20.12; 22 matches the repo's pinned toolchain)
- [ ] **Docker Desktop** — https://www.docker.com/products/docker-desktop/ (start it after installing; on Windows it uses the WSL2 backend)
- [ ] **pnpm** — in PowerShell: `npm install -g pnpm` (the frontend uses pnpm; the backend uses npm)
- [ ] **Ollama** — handled automatically in Step 3 below via Docker. Prefer it natively on Windows? Run `backend/scripts/setup-ollama-windows.ps1` in an elevated PowerShell instead (manual fallback: https://ollama.com/download)

Verify:

```powershell
git --version
node --version   # v22.x
docker --version
pnpm --version
```

## 2. Start the app locally

The blessed path runs the API and all infrastructure (MongoDB, document storage, Ollama) in Docker, and the frontend natively. You'll use two terminals: one for Docker, one for the frontend.

**Step 1 — Clone the repo**

```powershell
git clone https://github.com/Enflite/backend-ai.git
cd backend-ai
```

**Step 2 — Start the stack**

```powershell
docker compose up -d --build
```

This starts MongoDB, MinIO (document storage), Ollama (the AI model server), and the backend API. The backend installs its dependencies and runs database migrations automatically on boot. The first run takes several minutes.

Check it's up:

```powershell
docker compose ps
```

Wait until `backend`, `mongodb`, `minio`, and `ollama` all show running (or healthy) before continuing.

**Step 3 — Pull the AI models**

Ollama needs the actual model weights before the app can do anything useful.
All three models below are required for full functionality — skip one and the
matching feature fails. This downloads about 10 GB on first run, so grab coffee:

| Model | Purpose | If missing |
|---|---|---|
| `llama3.1:8b` | Chat — every conversation turn runs on this | Chat fails ("Can't reach the AI service") |
| `qwen2.5vl:7b` | Vision — chat turns with attached screenshots or images are routed to it automatically (see `docs/adr/017-vision-model.md`) | Image attachments fail |
| `nomic-embed-text` | Embeddings — document search and RAG over uploaded files | Document search returns nothing |

```powershell
docker compose exec ollama ollama pull llama3.1:8b
docker compose exec ollama ollama pull qwen2.5vl:7b
docker compose exec ollama ollama pull nomic-embed-text
```

Verify all three landed and the server answers:

```powershell
docker compose exec ollama ollama list
curl http://localhost:11434/api/tags
```

The second command should return JSON listing your models. If it doesn't,
Ollama isn't reachable — check `docker compose ps` and the gotchas below.

**Running Ollama natively on Windows instead of Docker?** Install it from
https://ollama.com/download — after install it starts automatically and sits
in the system tray. If it's not running, start it with `ollama serve` in a
terminal (leave that window open). Then either run the setup script, which
installs Ollama if missing, pulls all three models, and verifies:

```powershell
backend/scripts/setup-ollama-windows.ps1   # elevated PowerShell for the install step
```

or do it manually:

```powershell
ollama pull llama3.1:8b
ollama pull qwen2.5vl:7b
ollama pull nomic-embed-text
ollama list
curl http://localhost:11434/api/tags
```

Then point the backend at it with `OLLAMA_BASE_URL=http://localhost:11434`
(in Docker Compose the backend uses `http://ollama:11434`, the Compose
service name — that's only correct inside Compose).

**Step 4 — Create your user**

```powershell
docker compose exec backend npm run create-user -- --email you@enflite.com --role Admin
```

You'll be prompted for a password (typing shows nothing — that's normal). Use `--role Admin` so you can explore admin features; the default role is `User`. If you ever see "No TTY available", run the command directly in an interactive PowerShell window, not from a script.

**Step 5 — Start the frontend** (new terminal)

```powershell
cd frontend
pnpm install --frozen-lockfile
Copy-Item .env.example .env
pnpm dev
```

(`Copy-Item` is PowerShell's copy; macOS/Linux: `cp .env.example .env`.) The `.env` file points the app at the API on `localhost:8080` — it's already correct, no edits needed.

**Step 6 — Open it and verify**

Open http://localhost:8443 in your browser and log in with the email and password from Step 4. Send a chat message like "Hello" — you should get a streaming reply from the local model. That's it: the app is running.

Quick API health check: http://localhost:8080/health should respond.

## AI providers: Enflite, Claude, OpenAI

The chat header has a one-tap provider switcher: **Enflite | Claude | OpenAI**.
Switching swaps the model list to that provider's models — no settings to dig
through. The active provider is always visible on the switcher.

- **Enflite** is this platform's own name for the models it serves itself —
  local Ollama first of all (that's the default, and it needs no key). You
  will never see the word "Ollama" in the app; it's "Enflite" everywhere a
  user looks.
- **Claude** and **OpenAI** are cloud providers. They appear in the switcher
  only after an admin sets their API key (see below); without a key they show
  as disabled with a hint, never as a dead button.

**Data residency — read this before switching.** Enflite keeps your prompts on
your own infrastructure. Selecting Claude or OpenAI sends your prompts and
attachments to Anthropic's or OpenAI's cloud. The switcher labels each provider
"Local" or "Cloud" so this is visible at the moment you choose. Cloud models are
also capped at the INTERNAL classification by default — an admin must
explicitly widen a cloud model to serve CONFIDENTIAL or above.

**Privacy-aware auto-routing** (see `docs/privacy-routing.md`). When Claude is
configured, turns without an explicit provider choice are scanned for
sensitive data *after the full prompt is assembled* — history, retrieved
document chunks, tool results, memory, PII. Anything touching customer,
finance, or proprietary data stays on local Enflite (even overriding a
manual Claude pick, with a friendly notice); clean turns go to Claude
automatically. Repo source code stays Claude-routable by default (explicit,
flippable tenant flag). Web access follows the same boundary:
Claude-routed turns get Claude's built-in web search, sensitive turns stay
local and offline. Admins can adjust the enforced categories or disable
auto-routing per tenant (`PUT /admin/privacy-routing`).

**Adding cloud keys** (admin / operator). Set these in the backend environment
(or your secret manager), then restart the backend:

```powershell
ANTHROPIC_API_KEY=<redacted>   # enables Claude in the switcher
OPENAI_API_KEY=<redacted>          # enables OpenAI in the switcher
# Optional: CLAUDE_ENABLED=false / OPENAI_ENABLED=false to hide a provider
# even when its key is set. Custom endpoints: ANTHROPIC_BASE_URL, OPENAI_BASE_URL.
```

Keys travel only in the provider API request headers. They are never logged,
never returned by any API (the `/providers` endpoint reports only whether a
provider is configured), and never appear in error messages. Image turns stay
on your active provider when it has a vision-capable model — Claude uses Claude
Sonnet 4, OpenAI uses GPT-4o, Enflite uses the local vision model — and the app
always tells you which model is reading your images, never silently.

See `docs/adr/018-provider-switching.md` for the design.

## 3. Common gotchas

- **Docker Desktop isn't running** — `docker compose` fails with a cryptic error. Start Docker Desktop first and wait for it to finish booting.
- **A port is already in use** — the stack needs 8080 (API), 8443 (frontend), 27017 (MongoDB), 9000/9001 (storage), 11434 (Ollama). The frontend refuses to start on any other port, so free up 8443 rather than working around it.
- **Chat fails but login works** — you skipped Step 3 or one of the three models is missing. The app now says "Can't reach the AI service (Ollama) at …" and names the URL it's trying. Run `docker compose exec ollama ollama list` and compare against the Step 3 table; also check the backend logs for `OLLAMA_UNREACHABLE`.
- **Native backend chats hit the wrong Ollama URL** — older installs seeded the model registry with the docker URL (`http://ollama:11434`), which a native backend can't reach. The app now self-heals this: on read, a model still pointing at the docker URL is repointed to your configured `OLLAMA_BASE_URL` automatically (admin-customized endpoints are never touched). If you patched your database by hand before, nothing further is needed.
- **Backend dependency changes need a rebuild** — editing backend code hot-reloads fine (it's volume-mounted), but if you change `backend/package.json` dependencies, run `docker compose up -d --build` again.
- **Migrations** — the Docker backend runs `npm run migrate` automatically on boot. If you ever run the backend natively (`cd backend; npm ci; npm run migrate; npm run dev`), run `npm run migrate` yourself after pulling new code.
- **Slow first chat response** — normal. The model loads into memory on first use; subsequent messages are faster.
- **Starting over** — `docker compose down -v` wipes everything including the database and downloaded models (you'll need to re-run Steps 2–4). Without `-v`, your data and models survive restarts.

## 4. Where to go next

- `docs/architecture.mmd` — system architecture diagram (source of truth)
- `docs/api.md` — API endpoint reference
- `docs/assistant-quality.md` — how the assistant should behave (the product spec)
- `docs/development.md` — deeper dev notes (native backend, embeddings, validation commands)
- `docs/deployment.md` — how this gets deployed beyond your laptop
- `AGENTS.md` — repo playbook: branch/PR discipline, merge bar, honesty rules (read before your first PR)
