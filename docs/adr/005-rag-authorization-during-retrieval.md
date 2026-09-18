# ADR-005: RAG authorization applied during retrieval

**Status:** Accepted

## Context

Filtering retrieved chunks *after* a vector search is both wasteful and
dangerous: it leaks relevance signals, complicates the security argument, and
invites bypasses when ranking or truncation happens before the filter.

## Decision

- Tenant, classification, and permission filtering happen **inside the
  retrieval SQL** (`backend/src/rag/retrieval.ts`): `tenant_id = $1`,
  classification allowlist derived from the caller's clearance (`UNKNOWN`
  fails closed), and `document_permissions` checks joined in the same query.
- The hybrid score (85% vector cosine + 15% lexical overlap) runs only over
  already-authorized candidates.
- The external reranker hook (`setReranker`) runs **after** authorization and
  **before** the similarity threshold: it may reorder, never widen access.
  Its outputs are untrusted — every result is reconstructed from the
  canonical authorized candidate map by `chunkId`; text, document, and
  citation fields from the reranker are discarded.

## Consequences

- Cross-tenant retrieval is impossible by construction, not by convention.
- A compromised or buggy reranker can at worst reorder results, never leak
  unauthorized content.
- Retrieval tests must cover tenant isolation, classification enforcement,
  and reranker-output sanitization (see `retrievalSecurity.test.ts`).
