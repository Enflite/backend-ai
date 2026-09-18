# Assistant Behavior: System Prompt, Zones, and Error Recovery

How the Enflite AI assistant's behavior is built: the default system prompt,
how untrusted content is structurally delimited, and how the agentic
tool-calling loop recovers from failure.

The behavioral standard itself lives in `docs/assistant-quality.md` — this
document describes the implementation. It does not duplicate the charter.

## System prompt

**Source:** `backend/src/chat/systemPrompt.ts` — `buildSystemPrompt(options)`.

The builder renders the default system prompt that encodes the charter's §2
behavioral spec: direct/helpful tone, honesty and calibration ("say what you
don't know"), grounding rules with the platform citation format, the
ambiguity policy (clarify only when guessing wrong is costly), the
error-recovery policy, tone, refusals, and identity.

**Identity.** The assistant identifies as the Enflite AI assistant. It never
claims to be human and never claims capabilities it doesn't have — when no
tools are offered for a turn, the prompt says so explicitly.

**Metadata.** The prompt carries only tenant-safe metadata: the serving
model's name and version from the model registry. It never contains secrets
(API keys, tokens, credentials, endpoint details) or request-scoped
identifiers (tenant/user IDs) — there is deliberately no option to pass them.
The test suite asserts the rendered prompt contains no secret-shaped
material.

**Versioning.** `SYSTEM_PROMPT_VERSION` is bumped whenever the prompt text
changes, so prompt iterations can be tracked against model versions in the
registry and compared in evals.

**Wiring.** The chat route (`backend/src/chat/routes.ts`) builds the prompt
per turn with the serving model's name/version and whether tools are
available, then hands it to the AI gateway. The gateway pins it at index 0 of
every provider call: `applyContextWindow` always retains the system prompt
first and drops oldest non-system messages first, and `gatewayStream`
strips any caller-supplied `system` messages and re-injects the trusted
prompt — stored history can never smuggle instructions past it, and
truncation can never drop it (charter §4.1, item 1). After a mid-turn model
failover the route rebuilds the prompt naming the fallback model, so the
prompt stays honest about which model is serving.

## Content zones

Every turn is divided into five labeled zones with different trust levels,
declared in the system prompt itself:

1. **System instructions** — the prompt above. The only instructions the
   model follows; always present, never dropped.
2. **Conversation history** — earlier turns, in order.
3. **Retrieved RAG context** — enterprise document excerpts, wrapped by
   `wrapRetrievedContext()` in a labeled zone banner plus
   `<retrieved_context>…</retrieved_context>`, with per-chunk
   `<untrusted_document citation="N" …>` markers produced by retrieval.
4. **Tool outputs** — each arrives as a `tool` message wrapped by
   `wrapToolResult()` in `<untrusted_tool_result name="…">…</untrusted_tool_result>`
   (HTML-escaped; may be truncated or report errors).
5. **Current user message** — the user's latest message, stating the task.

Zones 3–5 are **data, never instructions**. The user's task comes from zone
5, but the model carries it out subject to the system instructions, which
zone 5 can never override. Instructions, commands, or directives appearing
inside zones 3–5 are never followed. Authorization is enforced by
application code — never by asking the model to behave; a denied tool call
is accepted and routed to the next-best path.

## Error recovery

**Tool failures** (`backend/src/chat/toolRecovery.ts`,
`runToolCallWithRecovery`). A failed tool call is not a dead end:

- Failures that look transient (`TOOL_TIMEOUT`, `SYTELINE_UPSTREAM_ERROR`,
  `TOOL_EXECUTION_FAILED`) are retried **once**. Deterministic failures
  (bad arguments, unknown tool, denied by policy, confirmation required,
  unconfigured adapter) are never retried blindly — retrying the identical
  call cannot succeed.
- No retry happens after the caller went away; an answer nobody will read
  must not burn another tool slot.
- Every outcome — success or sanitized error — is fed back to the model as
  a zone-4 tool result. Tool errors are sanitized before they reach the
  model (generic message; adapter internals stay in the audit trail), so the
  model can retry with corrected arguments or explain what failed in plain
  language and offer the next-best path. The loop never dead-ends and never
  produces a silent partial answer.

The retry lives in the chat loop, not in `runToolCall`, so the direct
`/tools/:name/execute` API stays single-attempt and deterministic. Every
attempt is audited, so retries are fully traceable.

**Model/stream failures.** A failed model call or interrupted stream
surfaces as a clear, honest status — never a fabricated answer, never a
silent partial message. Interrupted streams are persisted with
`stream_interrupted` metadata, and provider failover is announced to the
client and audited.

**Empty retrieval.** When document retrieval was requested but returned
nothing, the route injects `buildNoEvidenceNotice()`: an instruction to say
"I don't know from the available sources" in the model's own words, say
what would answer the question, offer to look further — and never invent
document contents, quotes, or citations (charter §4.1, item 4).

## Quality scales with the model weights

Plain-English version of charter §6, for operators and stakeholders:

The model weights set the capability ceiling — no prompt or platform trick
can make a model smarter than its weights allow. What platform engineering
does is **maximize and measure what the weights deliver**: the system prompt
above, zone delimiting, grounded generation with real citations, and
agentic error recovery exist to extract the best possible behavior from
whatever model is deployed — and the evaluation framework exists to prove
it, scoring honesty, grounding, tool-use, and the other charter dimensions
per model version.

Because the prompt is versioned alongside model configuration in the model
registry, upgrades are safe to attempt and easy to verify: a candidate model
is evaluated, its scores are compared against the incumbent, and promotion
is gated on not regressing grounding or honesty. Better weights plus this
platform is how quality compounds over time.

This is not a claim that any deployed model equals any specific frontier
model. It is a claim about process: the platform gets the most out of its
models and can prove that a change made things better.

---

*Related: `docs/assistant-quality.md` (the behavioral standard) ·
`docs/rag.md` (retrieval and citations) · `docs/architecture.mmd` (system
design) · `docs/threat-model.md` (security model)*
