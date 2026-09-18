# ADR-007: Provider abstraction — Ollama for dev only, vLLM for production

**Status:** Accepted

## Context

The platform needs to run against real models in two very different
environments: a developer laptop and private production infrastructure.
Hard-coding either one into the chat path would couple serving to a single
deployment and make the dev loop depend on production hardware.

## Decision

- All model traffic goes through a `ModelProvider` interface
  (`backend/src/ai/gateway/`): chat completions (streaming) and embeddings.
  Call sites never do ad-hoc HTTP to a model endpoint.
- **Ollama is dev-only.** The provider factory refuses to construct the
  `ollama` provider unless `ALLOW_DEV_PROVIDERS` is enabled, and admin route
  handlers label local artifact management "DEV ONLY"
  (`backend/src/ai/gateway/gateway.ts`, `routes.ts`). Ollama is a
  convenience, never a security or business boundary.
- **vLLM is the production path**, reached through its OpenAI-compatible
  API (`backend/src/ai/gateway/vllmProvider.ts`). The gateway talks only to
  allowlisted origins (`AI_PROVIDER_ALLOWED_ORIGINS`, default
  `http://localhost:8000,http://vllm:8000`).
- Embeddings go through the same provider boundary — a dedicated embedding
  endpoint in production, never scattered fetch calls.

## Consequences

- The frontend talks only to the backend AI Gateway, never to vLLM or Ollama
  directly.
- Swapping or adding a provider is a factory change plus config, not a chat
  rewrite.
- Dev can run the full loop on a laptop; production serving decisions
  (which model, which endpoint) are config and admin actions, audited.
