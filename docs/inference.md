# Private Inference (Phase 3)

**Purpose.** How the platform talks to models: the provider abstraction, the
local-development topology (Ollama), the production topology (private vLLM),
the embedding boundary, artifact deployment/versioning, and the model
approval lifecycle. Written for engineers extending the platform and
operators deploying models.

**Non-goals.** Prompt design and assistant behavior live in
`docs/assistant-quality.md`. Evaluation and promotion criteria live in
`docs/eval.md`. This document is the plumbing underneath both.

## 1. Design principles

1. **One seam for model I/O.** Application code (gateway, ingestion, RAG
   retrieval) never issues model HTTP directly and never reads provider env
   vars. It resolves a provider from `backend/src/ai/providers/factory.ts`
   and streams/embeds through the `ChatProvider` / `EmbeddingProvider`
   interfaces in `backend/src/ai/providers/types.ts`.
2. **The gateway authorizes; the factory only dials.** Approval status,
   endpoint allowlist, tenant grants, and classification policy are enforced
   in `backend/src/ai/gateway/` *before* a provider is constructed. The
   factory picks the wire protocol — it makes no trust decisions.
3. **No framework magic.** Providers are small hand-written classes (fetch +
   SSE/NDJSON parsing). No LangChain/LlamaIndex-style frameworks: every byte
   on the wire is visible in the source.
4. **Dev is not prod.** Ollama exists so engineers can iterate without GPUs.
   It is refused unless `ALLOW_DEV_PROVIDERS` is explicitly enabled, and it
   must never serve production traffic. See §4.
5. **Streaming inference is never retried.** A retried stream can double-bill
   and double-side-effect. Transient embedding failures *are* retried
   (embeddings are idempotent); a failed stream fails over to another model
   instead — and never after visible output has begun.

## 2. Provider abstraction

```
backend/src/ai/providers/
  types.ts            ChatProvider / EmbeddingProvider / ModelProvider,
                      StreamChatOptions, ProviderEvent, EmbedOptions
  openaiCompatible.ts OpenAI-compatible streaming chat (private vLLM)
  openaiEmbeddings.ts OpenAI-compatible embeddings with bounded retry
  ollama.ts           Ollama chat + embeddings (DEV ONLY)
  factory.ts          resolveChatProvider / resolveEmbeddingProvider
  index.ts            public surface
```

`ProviderEvent` is the single streaming vocabulary the gateway understands:

- `{ type: 'text', content }` — content deltas.
- `{ type: 'tool_call', id, name, arguments }` — `arguments` is the **raw
  JSON string**; the provider never repairs or fabricates it. The gateway
  parses it and records a tool-execution failure on malformed JSON.
- `{ type: 'usage', usage: { promptTokens, completionTokens, totalTokens } }`.

Bounded assembly: tool-call argument buffers are capped (64 KiB) and the
number of tool-call indices per turn is capped (32), so a malicious or
broken upstream cannot force unbounded memory.

`StreamChatOptions` carries `endpoint` + `model` per call (already
allowlisted by the gateway) plus messages, tools, timeouts, and an abort
signal. Timeouts use `AbortSignal.timeout`, composed with the caller's
signal — a hung upstream can never hold a request slot indefinitely.

## 3. Production topology: private vLLM

```
user → frontend → backend AI Gateway → private vLLM cluster (OpenAI-compatible /v1)
```

- The gateway calls vLLM through `OpenAICompatibleProvider` against
  `VLLM_BASE_URL`. An optional `VLLM_API_KEY` is sent as a Bearer token when
  the cluster requires one.
- **Egress allowlist.** Model endpoints are validated against
  `AI_PROVIDER_ALLOWED_ORIGINS` twice: at model *registration* time
  (`assertEndpointAllowed`, exported from the gateway for the admin API) and
  at request time before any fetch. A model can never be registered with —
  or stream from — an endpoint outside the allowlist. No arbitrary URLs,
  ever.
- **Failover, not retry.** Each model record may name a `fallback_model_id`.
  On upstream failure the gateway fails over once to the fallback, which
  must independently satisfy approval, enablement, tenant, classification,
  and capability rules. Failover never happens after visible output began.
- **Telemetry.** Every streamed call records time-to-first-token and
  tokens/second (from first token to usage frame) into the `MODEL_USED`
  audit event — the raw material for latency SLOs in Phase 4.

### Prompt prefix caching

vLLM's automatic prefix caching reuses KV-cache blocks server-side whenever
a request's token prefix is byte-identical to a previously seen one. The V1
engine enables it by default — no server flag needed — so the platform's job
is to *send byte-stable prefixes* and to make them observable. (ADR-011.)

- **What's cached.** Every chat turn sends the system prompt as message
  index 0. The prompt is assembled static-head-first
  (`backend/src/chat/systemPrompt.ts` → `buildStaticPromptHead`: assistant
  identity + charter behavioral spec, invariant across models, turns, and
  capabilities), then the per-turn dynamic tail (serving-model identity, tool
  guidance, the SyteLine knowledge pack on SyteLine turns, coding guidance).
  Anything dynamic goes *after* the static head, never inside it — a
  timestamp or request ID in the head would fragment the cache into one
  block set per turn. History after the system message extends the cached
  prefix naturally across multi-turn conversations.
- **Contract.** The chat route builds turn prompts via
  `buildCacheableSystemPrompt` (`backend/src/ai/gateway/prefixCache.ts`),
  which asserts the assembled text starts with the static head and exposes
  the prompt's SHA-256 hash. A layout bug fails fast instead of silently
  degrading the hit rate. The Ollama dev path receives byte-identical
  messages — the contract is provider-agnostic.
- **Operator config.** `PROMPT_CACHE_ENABLED` (default `true`) governs the
  client-side contract and telemetry only; vLLM's server-side caching is
  automatic and unaffected by it. Set it to `false` to fall back to legacy
  prompt assembly with no assertion and no prefix telemetry. It changes
  prompt ordering, never prompt content.
- **Observing the hit rate.** The gateway records `prefixHash` (SHA-256 of
  the sent system prompt) and heuristic `promptTokens` in the per-request
  telemetry and the `MODEL_USED` audit event metadata, so operators can group
  requests by prefix. The authoritative hit/miss numbers live on the vLLM
  server — query its Prometheus endpoint:

  ```bash
  curl http://localhost:8000/metrics | grep -i prefix_cache
  # vllm:prefix_cache_hit_rate            — current hit-rate gauge, and/or
  # vllm:prefix_cache_hits_total /
  #   vllm:prefix_cache_queries_total     — counters (newer V1 builds)
  ```

  If the hit rate is near zero while traffic shares system prompts, check
  that request prefixes are actually stable: compare the `prefixHash` values
  across recent `MODEL_USED` audit events — distinct hashes per turn mean
  something dynamic leaked into the prefix. We deliberately do not compute
  or report cache statistics client-side; the server's metrics are the
  source of truth.

### Embedding boundary

All embeddings — document ingestion and RAG retrieval — resolve through
`resolveEmbeddingProvider()` and the shared `EmbeddingProvider` interface.
There is exactly one embedding call-site family; no ad-hoc embedding HTTP
exists anywhere else (statically asserted by test).

- Production: `EMBEDDING_PROVIDER=openai-compatible` → vLLM
  `/v1/embeddings` (or any approved OpenAI-compatible endpoint) via
  `OpenAICompatibleEmbeddingProvider`.
- The provider pins `model`/`version`/`dimensions` (the version is stored in
  `document_chunks`, so a re-embed is detectable), validates response
  dimensions, and retries transient 429/5xx with bounded backoff + jitter
  (3 attempts). 4xx surfaces immediately; aborts never retry.

## 4. Development topology: Ollama

```
engineer workstation → backend (ALLOW_DEV_PROVIDERS=true) → Ollama (:11434)
```

- `OllamaProvider` speaks `/api/chat` (NDJSON) and `/api/embeddings`, and
  exposes both sides via `asEmbeddingProvider()`.
- **Hard gates.** The factory refuses to construct Ollama providers unless
  `ALLOW_DEV_PROVIDERS=true`; the artifact helpers (`listLocalModels`,
  `pullLocalModel`) enforce the same guard. The gateway additionally
  rejects `ollama`-backed models outside development.
- **No arbitrary pulls.** `pullLocalModel` only pulls names on the exact
  `OLLAMA_ALLOWED_MODELS` allowlist — no arbitrary model URLs, ever. Pulls
  stream NDJSON progress, surfaced by the admin API as SSE (dev only).
- **Production model deployment is configuration, not application
  behavior.** The platform never downloads weights in production. A
  production model is deployed to the vLLM cluster out-of-band and
  *registered* in the platform with its versioned artifact metadata:
  `source` (URL, origin-allowlisted via `MODEL_SOURCE_ALLOWLIST`),
  `sha256` (pinned), and `license`. See §6.

## 5. Model registry and lifecycle

The `models` table is the platform-wide registry (no `tenant_id`; admin-only
via `model:manage`). A model moves through an explicit state machine —
`backend/src/ai/gateway/modelLifecycle.ts` — and serves traffic only in
`ACTIVE` or `CANARY`:

```
REGISTERED → DOWNLOADING → VALIDATING → EVALUATING → PENDING_APPROVAL
    → APPROVED → CANARY → ACTIVE → DEPRECATED → RETIRED
```

- `DISABLED` is an administrative kill switch (`ACTIVE`/`CANARY`/
  `DEPRECATED` → `DISABLED` → `ACTIVE`); `RETIRED` is terminal.
- **Approval is gated on evaluation.** `PENDING_APPROVAL → APPROVED`
  requires the Phase 2 promotion gate (`getPromotionGate`): a completed
  eval run for the current version with zero P0 failures and no
  grounding/honesty regressions. There is no force/skip flag — failed
  required evals block promotion, period.
- Every transition commits together with its `MODEL_LIFECYCLE_TRANSITION`
  audit event in one transaction; a model can never change state unaudited.
- Admin API (`/admin/models`, `/admin/models/:id/transition`,
  `/admin/serving-defaults/*`, `/admin/models/artifacts/*`): registration
  validates provider, endpoint allowlist, source allowlist, and
  classifications; inference-affecting fields are immutable after
  registration (register a new registry entry for a new version — model
  names are unique, so versions are separate rows); only the enabled toggle
  is directly mutable.
- **Serving defaults.** Admins map tenant+capability → model
  (`model_serving_defaults`, audited). Chat/conversation default-model
  resolution consults the serving default first and re-verifies servability,
  tenant grant, and classification on every resolution — a stale default
  (model deprecated, grant revoked) fails closed, falling back to the
  legacy first-approved model.
- **Capability routing (Phase 6).** Each turn resolves a capability slot
  (`chat | syteline | coding | embeddings`) to its serving default via
  `backend/src/ai/gateway/capabilityRouter.ts`. Per-tenant routing policies
  (`model_routing_policies`: `quality | latency | cost` strategy intent plus
  a `fallback_to_chat` switch) tune the behavior; an unavailable capability
  model falls back to the chat default **before streaming begins** (audited
  once as `MODEL_CAPABILITY_FALLBACK`) unless the tenant disabled fallback,
  in which case the turn fails closed. Full semantics in
  `docs/capabilities.md` §2.

## 6. Artifact deployment and versioning (production runbook)

1. Build/pin the model artifact; publish it to the allowlisted artifact
   origin (`MODEL_SOURCE_ALLOWLIST`).
2. Deploy it to the private vLLM cluster out-of-band (the application does
   not do this).
3. Register it: `POST /admin/models` with `source` (artifact URL),
   `sha256`, `license`, and endpoint (must be in
   `AI_PROVIDER_ALLOWED_ORIGINS`). It enters at `REGISTERED` and serves no
   traffic.
4. Walk it through `DOWNLOADING → VALIDATING → EVALUATING →
   PENDING_APPROVAL` via `POST /admin/models/:id/transition` as each stage
   completes.
5. Approval runs the eval promotion gate automatically; on success the model
   becomes `APPROVED` (still serving nothing).
6. `APPROVED → CANARY`: serve a slice of traffic; watch TTFT/tokens-sec in
   `MODEL_USED` audit events. `CANARY → ACTIVE`: full traffic.
7. To roll back: `ACTIVE → DEPRECATED` (or `DISABLED` for an immediate
   kill), then promote the previous version.

## 7. Configuration reference

| Variable | Purpose | Default |
|---|---|---|
| `VLLM_BASE_URL` | Private vLLM OpenAI-compatible base URL | `http://vllm:8000/v1` |
| `VLLM_API_KEY` | Bearer token for vLLM (if required) | empty |
| `AI_PROVIDER_ALLOWED_ORIGINS` | Egress allowlist for model endpoints | `http://localhost:8000,http://vllm:8000` |
| `AI_REQUEST_TIMEOUT_MS` | Default per-request inference timeout | `120000` |
| `PROMPT_CACHE_ENABLED` | Deterministic prompt-prefix contract + prefix telemetry (vLLM automatic prefix caching) | `true` |
| `EMBEDDING_PROVIDER` | `openai-compatible` \| `ollama` (dev only) | `openai-compatible` |
| `EMBEDDING_BASE_URL` / `EMBEDDING_MODEL` / `EMBEDDING_DIMENSIONS` | Embedding endpoint wiring | unset |
| `EMBEDDING_TIMEOUT_MS` | Embedding request timeout | `30000` |
| `ALLOW_DEV_PROVIDERS` | Master switch for Ollama paths | `false` |
| `OLLAMA_BASE_URL` | Local Ollama endpoint | `http://localhost:11434` |
| `OLLAMA_ALLOWED_MODELS` | Exact allowlist for local pulls | `llama3.1:8b,nomic-embed-text` |
| `MODEL_SOURCE_ALLOWLIST` | Allowed origins for registered artifact sources | `https://huggingface.co` |

## 8. Validation honesty

- `VALIDATED IN CI`: provider wire behavior (SSE/NDJSON parsing, tool-call
  assembly bounds, retry/backoff, timeouts, abort handling), factory gates
  (dev-only refusal, unknown providers, unconfigured embeddings), the
  lifecycle state machine, the promotion gate block, serving-default
  auditing, endpoint/source allowlists, TTFT/tokens-sec telemetry, and the
  prompt prefix-cache contract (byte-stable static head, no dynamic content
  in the cached region, `prefixHash`/`promptTokens` telemetry) —
  all covered by mocked-HTTP unit tests.
- `REQUIRES REAL GPU/PRODUCTION INFRASTRUCTURE`: actual streaming against a
  real vLLM cluster (GPU scheduling, tensor-parallel behavior, real TTFT
  numbers, prefix-cache hit rates via the server's `/metrics`), real Ollama
  model pulls, and end-to-end canary promotion against production traffic. The eval harness (§5 gate) is the mechanism
  that qualifies a model for promotion; CI cannot substitute for it.
