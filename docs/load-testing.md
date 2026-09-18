# Load testing

The harness is `backend/scripts/load-test.mjs` — stdlib only (no k6, no new
npm packages). It spins up a mock OpenAI-compatible chat provider and a mock
SyteLine API as in-process HTTP servers, boots the real backend against
them, provisions a dev user and an `ACTIVE` mock model through the public
API (including the seed-eval promotion gate), then runs scenarios and
reports latency/error statistics with SLO verdicts.

## Stated SLOs

- **p95 time-to-first-token < 2000ms** on the mock provider. The mock answers
  with ~120ms TTFB, so this SLO guards *server-side* queuing and regressions,
  not provider speed — real providers are 5–50x slower. Re-baseline against
  staging with the real provider before treating 2s as a production number.
- **0% HTTP 5xx under burst load.** Overload must surface as 429 (with
  `Retry-After`), never as 500.
- **429s are graceful, not failures.** They are counted and reported
  separately from the error rate.
- `/metrics` exposes the RED series and `/ready` reports per-dependency
  status after every run (asserted by the harness).

## The CI smoke test

```bash
cd backend
npm run loadtest:smoke   # node scripts/load-test.mjs --scenario smoke
```

Requirements: a migrated Postgres reachable at `DATABASE_URL` (default
`postgres://postgres:postgres@localhost:5432/ai_test`) and `JWT_SECRET`
(>= 32 chars). The smoke run takes ~60–90s wall-clock (server boot,
provisioning, seed eval) plus ~30s of load:

1. steady chat — 2 rps for 20s
2. burst chat — 1 wave of 8 concurrent (exceeds the per-user cap of 5, so
   expect some graceful 429s)
3. concurrent tool calls — 20 executions at 5 concurrency

Exit code 0 when every SLO passes, 1 otherwise.

**What the smoke test proves:** the harness works end to end (mock
provider SSE parsing, provisioning, lifecycle, metrics/ready assertions)
and the server holds its SLOs on a small scale. It does **not** prove
production capacity — see "Full-scale staging procedure".

### Measured smoke results (local dev machine, mock provider)

| Scenario | p50 TTFB | p95 TTFB | p95 latency | 5xx | 429s |
|---|---|---|---|---|---|
| steady chat (40 req) | 138ms | 146ms | 305ms | 0 | 0 |
| burst chat (8 conc.) | 251ms | 260ms | 428ms | 0 | 3 (graceful, per-user cap) |
| tools (20 exec) | n/a | n/a | 99ms | 0 | 0 |

All SLOs passed. These numbers are a harness baseline, not a capacity
claim: the mock provider answers in ~120ms with a 6-token canned response,
so they mostly measure server overhead (auth, DB, SSE framing).

## Other scenarios

```bash
# Sustained throughput: 5 rps for 60s
node scripts/load-test.mjs --scenario steady --rps 5 --duration-sec 60

# Burst: 3 waves of 20 concurrent chat turns
node scripts/load-test.mjs --scenario burst --concurrency 20 --waves 3

# Tool-call concurrency: 100 executions at 10 concurrent
node scripts/load-test.mjs --scenario tools --concurrency 10 --total 100

# Everything, with custom mock latency and SLO threshold
node scripts/load-test.mjs --scenario all --mock-ttfb-ms 800 --slo-ttfb-p95-ms 3000
```

Point at an already-running server (skips boot + provisioning):

```bash
node scripts/load-test.mjs --scenario smoke \
  --base-url http://localhost:8080 --skip-setup
# requires LOADTEST_TOKEN (Bearer token for an admin-capable session)
```

### How the mock provider behaves

- `POST /v1/chat/completions` → SSE stream: first content token after
  `--mock-ttfb-ms` (default 120ms), a few 25ms-spaced chunks, then a usage
  frame and `data: [DONE]`.
- If the user message contains `LOADTEST_FAIL`, it returns HTTP 500 — the
  harness has no scenario for this yet; it exists so future error-path
  scenarios can force provider failures.
- `GET /v1/models` → a minimal model list (also usable as an embedding-ping
  target).

### Harness environment

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | `postgres://postgres:postgres@localhost:5432/ai_test` | must be migrated |
| `JWT_SECRET` | dev-only fixed secret | never production |
| `LOADTEST_EMAIL` / `LOADTEST_PASSWORD` | `loadtest@example.com` / random | dev user (created/updated idempotently) |
| `LOADTEST_PORT` | 18080 | backend port; pre-flight fails fast if occupied |
| `LOADTEST_TOKEN` | — | required with `--skip-setup` |

The spawned server runs with `DEV_AUTH_ENABLED=true`,
`CHAT_RATE_LIMIT_PER_MIN=1000`, `TOOL_RATE_LIMIT_PER_MIN=5000` (raised so
the steady scenario measures server throughput rather than the limiter),
and the mock origins allowlisted. Concurrency caps stay at defaults so
burst scenarios still exercise graceful 429s. `SYTELINE_BASE_URL` points at
the in-process mock so tool calls succeed end to end.

Provisioning notes: the model is registered fresh each run
(`loadtest-mock-<pid>-<ts>`) because endpoints are immutable and the mock
gets a new port per run; it walks the full lifecycle to `ACTIVE`, running
the scripted 16-case seed eval suite (`POST /admin/eval/runs`,
`seed: true`, provider recorded as `mock`) to satisfy the promotion gate,
then sets the `chat` serving default and grants the role `model_access`
via a temp tsx helper (no admin API exists for that grant).

## Full-scale staging procedure

The smoke test validates the harness, not capacity. For a staging
capacity run:

1. **Environment:** deploy the staging stack (Postgres 16 + pgvector,
   S3-compatible storage, real vLLM/OpenAI-compatible provider, malware
   scanner in `http` mode). Run migrations.
2. **Baseline first:** run the smoke scenario against staging to confirm
   the harness and observability work there (`/metrics` scrape, `/ready`
   200, Grafana dashboards if wired).
3. **Scale the knobs:** raise `--rps` / `--duration-sec` / `--concurrency`
   toward expected peak. Keep `--mock-ttfb-ms` out of it — point the model
   registry at the real provider instead and re-baseline the TTFB SLO
   (expect seconds, not milliseconds).
4. **Watch the RED series during the run:** `http_requests_total` by
   status class, `chat_time_to_first_token_seconds` p95,
   `ingestion_jobs_total` by outcome. Alert on any 5xx; 429s should stay
   proportional to offered load above the caps.
5. **Find the knee:** increase concurrency until p95 TTFB degrades or 429s
   dominate — that is the per-instance capacity. Scale instances to
   `peak / per-instance-capacity` with headroom, remembering that the
   in-process rate/concurrency caps multiply by instance count (see
   `docs/scale.md`).
6. **Soak:** run the steady scenario for 30+ minutes to catch leaks
   (memory, DB connections, SSE stream tracking).
7. **Record** the numbers, the instance shape, and the provider latency in
   the run log — numbers without context are not reusable.

**Validation split:** only staging runs with the real provider produce
capacity numbers. CI smoke numbers (above) prove the harness and guard
against regressions in server overhead; they say nothing about how the
system behaves under real inference latency.
