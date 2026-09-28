# ADR-018: One-tap provider switching (Enflite | Claude | OpenAI)

**Status:** Accepted

## Context

The platform shipped Ollama-first (PR #29): local models are the default,
and the UI showed raw provider kinds and registry IDs. The owner asked for
first-class API wrappers with dead-simple switching between Claude, OpenAI,
and local Ollama — the last branded **Enflite** in the UI — with the switcher
obvious in the chat UI, not buried in settings.

Two product constraints shape the design:

1. **Data residency must be honest.** Enflite keeps prompts on the
   operator's infrastructure; Claude/OpenAI send them to third-party clouds.
   The switcher itself has to make that visible at the moment of choice.
2. **Switching must be one tap.** No settings digging, no dead buttons, no
   raw IDs like `meta-llama/Meta-Llama-3.1-8B-Instruct` in the UI.

## Decision

- **Three user-facing provider groups** (`providerDisplay.ts`):
  `enflite` (everything served from infrastructure the server controls —
  Ollama first, plus vLLM / self-hosted OpenAI-compatible endpoints),
  `claude`, `openai`. Registry kinds stay technical; **"Ollama" never
  appears in user-facing strings**. Each group carries a data-residency
  note shown on the switcher ("Stays on your network" / "Sent to
  Anthropic" / "Sent to OpenAI").
- **New providers**: `ClaudeProvider` (Anthropic Messages API, streaming
  SSE, tool_use assembly, base64 image blocks) and `OpenAIProvider`
  (subclasses the tested `OpenAICompatibleProvider` wire protocol so there
  is one implementation; exists as a named kind with its own endpoint
  default and key). Both constructed with explicit params, never reading
  env — the gateway authorizes before the factory builds them.
- **Keys**: `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` (plus `_BASE_URL` and
  `CLAUDE_ENABLED` / `OPENAI_ENABLED`). Never logged, never returned by
  any API, never interpolated into errors. `GET /providers` reports only
  presence (`configured`/`enabled`) plus an admin hint for unconfigured
  providers.
- **Cloud model seeds** (ensure-on-read, `modelRegistry.ts`): Claude Sonnet
  4, GPT-4o, GPT-4o Mini. Inserted only when the key is set and the
  endpoint origin is on `AI_PROVIDER_ALLOWED_ORIGINS` — a locked-down
  egress config never gains cloud models from this path. Seeds are
  default-open within the tenant (same pattern as the vision default,
  PR #34/#37) so switching is one tap, but **classification caps at
  INTERNAL**: CONFIDENTIAL and above require an explicit admin widening,
  because prompts leave the operator's infrastructure. Explicit revocation
  via `model_access` works as for defaults.
- **Provider-aware routing**: image turns resolve the vision model for the
  *active* provider group (`resolveVisionModelForGroup`) — Claude Sonnet 4
  on Claude, GPT-4o on OpenAI, qwen2.5vl:7b on Enflite — falling back to
  the Enflite vision model with a user-visible notice, never silently.
  Text-only models never receive image payloads (unchanged from ADR-017).
- **Frontend**: a segmented `Enflite | Claude | OpenAI` control in the chat
  header, next to the model picker. Switching swaps the model list to the
  provider's models and auto-selects the provider's preferred model
  (`isProviderDefault`); the selection persists across reloads. Friendly
  display names everywhere (`displayNameForModel`, curated table +
  prettifier fallback) — raw registry IDs never reach the UI.
- **Mascot**: the assistant avatar is now the Enflite assistant mascot
  (`frontend/public/enflite-assistant.png`) instead of the red "AI" circle.

## Consequences

- Cloud inference is mock-validated in CI; live Claude/OpenAI validation
  requires a real key and is labeled accordingly — the code never needs a
  key to be tested.
- Adding a future provider = new `ChatProvider` subclass + registry kind +
  group mapping + seed spec; the switcher renders whatever `/providers`
  returns.
- Admins opting into cloud models accept third-party data residency; the
  UI, the INTERNAL cap, and the docs make that explicit rather than
  implied.
