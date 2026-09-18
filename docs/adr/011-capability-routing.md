# ADR-011: Capability routing — the platform picks the model by task

**Status:** Accepted

## Context

The chat API historically let the client name a model (`modelId`), and the UI
exposed a model picker. That is plumbing, not product: users should talk to
the assistant, not shop for models. At the same time, different tasks
genuinely benefit from different models — a multi-step SyteLine investigation
chaining reads across orders, inventory, purchase orders, work orders, and
BOMs wants a model tuned for agentic tool use; a quick general question does
not. Admins already curate per-capability serving defaults
(`model_serving_defaults`), but nothing selected among them by task.

## Decision

When the client does not name a model and the conversation has none pinned,
`POST /chat` classifies the turn by task and serves the admin-configured
model for that capability (`backend/src/ai/routing/`):

- The classifier is **rule-based, not model-based**: deterministic, total
  (every input yields exactly one capability), zero-latency, and explainable
  via ordered reason codes. A model-based router would add latency, cost, and
  a new failure mode to every turn for no behavioral gain.
- Precedence: explicit attached documents → code signals → SyteLine
  investigation language (gated on the `syteline.*` tool offer) → `chat`.
- Fallback chain: capability default → `chat` default → first approved model.
  Unconfigured or ungranted capability defaults fall through; the only hard
  failure is no approved model at all.
- An explicit client `modelId` is honored untouched; a pinned conversation
  model is never re-routed mid-conversation (stable voice).
- The decision is observable, not silent: `MODEL_ROUTED` audit (capability +
  reason codes only, never user content) and `routing` in the SSE `meta`
  event — except when `ROUTING_ENABLED=false`, which is a true no-op (no
  audit, no pinning).

## What this is not

Routing is **not** a security decision (ADR-004 applies unchanged):
classification only selects among models the caller is already approved to
use. Model approval, tenant grants, classification policy, tool permissions,
and endpoint allowlisting are enforced downstream exactly as before. The
classifier's reason codes name the matched rule, never user content, so they
are safe for audits and SSE.

## Consequences

- The UI no longer needs a model picker (follow-up): it stops sending
  `modelId` and the backend routes.
- Classifier changes are governed by the eval corpus (`routing` category,
  executed against the real classifier): new patterns ship with new cases.
- `ROUTING_ENABLED=false` is the operator escape hatch back to the legacy
  `chat`-default behavior.
