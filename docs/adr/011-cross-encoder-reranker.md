# ADR-011: HTTP cross-encoder reranker, fail-open and default-off

**Status:** Accepted

## Context

Hybrid retrieval (85% vector cosine + 15% lexical overlap, MMR-lite diversity)
ranks by surface similarity: an embedding puts "related" chunks near the query,
but it cannot do the fine-grained query-document relevance judgment a
cross-encoder can — the encoder sees the query and each document *together* and
scores true relevance. The retrieval pipeline already anticipated this: the
`Reranker` hook in `backend/src/rag/retrieval.ts` runs after authorization
filtering and before the similarity threshold, and its output is untrusted
(every result is reconstructed from the canonical authorized candidate map by
`chunkId`; see ADR-005). Until now the only implementation was the passthrough
that preserves hybrid order.

## Decision

- Ship a real reranker behind the existing hook:
  `backend/src/rag/crossEncoderReranker.ts` implements `Reranker` as an HTTP
  client that POSTs `{ model, query, documents }` to a configurable scoring
  endpoint and reorders candidates by the returned relevance scores.
- **Default off.** `RERANKER_ENABLED` defaults to `false`; with it unset, the
  passthrough preserves hybrid order and the endpoint is never contacted.
- **Fail-open.** A timeout, HTTP error, malformed response, allowlist denial,
  or missing `RERANKER_URL` returns the hybrid order unchanged — retrieval
  never hard-fails because the reranker is down. Each fallback records
  `reranker_fallbacks_total{reason}` and logs a warning containing only the
  reason (no query text, no chunk content, no URL).
- **Egress allowlist.** The endpoint origin must appear in
  `AI_PROVIDER_ALLOWED_ORIGINS`, the same allowlist the AI gateway enforces
  (`gateway.ts`), not a separate list.
- **No credentials.** The request carries only the query text and already
  permission-filtered chunk texts; no `Authorization` header, tenant ids, or
  user ids are sent.
- **Reorder only.** The reranker proposes validated `[0,1]` scores; candidates
  beyond `RERANKER_TOP_N` (default 10, cost control) keep hybrid order. The
  retrieval.ts reconstruction still discards the reranker's text/document/
  citation fields, so it cannot widen access even if compromised.

## Alternatives considered

- **In-process ONNX cross-encoder.** Eliminates a network hop and a service to
  operate, but pulls a heavy native dependency and model weights into the API
  process and competes with chat turns for CPU. Deferred; the HTTP contract
  keeps the door open for a sidecar later.
- **Fail-closed on reranker errors.** Rejected: a degraded-but-available
  retrieval answer beats a 503 for every chat turn when the scoring service is
  down. The hybrid order is always a safe fallback.

## Consequences

- Operators can enable per deployment via `RERANKER_ENABLED=true` plus
  `RERANKER_URL`; docs/rag.md documents the operator config and endpoint
  contract.
- Actual ranking-quality gains against a real cross-encoder model are
  **REQUIRES REAL INFRASTRUCTURE** — CI validates behavior with mocks only
  (reordering, fallbacks, allowlist, no-widening).
