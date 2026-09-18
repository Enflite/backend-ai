# Scaling story

How the backend scales: the worker model, the concurrency/rate-limit knobs,
the metrics and trace-correlation scheme, how to read `/ready`, and what is
in-process versus shared when you run more than one instance.

## Worker model

The server is a single Node.js process per instance. Inside it:

- **HTTP serving** — Fastify handles API traffic, including long-lived SSE
  chat streams. Each chat turn holds one concurrency slot for the whole
  stream (see below).
- **Ingestion workers** — a dedicated in-process pool
  (`backend/src/documents/queue.ts`, started by `recoverIngestionJobs()` at
  boot) claims pending ingestion jobs round-robin across tenants
  (`INGEST_WORKERS`, default 4). Jobs coordinate through PostgreSQL
  (`document_ingestion_jobs` with claim/compare-and-swap), so the pool is
  safe under multiple instances: each instance runs its own workers and the
  database arbitrates claims. On boot, crashed jobs (stuck in
  `PROCESSING` with an old `locked_at`) are reclaimed; jobs that exhaust
  `INGEST_MAX_ATTEMPTS` become poison (`FAILED/POISON_MESSAGE`, terminal,
  admin requeue only).
- **No separate worker tier** — Phase 4 keeps ingestion in-process. If ingest
  throughput ever needs to scale independently of API traffic, the pool can
  move to dedicated processes later; the DB-backed claim protocol already
  supports it.

## Concurrency and rate-limit config reference

Two layers protect the expensive AI endpoints (full narrative in
`docs/deployment.md` under "Gateway fairness"):

| Knob | Default | Scope | What happens at the cap |
|---|---|---|---|
| `AI_MAX_CONCURRENT_PER_TENANT` | 20 | in-flight chat streams + tool execs, per tenant | 429 `busy` + `Retry-After` |
| `AI_MAX_CONCURRENT_PER_USER` | 5 | in-flight chat streams, per user | 429 `busy` + `Retry-After` |
| `AI_MAX_CONCURRENT_TOOLS_PER_USER` | 10 | in-flight direct tool executions, per user | 429 `busy` + `Retry-After` |
| `CHAT_RATE_LIMIT_PER_MIN` | 30 | sustained POST /chat, per session token | 429 |
| `TOOL_RATE_LIMIT_PER_MIN` | 120 | sustained tool execute, per session token | 429 |
| global per-route default | 300/min | all routes | 429 |
| instance-global ceiling | 3000/min | whole instance | 429 `GLOBAL_RATE_LIMITED` |

Every 429 carries the same friendly body (`{ error: 'busy', ...,
retryAfterSeconds }`) and a `Retry-After` header. **429 is the designed
overload signal — never a 5xx.** Clients should back off and retry; the load
test SLOs treat 429s as graceful, not failures.

## Metrics catalog (`GET /metrics`)

Dependency-free, in-process counters and histograms
(`backend/src/observability/metrics.ts`), exposed as Prometheus text
(`text/plain; version=0.0.4`). Scrape every instance — series are per
process (see "Horizontal scaling" below).

| Metric | Type | Labels | Notes |
|---|---|---|---|
| `http_requests_total` | counter | `method`, `route` (template), `status` (1xx–5xx class) | recorded for every request except `/metrics` itself |
| `http_request_duration_seconds` | histogram | `method`, `route` | full request latency |
| `chat_turns_total` | counter | `model`, `outcome` (`completed`\|`error`\|`rate_limited`\|`aborted`) | one per chat turn |
| `chat_turn_duration_seconds` | histogram | `model` | request → final SSE frame |
| `chat_time_to_first_token_seconds` | histogram | `model` | low-skew buckets (0.05–30s) |
| `retrieval_queries_total` | counter | `outcome` (`hit`\|`empty`\|`error`) | RAG retrieval calls |
| `retrieval_query_duration_seconds` | histogram | — | |
| `ingestion_jobs_total` | counter | `outcome` (`enqueued`\|`processed`\|`failed`\|`quarantined`) | job lifecycle |
| `ingestion_job_duration_seconds` | histogram | `outcome` | terminal outcomes only |
| `eval_runs_total` | counter | `outcome` (`passed`\|`failed`\|`error`) | eval suite runs |
| `eval_run_duration_seconds` | histogram | — | |

Cardinality discipline: `route` uses the Fastify route template
(`/api/v1/chat`), never raw URLs; `model` is the registry model name
(bounded set). Recording helpers (`recordChatTurn`, `recordRetrieval`,
`recordIngestionJob`, `recordEvalRun`) never throw — instrumentation can
never break a request.

**Gating:** no auth in dev/test. In production `/metrics` returns 404 unless
`METRICS_PUBLIC=true` is set explicitly (default: true whenever
`NODE_ENV != production`). Production guidance: scrape over a private
network, or front the endpoint with network policy / reverse-proxy auth —
never expose it to the public internet.

## Trace correlation

Every request carries two identifiers end to end:

- `requestId` — from the inbound `x-request-id` header (validated), or a
  generated UUID.
- `traceId` — from the inbound W3C `traceparent` header's trace-id when
  valid, otherwise a generated 32-hex-char id (`backend/src/requestId.ts`).

Both are echoed as `x-request-id` / `x-trace-id` response headers, and
server.ts rebinds the per-request pino logger as
`req.log.child({ requestId, traceId })` — so **every log line emitted
through `req.log` (routes, AI gateway, providers, tool calls) carries both
fields**. Outbound calls forward the context: the chat gateway receives
`requestId`, tool executions receive it via `runToolCall`'s `requestId`
option, and `buildTraceparent(traceId)` (`observability/traces.ts`)
constructs a W3C `traceparent` value for downstream services to continue
the trace. Correlate across services by `traceId`; drill into a single
request by `requestId`.

Background work (ingestion workers) has no inbound request: it logs the
job's `request_id` from the job row instead.

## Reading `/ready`

`GET /health` is the cheap liveness probe (no dependencies — safe for
high-frequency load-balancer checks). `GET /ready` runs per-dependency
checks with timeouts (`READY_CHECK_TIMEOUT_MS`, default 2000ms) and returns:

```json
{
  "status": "ok",
  "checks": {
    "database":      { "status": "ok", "critical": true, "latencyMs": 1 },
    "objectStorage": { "status": "ok", "critical": true, "latencyMs": 4 },
    "embeddings":    { "status": "ok", "critical": false, "latencyMs": 6, "detail": "http 200" }
  }
}
```

- **200** when every *critical* dependency is `ok`; **503** with
  `"status": "degraded"` when any critical check is not `ok`.
- `database` (critical): `SELECT 1` through the pool.
- `objectStorage` (critical *when configured*): a `HeadBucket` round-trip
  against the configured bucket. Unconfigured endpoint → `not_configured`,
  non-critical (dev state; document features disabled). A 404 means the
  bucket itself is missing — a key-level `HeadObject` probe could not tell
  that apart from a missing probe key.
- `embeddings` (**non-critical**): a token-free ping — `GET /v1/models` on
  OpenAI-compatible providers, `GET /api/tags` on Ollama. A failure
  degrades ingestion/RAG but chat keeps working, so the dependency surfaces
  as `unavailable` in the body without failing the probe. Unconfigured →
  `not_configured`.

Status values: `ok` | `degraded` | `unavailable` | `not_configured`.
Orchestrators should route traffic on 200 and alert on 503; dashboards
should watch `degraded` bodies for early warning.

## Horizontal scaling notes

**In-process (per instance, not shared):** the metrics registry, the
chat/tool concurrency semaphores, and all `@fastify/rate-limit` buckets.
Two consequences:

1. **Scrape every instance** for metrics (or federate); a single instance's
   `/metrics` is a partial view.
2. **Front multi-instance deployments with a shared limiter** (Redis or the
   ingress gateway) if you need a true global cap — the in-process caps
   multiply by instance count. Size provider capacity so the caps stay the
   binding constraint either way.

**Shared via PostgreSQL (safe across instances):** ingestion job claims
(compare-and-swap on `document_ingestion_jobs`), the model registry and
serving defaults, conversations/messages, audit events, and RLS tenant
isolation. Adding instances is safe for all of these; the database
arbitrates.

**Sticky concerns:** SSE chat streams are long-lived on the instance that
accepted them — put a load balancer that tolerates long connections in
front, and drain instances on deploy (the server already ends hijacked SSE
streams on shutdown and bounds the drain with `SHUTDOWN_DRAIN_MS`).

See `docs/load-testing.md` for the harness, SLOs, and the staging
procedure; `docs/deployment.md` for production dependencies and the full
fairness narrative.
