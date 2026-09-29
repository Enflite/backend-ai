# Privacy-aware provider routing

**Policy: Claude for anything outside sensitive data; local Enflite whenever
sensitive data is involved.** Sensitive means customer data, finance data,
or proprietary business data. When in doubt, the turn stays local.

## What it does

Every chat turn is scanned for sensitive-data markers *after the full prompt
is assembled* (system prompt, history window, RAG chunks, code files,
memory injection). The routing decision:

| Situation | Result |
|---|---|
| Customer, finance, or proprietary data detected (or predicted) | **Local Enflite**, always — even overrides a manual Claude selection |
| Explicit provider choice on a clean turn | Respected as-is (Enflite or Claude) |
| No explicit choice + clean turn + Claude configured | **Claude** (auto-routing, default ON) |
| Claude key missing / toggle off | Local Enflite |

Manual selections are only ever overridden **toward local, never away from
it**: an explicit Enflite choice is never upgraded to the cloud.

When privacy routing overrides a cloud selection, the user sees one
friendly SSE notice — *"Kept this on Enflite — it touches customer data."*
(for customer data; equivalent wording for finance or proprietary data) —
and the activity feed records it. No lecture, no friction.

## The three sensitive categories

| Category | What it covers |
|---|---|
| `customer` | Customer PII and identifiers: names in ERP context, email addresses, phone numbers, SSNs, customer/account IDs, ERP document numbers (`SO-…`, `WO-…`, `PO-…`, …), SyteLine tool results |
| `finance` | Money and accounting: revenue, margin, P&L, payroll, GL, EBITDA, balance sheet, accounts payable/receivable, tax/EIN numbers, labeled financial account numbers |
| `proprietary` | Non-public business knowledge: internal process documents, confidential strategies, private-corpus RAG chunks with no other sensitivity signal |

All three are enforced by default. An admin can adjust the enforced set
per tenant (see Setup) — the rule is tenant-configurable but
**default-deny**: an unknown or unrecognized document sensitivity tag does
not disable protection; unmarked private-corpus chunks are treated as
proprietary.

## The source-code carve-out

Repo source code stays routable to Claude by default — coding help is a
primary use case of the assistant, and code regions are stripped before the
finance-keyword scan runs (so CSS `margin` never counts as financial
data). The carve-out is explicit and flippable with one tenant flag:

- `codeRoutableToCloud: true` (default) — code files are Claude-routable;
  `repo.*` tools stay available on cloud turns.
- `codeRoutableToCloud: false` — code is treated as proprietary: code
  turns stay local and `repo.*` tools are stripped on cloud turns.

Only business, finance, customer, and proprietary **data** is local-only —
the carve-out covers code, not data embedded in it.

## Why the whole prompt is scanned (context bleed)

A turn whose latest message looks "general" ("thanks!", "what about
tomorrow?") still carries the conversation history: if an earlier turn
pulled sales order SO-77821, the history now contains customer data.
Routing on the latest message alone would send that history to Anthropic.

So the scan runs on the fully assembled prompt, not the latest message.
Any future prompt-assembly change must keep feeding its output through
the detector — a new context source that bypasses the scan is a privacy
hole.

Two mechanisms close the gap the upfront scan cannot see (a turn's
*current* tool results don't exist yet at routing time):

1. **Predictive rule** — a turn whose capability is `syteline` will invoke
   SyteLine tools whose results are customer/finance data, so it routes
   local preemptively (`syteline_capability_predicted`).
2. **Tool-offering gate** — `syteline.*` tools are never offered on cloud
   turns when `customer` or `finance` is enforced; `repo.*` tools are
   stripped only when the code carve-out is disabled. A cloud turn can
   never produce sensitive data via tools it was never given.

## Detection markers

- `<untrusted_tool_result name="syteline.…">` blocks (prior ERP results)
- `--- ZONE 3: RETRIEVED RAG CONTEXT` with `<untrusted_document …>` chunks
  carrying `sensitivity="customer|finance|proprietary"` metadata
- `--- USER MEMORY (untrusted data) ---` (tenant-private memory)
- PII: email addresses, phone numbers, SSNs, labeled account/customer
  numbers, tax/EIN numbers, ERP document numbers
- Finance vocabulary: revenue, margin, P&L, payroll, GL, EBITDA, balance
  sheet, accounts payable/receivable (code regions stripped first)

The static SyteLine knowledge pack is *public* knowledge (built from public
sources) and carries none of these markers — SyteLine expertise alone never
triggers the rule. Detection reasons are audited as machine-readable codes
only; matched text is never logged, persisted, or returned.

## Fail-closed guarantee

If a turn is flagged sensitive and no local model can be resolved (no
Enflite default, none approved), the turn **fails closed**: the chat
request is rejected with `503 PRIVACY_LOCAL_MODEL_UNAVAILABLE` and a
plain-language message asking the admin to approve a local model —
sensitive context is never sent to Claude as a fallback. This is the
default-deny backbone of the whole policy.

### OLLAMA_ENABLED=false (Claude-only launch)

The one exception is the operator's explicit choice to run without the
local stack: while `OLLAMA_ENABLED=false`, a sensitive turn is served by
the default Claude model instead of failing closed. This is **silent from
the user's perspective** — no user-facing notice frame, no activity-feed
entry — but the routing decision is written to the audit trail
(`PRIVACY_ROUTING_LOCAL_DISABLED`, with detection reasons and the serving
model) so admins can see it. Flip `OLLAMA_ENABLED=true` and the
fail-closed guarantee above applies again in full.

## Web access

**Web access = Claude's built-in web search on non-sensitive turns;
sensitive turns stay local and offline.**

On Claude-routed turns the backend enables Claude's native server-side
`web_search` tool (part of the Anthropic API — no extra key, no new egress
beyond `api.anthropic.com`). It runs inside Anthropic's API, so the
platform never executes or proxies searches itself; the model synthesizes
results into its streamed answer, which the DLP stream guard screens like
any other text. The activity feed shows "Searched the web" when the model
uses it. Local Enflite turns are offline-only — which is exactly right,
because local turns are the sensitive ones.

## Setup

Only one key is needed: `ANTHROPIC_API_KEY` in the backend environment
(see README "Adding cloud keys"). Without it, everything serves locally —
auto-routing is a no-op and the app behaves exactly as before.

The per-tenant privacy-routing settings (default: auto-routing ON, all
three categories enforced, code carve-out ON) live at:

- `GET /admin/privacy-routing` — current settings
- `PUT /admin/privacy-routing` — any subset of
  `{ "autoRouteToCloud": boolean, "sensitiveCategories": ["customer","finance","proprietary"], "codeRoutableToCloud": boolean }`
  (audited, requires `model:manage`)

The toggle only ever moves *clean* turns to Claude. The sensitive-data
rule is not toggleable — only its category set, which defaults to all
three enforced.

## Audit events

- `PRIVACY_ROUTING_OVERRIDE` — a cloud selection was forced back to local
  (metadata: `reasons`, `categories`, `fromModelId`, `toModelId`)
- `PRIVACY_ROUTING_NO_LOCAL_MODEL` — a sensitive turn was rejected because
  no local model could serve it (metadata: `reasons`, `categories`)
- `PRIVACY_ROUTING_AUTO_CLOUD` — a clean, unpinned turn auto-routed to
  Claude
- `PRIVACY_ROUTING_SETTING_SET` — an admin changed the tenant settings
  (metadata names changed fields only, never data values)

## Validation status

- **VALIDATED IN CI** — detector unit tests (all three categories, metadata
  tags, code carve-out on/off, fail-closed when no local model), routing
  precedence tests, settings round-trip, tool gates, and Claude
  `web_search` payload/event tests (mocked HTTP; no network, no
  Anthropic).
- **REQUIRES REAL INFRASTRUCTURE** — end-to-end validation with a real
  `ANTHROPIC_API_KEY` (auto-routing to Claude, web_search firing live,
  override notice rendering) needs the owner's key and deployment.
