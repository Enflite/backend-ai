# Capability routing (Phase 6)

The user never picks a model. They talk to the assistant; the platform picks
the model **by task**. This document describes the routing design, its
precedence rules, and its fallback chain.

## Why

Exposing model names, versions, and providers in the UI is plumbing, not
product. Different tasks genuinely benefit from different models — a long
agentic SyteLine investigation ("why is this order late?", chaining reads
across orders, inventory, POs, work orders, BOMs) wants a model tuned for
multi-step tool use; a quick general question does not. Capability routing
gives each task the best approved model for it while the user just talks to
"Muse".

## How it works

`POST /chat` resolves the serving model in this order:

1. **Explicit `modelId`** (client-supplied) — honored untouched. For API power
   users; the first-party UI no longer sends one.
2. **Pinned conversation model** — once a conversation has a model, every
   later turn keeps it. No mid-conversation voice changes.
3. **Capability routing** — otherwise, the turn is classified and the serving
   default for that capability is resolved.

The classifier (`backend/src/ai/routing/classifier.ts`) is deliberately
**rule-based, not model-based**: zero added latency, zero cost, zero new
failure modes, total and deterministic (every input yields exactly one
capability), and explainable (ordered reason codes).

### Precedence (first match wins)

| # | Capability | Trigger |
|---|-----------|---------|
| 1 | `rag` | Documents attached for retrieval this turn (`documentIds`). An explicit user action beats all heuristics. |
| 2 | `coding` | Strong code signals: fenced code blocks, stack traces, code file paths, programming keywords/language names. |
| 3 | `syteline` | ERP investigation language — order/item/inventory/PO/work-order/BOM/customer entities plus an investigation verb, an explicit "SyteLine" mention, or a bare order reference. **Requires the caller to be offered `syteline.*` tools** — routing to the ERP capability is pointless without its tools. |
| 4 | `chat` | Default. General conversation and anything unrecognized. |

Notes on the heuristics:

- Code wins over ERP vocabulary ("write a python script that checks SyteLine
  inventory" is a coding task).
- Bare language names are included only when unambiguous in a
  manufacturing/ERP context: `rust` (corrosion) and `swift` (bank transfers)
  are deliberately excluded.
- Everyday "order" language ("I ordered pizza") has no ERP entity and no
  investigation verb, so it stays on `chat`.

### Fallback chain

For the classified capability, resolution tries, in order:

```
capability serving default → 'chat' serving default → first approved model
```

- A capability default the caller is **not granted** falls through to the
  next step (a curation gap, not a turn failure). Other errors propagate.
- With `ROUTING_ENABLED=false` (operator escape hatch, default true), every
  turn resolves the `chat` default — the pre-Phase-6 behavior.
- No approved model at all keeps the existing `NO_APPROVED_MODEL` error.

Serving defaults are admin-curated per tenant+capability
(`PUT /admin/serving-defaults/:capability`, audited). Known capabilities:
`chat`, `syteline`, `coding`, `rag`, `embeddings`.

## Security

Routing makes **no security decision** (ADR-004). Tool permissions, data
classification, model approval, tenant grants, and endpoint allowlisting are
enforced downstream exactly as before — classification only selects among
models the caller is already approved to use. The classifier's reason codes
name the matched rule, never user content.

## Observability

- Audit: `MODEL_ROUTED` with `{ capability, reasons, modelId }`, recorded
  only when routing classified the turn — never when `ROUTING_ENABLED=false`
  (the escape hatch is a true no-op: no audit, no pinning, legacy `chat`
  default served).
- Pinning: a conversation that already has a model keeps it forever. A
  model-less conversation's first routed turn claims the pin with an atomic
  conditional `UPDATE ... WHERE model_id IS NULL RETURNING`; concurrent
  first-turns race the claim and exactly one wins — losers adopt the
  winner's stored model (re-verified against the caller's grants) so
  concurrent streams agree.
- SSE: the `meta` event carries `routing: { capability, reasons }` on routed
  turns, so clients can show (or hide) the decision without model plumbing.
- A conversation created by a routed turn stores the routed model; a
  pre-existing conversation without a pinned model gets it pinned on the
  first routed turn.

## Measuring it

- Unit tests: `backend/test/routing.test.ts` (classifier matrix, router
  fallback chain, route integration).
- Eval corpus: `backend/src/eval/cases/routing.ts` (12 cases, category
  `routing`). `npm run eval` executes the **real classifier** for this
  category via `routingClassifyChatFn` — the corpus pins the contract, the
  implementation proves it.
