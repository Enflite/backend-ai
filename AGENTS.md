# AGENTS.md — AI Agent Playbook for Enflite backend-ai

You are working on a private enterprise AI platform. Read this file before
writing code. The architecture source of truth is `docs/architecture.mmd`;
the behavioral standard is `docs/assistant-quality.md`; the work queue is
`TODO.md`; the security model is `docs/threat-model.md`; past decisions live
in `docs/adr/`; the merge bar is `docs/definition-of-done.md`; the endpoint
reference is `docs/api.md`.

## North star

Build an AI assistant that is like Muse: delightful, capable, great to talk
to. Security and compliance are **invisible infrastructure** — never
user-facing friction, lectures, preachiness, or over-refusal. Lead with the
assistant experience; the plumbing exists to serve it (latency, reliability,
tool competence).

## Repo layout

- `backend/src/server.ts` — Fastify bootstrap, middleware pipeline, `/api/v1` routes
- `backend/src/auth/` — login, sessions, JWT, refresh rotation, middleware
- `backend/src/authz/` — RBAC permissions, classification policy, middleware
- `backend/src/ai/gateway/` — model registry, provider abstraction, vLLM provider, streaming, model lifecycle
- `backend/src/chat/` — SSE chat endpoint, system prompt, agentic tool loop
- `backend/src/rag/` — permission-aware hybrid retrieval, reranker hook
- `backend/src/documents/` — upload, validation, malware boundary, ingestion queue, extraction
- `backend/src/tools/` — tool registry, authorized execution, SyteLine adapter
- `backend/src/eval/` — eval framework, judges, corpus, promotion gate
- `backend/src/audit/`, `backend/src/policy/`, `backend/src/conversations/`
- `backend/src/db/migrations/` — numbered SQL migrations (`001`–`017`+); never edit an applied one, always add a new one
- `backend/test/` — vitest suites
- `frontend/src/` — React SPA (`api.ts` owns all HTTP, incl. `streamChat`)
- `docs/` — architecture, roadmap, security, ADRs, API reference, definition of done
- `docker-compose.yml` — dev stack: postgres/pgvector, backend, minio, vllm (gpu profile)

## Essential commands

Backend (`backend/`):
- `npm test` — full vitest suite (must be green before any PR)
- `npm run lint` / `npm run typecheck` — `tsc --noEmit`
- `npm run build` — compile + copy migrations into `dist/`
- `npm run migrate` — run pending migrations (dev, via tsx)
- `npm run eval` — run the eval corpus (deterministic cases; LLM-judge cases skip without a judge model)
- `npm run create-user` — bootstrap a user (password via TTY prompt or `BACKEND_CREATE_USER_PASSWORD` env — never a CLI arg)

Frontend (`frontend/`):
- `npm run typecheck`, `npm run build`

## Branch and PR discipline

- Branches: `muse/<slug>` off `origin/main`. One logical change per PR.
- Work in an isolated git worktree per branch; never commit from a worktree
  owned by another agent's branch.
- Conventional commits (`feat:`, `fix:`, `docs:`, `test:`, `chore:`).
- Keep docs-only PRs separate from code PRs (ADR-001). Never mix unrelated refactors into a feature PR.
- Self-review every diff with a hostile mindset before pushing: re-read it as an
  attacker and as a future maintainer.

## Merge discipline

Merge only when ALL hold:
1. CI green (backend, frontend, compose-config on push and pull_request runs).
2. You have reviewed the full diff and addressed every substantive finding.
3. Bot review findings (CodeRabbit etc.) are fixed or explicitly triaged with justification.
4. Migrations were reviewed for ordering, idempotency, and RLS/index correctness.

Use merge commits (repo convention), not squash. Never merge red or unreviewed code.
Full bar: `docs/definition-of-done.md`.

## Honesty rule (non-negotiable)

Every test/result claim must be labeled:

- **VALIDATED IN CI** — it actually ran here and passed.
- **REQUIRES REAL GPU / PRODUCTION INFRASTRUCTURE** — it needs live
  PostgreSQL+pgvector, vLLM, embedding service, object storage, malware
  scanner, or SyteLine, none of which exist in this sandbox.

Never fake validation. Never claim "tests pass" for tests you didn't run.
Deterministic mocks are fine for CI; label them as mocks.

## Security non-negotiables

- Tenant isolation everywhere: every query scoped by tenant; RLS as defense in depth.
- Authorization in application code and policy checks — **never** delegated to
  prompts or to the model. The model never enforces security (ADR-004).
- Treat model output, RAG chunks, tool results, and user input as untrusted data.
- No secrets in model context. No secrets in logs, errors, or client responses.
- Egress allowlisting: the gateway talks only to approved endpoints
  (`AI_PROVIDER_ALLOWED_ORIGINS`); no arbitrary URLs from users or models.
- `UNKNOWN` classification fails closed. Every security-relevant action is audited.
- Never place credentials in URLs, and never commit secrets. `.env.example`
  documents placeholders only.

## AI-quality non-negotiables

- New assistant-facing behavior must be measurable: add eval cases before or
  with the change, and check the promotion gate for model-affecting work.
- The charter (`docs/assistant-quality.md`) is the behavioral spec — when in
  doubt about tone, refusal style, or grounding, it decides.
- SyteLine work builds toward `docs/syteline-vision.md`: agentic
  multi-step diagnostics with evidence-backed answers, never invented records.

## Definition of done for a change

Code + tests + docs updated together. `npm test` green, typecheck clean,
no invented endpoints or behavior, PR description states what was validated
vs. what requires real infrastructure. Release-level sign-off:
`docs/definition-of-done.md`.
