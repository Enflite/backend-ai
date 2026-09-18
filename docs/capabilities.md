# Capability Routing & Advanced AI (Phase 6)

**Purpose.** How the assistant picks the right model for the job, how the
agentic tool loop works as a generalized engine, and how repo-aware coding
answers stay grounded. Written for engineers extending the platform and
operators tuning routing. The product contract — what the assistant can now
*do* — is the point; the plumbing is secondary.

**Non-goals.** Provider mechanics and the model lifecycle live in
`docs/inference.md`. Assistant tone and behavior standards live in
`docs/assistant-quality.md`. Evaluation lives in `docs/eval.md`.

## 1. What Phase 6 changed for the user

Before Phase 6, every turn ran on one tenant serving default. Now the
assistant is capability-aware:

- **Coding questions** route to the tenant's `coding` serving default and
  switch the system prompt into coding mode: claims must ground in the
  files actually shown, changes arrive as unified diffs, and missing files
  are asked for — never guessed at.
- **SyteLine investigations** ("why is this order late?") route to the
  tenant's `syteline` serving default, so the shop-floor brain and the
  general chat brain can be different models.
- **Ordinary chat** keeps the exact resolution it always had: chat serving
  default, then the legacy first-approved model. No behavior change, no
  re-audit, no surprise.
- When the capability model is stale (deprecated, disabled, grant revoked)
  the turn still works: it falls back to the chat default **before
  streaming begins** — audited once — so the user never sees half an answer
  from one model and the rest from another.

None of this is user-facing configuration. Users talk; the router picks.

## 2. Capability slots

Four slots, fixed vocabulary (`KNOWN_CAPABILITIES` in
`backend/src/ai/gateway/modelLifecycle.ts`):

| Capability | Serves | Notes |
|---|---|---|
| `chat` | General conversation | The fallback target; resolution unchanged from Phase 5 |
| `syteline` | ERP investigations | Own serving default; falls back to `chat` per policy |
| `coding` | Code generation, debugging, repo Q&A | Own serving default; enables coding mode prompt |
| `embeddings` | — | Not a chat model. Embedding traffic goes through `resolveEmbeddingProvider` (see `docs/inference.md` §3). A chat turn explicitly asking for `embeddings` is served by the chat default with an honest fallback audit rather than a confusing failure |

Unknown capabilities are rejected with `INVALID_CAPABILITY` — the slot list
is closed, never inferred.

### 2.1 How the capability is chosen for a turn

1. The caller may pass an explicit `capability` in the chat request body
   (validated against the slot list).
2. Otherwise `detectCapability` (`backend/src/chat/capabilityDetect.ts`)
   makes a conservative deterministic guess from the message text:
   - **coding**: code fences, repo paths (`.ts`, `backend/src/...`),
     code verbs aimed at code nouns ("write a function", "as a unified
     diff"). Coding wins ties against SyteLine.
   - **syteline**: ERP nouns ("sales order SO-123", "on hand", "BOM",
     "purchase order") — **only when SyteLine tools are actually offered
     to the caller**. Detection can never grant tool access the caller
     lacks; without the tools, ERP words stay on `chat`.
   - **chat**: everything else.
3. An explicit `modelId` always wins over routing — the operator's choice
   is never second-guessed.

Detection is deliberately conservative: a wrong `chat` costs nothing (the
turn still works), while a wrong `syteline` would strand a turn on a model
with no tools. When in doubt it says `chat`.

### 2.2 Routing policies

Per-tenant, per-capability policies live in `model_routing_policies`
(migration `024_capability_routing.sql`):

- `strategy` — the operator's declared intent: `quality`, `latency`, or
  `cost`. Recorded in policy and audit; the serving default for the
  capability remains the explicit admin choice (set via
  `/admin/serving-defaults/:capability`), which the strategy annotates
  rather than overrides. If you need true scored multi-candidate
  selection, this is the seam to extend — see §6.
- `fallback_to_chat` — when true (the default), an unavailable capability
  model falls back to the chat default; when false, the turn fails closed
  with `NO_APPROVED_MODEL`.

Admin API (all `model:manage`):

- `GET /admin/routing-policies` — list the tenant's policies
- `GET /admin/routing-policies/:capability` — one policy, or the platform
  default (`quality`, fallback on) when unconfigured
- `PUT /admin/routing-policies/:capability` — `{ strategy, fallbackToChat }`,
  audited as `MODEL_ROUTING_POLICY_SET`

Policy changes never bypass model authorization: the resolved model is
re-verified through `getApprovedModelForUser` on every turn, and the
capability default itself must be a servable (ACTIVE/CANARY) model.

### 2.3 Fallback semantics

- Fallback resolves **before the first token streams**. There is no
  mid-stream model switch and no duplicated partial answer.
- Exactly one `MODEL_CAPABILITY_FALLBACK` audit per fallback: capability,
  strategy, reason (never the underlying provider error text), and the
  fallback model id. `chat` itself never audits a fallback — it *is* the
  fallback target.
- The SSE `meta` frame reports `capability: { requested, resolved,
  fallbackUsed, strategy }` so operators can see routing decisions in
  production traces. The user-facing transcript stays clean — routing is
  invisible infrastructure, per the product north star.

## 3. The generalized agentic loop

Phase 5 built the SyteLine diagnostic chain inline in the chat route. Phase 6
extracts it into a reusable engine: `backend/src/chat/agenticLoop.ts`. The
chat route is the first consumer; a repo-index tool family or future
write-capable tools reuse the same budgets, audit, and narration.

The contract:

- **Bounded iterations.** `maxIterations` tool rounds per run (server cap
  `AI_MAX_TOOL_ITERATIONS`). The loop stops cleanly at the budget and says
  so **in the transcript** — a bracketed server notice, persisted and
  streamed, with `finishReason: 'tool_budget'` in the `done` payload. A
  budget cut is never silent.
- **Per-step audit.** Every round writes `AGENTIC_LOOP_STEP`: step index,
  serving model, tool names, **argument keys only** (values can carry PII),
  per-call outcomes, and whether anything was retried. Budget exhaustion
  writes `AGENTIC_LOOP_BUDGET` with the pending calls.
- **Dependent chaining.** Each round's tool results are appended as
  delimited zone-4 tool messages, so later rounds see earlier results —
  the mechanism behind multi-step investigations, for any tool family.
- **Brief plan narration.** Before executing a round, the loop narrates a
  one-line plan through the sink (e.g. "I'll look up sales order SO-123,
  then check availability for its lines."). Deterministic, derived from the
  tool calls — no extra model round-trip, no invented detail. The plan is
  also announced as a `TOOL_PLAN` SSE notice.
- **Approval-gated destructive tools.** The loop **never auto-executes**
  a destructive tool. `approvalFor(toolName)` decides per tool (the chat
  route routes every destructive registry tool through approval);
  unapproved destructive calls are skipped and reported back to the model
  as a `TOOL_REQUIRES_APPROVAL` error so it can explain and ask — the turn
  stays useful instead of dying. A future human-in-the-loop flow can
  pre-approve specific call IDs via `approvedCallIds`; until then,
  write-capable tools stay out of auto-execution by construction.
- **Streaming honesty.** Text flows through the sink as it arrives; a
  `false` return (client gone / too slow) stops the loop. Model failover
  mid-loop switches subsequent rounds to the serving model and re-pins the
  system prompt so it stays honest about who's answering; the gateway
  itself never fails over after visible output began.
- **Error recovery.** Transient tool failures get exactly one retry
  (`runToolCallWithRecovery`); every outcome — success or sanitized error
  — is fed back to the model, so a failed tool never dead-ends the turn.

The sink abstraction (`AgenticLoopSink`: `text`, `plan`, `toolCalls`,
`failover`, `done`, `error`) keeps the loop transport-agnostic and
unit-testable without SSE.

## 4. Repo-aware coding

`POST /chat` accepts `codeFiles: [{ path, content }]` — caller-supplied,
repo-relative files (the client or IDE plugin attaches them; the server
**never** reads the filesystem on the model's behalf, and the model never
gets to name files into existence).

`assembleCodeContext` (`backend/src/chat/codeContext.ts`):

- Validates the batch (≤ 20 files, ≤ 200 KB each, string path+content).
- Rejects absolute paths and `..` traversal — unsafe entries are **dropped
  with a reason**, never echoed.
- Applies per-file and total character budgets; over-budget files are
  truncated with an explicit `(truncated)` marker, dropped files get a
  reason. Truncation is always labeled — the model is never left to guess
  what it didn't see.
- Labels every file with its exact path in `--- REPO FILE: <path> ---`
  delimiters, so explanations can cite real locations.

Coding mode (system prompt v2.2.0, `codingMode`):

- Ground every claim in the shown files; cite file paths.
- **Never invent paths, symbols, or APIs.** If a file is missing, ask for
  it — do not guess its contents.
- Requested changes arrive as **unified diffs** (`--- a/...` /
  `+++ b/...`) anchored to real paths, by default.
- Complete code only — no fake `TODO` placeholders where real logic was
  asked for.

The SSE `meta` frame reports `codeFiles: { requested, included, dropped,
truncated }` so operators can see what context a turn actually had.

## 5. Eval coverage

Phase 6 added deterministic cases (each mock passes its own judge):

- `coding-011` — multi-file grounded explanation; invented-file penalty.
- `coding-012` — unified diff anchored to the real path.
- `coding-013` — asks for the missing file instead of inventing it.
- `coding-014` — uses only real APIs from the shown file.
- `tool-selection-005` — generalized chain (`repo.search` → `repo.readFile`)
  with no invented paths.
- `tool-selection-006` — dependent value chaining (`calc.add` → `calc.double`)
  through a non-SyteLine family.

Full corpus: 134 cases, **132/132 deterministic pass, 2 skipped**
(llm-judge, no judge model). All eight charter dimensions green. See
`docs/eval.md`.

## 6. Honest limits

- **Strategy is intent, not scored selection.** `quality` / `latency` /
  `cost` records the operator's routing intent in policy and audit; the
  actual model remains the explicit per-capability serving default. If the
  fleet grows to multiple servable candidates per capability, extend
  `resolveCapabilityModel` with scored selection — the policy row is the
  seam.
- **Capability detection is heuristic.** Conservative keyword/intent
  signals, not a classifier. It errs toward `chat`, which is always safe.
  Per-turn explicit `capability` or `modelId` overrides it.
- **No write tools yet.** The approval gate is built and tested, but no
  production tool is destructive today (a test asserts this). The
  `approvedCallIds` human-in-the-loop flow is a designed seam, not a UI.
- **GPU/production validation.** Routing, loop, and coding behavior are
  **VALIDATED IN CI** (deterministic mocks). Real-model routing quality,
  latency/cost strategy effects, and live SyteLine chains **REQUIRE REAL
  GPU / PRODUCTION INFRASTRUCTURE**.
