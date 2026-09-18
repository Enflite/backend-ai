# ADR-002: No large AI frameworks

**Status:** Accepted

## Context

LangChain, LlamaIndex, CrewAI, AutoGen and similar frameworks promise faster
development but hide control flow, prompt construction, and authorization
inside opaque abstractions — exactly where this platform needs explicit,
auditable behavior. Verified: no such dependency exists in
`backend/package.json` or `frontend/package.json`.

## Decision

Do not introduce a large AI framework. Build on explicit, small, testable
code: the gateway (`backend/src/ai/gateway/`), the RAG pipeline
(`backend/src/rag/`), and the tool loop (`backend/src/chat/`) are
hand-written modules with deterministic behavior.

## Consequences

- Every authorization check, prompt assembly step, and tool invocation is
  visible in the source and unit-testable.
- A framework may only be introduced with a demonstrated technical reason and
  a new ADR justifying it; popularity is not a reason.
- More code is written by hand; that cost is accepted in exchange for
  auditability.
