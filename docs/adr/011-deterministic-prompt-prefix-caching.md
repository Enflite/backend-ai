# ADR-011: Deterministic prompt-prefix contract for vLLM prefix caching

**Status:** Accepted

## Context

Every chat turn rebuilds a large static prefix: the charter system prompt
(`backend/src/chat/systemPrompt.ts`, ~6 KB) plus, on SyteLine turns, the
domain-expertise knowledge pack (`backend/src/chat/sytelineExpertKnowledge.ts`,
~7 KB). vLLM's automatic prefix caching reuses KV-cache blocks server-side
whenever a request's token prefix is byte-identical to a previously seen
prefix — no client configuration needed (the V1 engine enables it by
default). That reuse only happens if our side actually sends byte-stable
prefixes: a single per-turn dynamic value (timestamp, request ID, model name
interpolated mid-prompt) silently fragments the cache into one block set per
turn and the hit rate collapses to zero.

Before this ADR the system prompt *happened* to be byte-stable per
model+capability variant (the builder is pure), but nothing enforced it, the
per-model identity line sat at the very start of the prompt (so two models
shared no prefix at all), and operators had no way to tell which prefix a
request carried.

## Decision

- **Static head first, dynamic tail after.** `buildSystemPrompt` now emits
  the byte-stable static head (`buildStaticPromptHead`: assistant identity +
  the charter behavioral spec, invariant across models, turns, and
  capabilities) followed by the per-turn dynamic tail (serving-model
  identity, tool guidance, SyteLine pack, coding guidance). Same sentences as
  before, reordered — prompt *content* is unchanged, only the layout moved
  (system prompt version bumped 2.4.0 → 2.5.0).
- **Contract module** `backend/src/ai/gateway/prefixCache.ts`: the chat route
  assembles turn prompts via `buildCacheableSystemPrompt`, which asserts the
  assembled text starts with the static head (`assertStaticPrefix`, fails
  fast on a layout bug instead of silently fragmenting the cache) and
  exposes the prompt's SHA-256 hash.
- **Telemetry, not invented metrics.** The gateway records `prefixHash` +
  heuristic `promptTokens` in the per-request `GatewayTelemetry` and the
  `MODEL_USED` audit event metadata, so operators can group requests by
  prefix. Actual hit/miss rates come from the vLLM server's `/metrics`
  endpoint (`vllm:prefix_cache_hit_rate`, or
  `vllm:prefix_cache_hits_total` / `vllm:prefix_cache_queries_total`
  counters on newer V1 builds) — we surface those as operator guidance in
  `docs/inference.md`, never as numbers we compute ourselves.
- **Kill switch.** `PROMPT_CACHE_ENABLED` (default `true`) governs the
  client-side contract and telemetry only; vLLM's server-side caching is
  automatic and unaffected by it. When `false`, prompts assemble the legacy
  way with no assertion and no telemetry. Model-visible content is identical
  either way.
- **Provider parity preserved.** The gateway still assembles one message
  list and passes it untouched to whichever provider the factory resolves —
  vLLM and Ollama receive byte-identical messages (existing parity test
  still green).

## Consequences

- The static head (~6 KB) is now shared across every request regardless of
  model or capability variant; SyteLine turns additionally share the
  knowledge-pack tail across SyteLine turns. Multi-turn conversations extend
  the cached prefix with history, as before.
- Tenant isolation is preserved: the static head contains no tenant data by
  construction (the builder accepts only tenant-safe metadata), and a
  prefix-cache hit requires a byte-identical token prefix, so one tenant's
  history cannot produce a hit for another tenant's different bytes.
- Any future edit that interpolates a dynamic value into the static head
  breaks `assertStaticPrefix` in tests and at request time — the failure is
  loud, not a silent hit-rate regression.
- Live cache-hit validation REQUIRES REAL GPU/PRODUCTION INFRASTRUCTURE:
  CI covers the byte-stability contract with mocks; only a real vLLM
  deployment can confirm hit rates via `/metrics`.
