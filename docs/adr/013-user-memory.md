# ADR-013: Tenant-scoped user memory with a private-by-default privacy model

**Status:** Accepted

## Context

The assistant needs to remember user facts and preferences across
conversations ("prefers concise summaries", "works on Project Falcon").
Stored memories are among the most sensitive data in the platform: they
accumulate quietly, they are easy to over-collect, and a leak is a direct
privacy breach. The design must make the private-by-default posture
structurally unavoidable, not a matter of developer discipline.

## Decision

- **Storage** (`memory_facts`, migration `027_user_memory.sql`): every row
  carries `tenant_id` + `user_id`; `fact` (1–2000 chars), `category`
  (`preference`/`fact`/`project`), `classification` (the existing
  classification vocabulary, defaulting like conversations), `source`
  (`user-stated`/`inferred`). Composite index on
  `(tenant_id, user_id, updated_at DESC)`; RLS `ENABLE` + `FORCE` with a
  `tenant_isolation` policy predicated on `app.tenant_id` (USING and
  WITH CHECK), following the 021/025 pattern.
- **Application scoping is primary** (ADR-004): every query in
  `backend/src/memory/store.ts` binds both `tenant_id` and `user_id` from
  the caller's auth context. RLS is defense in depth, and the
  `rlsEnforcement` static test now covers `memory_facts`.
- **User-private, always.** A caller can only ever touch their own rows.
  Cross-user access does not exist in the module: no admin backdoor, no
  "view as" — not even Security Admin gets `memory:read` for other users'
  facts. The API is self-service by design: users can list, create, update,
  and delete exactly what the assistant remembers about them
  (`/api/v1/memory*`), and creates/updates/deletes plus single-fact reads
  are audited (`MEMORY_CREATE/UPDATE/DELETE/ACCESS`).
- **Write-side classification** may not exceed the caller's clearance
  (`assertClassificationAllowed`, same as conversations); `UNKNOWN` fails
  closed.
- **Injection** (`backend/src/memory/inject.ts`): each chat turn renders the
  caller's most recent facts as a delimited `USER MEMORY` section appended
  to the system prompt. The section is labeled untrusted data — context the
  model may use, never instructions it follows. Three guards apply before
  anything reaches the model:
  1. classification filter against the turn's request classification
     (`UNKNOWN` fails closed either way);
  2. secret-scrub redaction of secret-shaped spans (API keys, bearer
     tokens, password assignments, private keys → `[redacted:secret]`);
  3. a token budget (most-recent-first, ≤ 10 facts / ~2000 estimated
     tokens) so memory can never crowd out the prompt or history.
  The memory lookup is best-effort: a failure logs and the turn proceeds
  without the section.
- **No credentials in memories, ever.** Fact text is user data, not a secret
  store; the injection-time scrub is a guardrail, not an excuse to store
  secrets. The test suite asserts secret-shaped material never reaches the
  rendered injection.

## Alternatives considered

- **Tenant-wide shared memory** (any user in the tenant sees all facts):
  rejected — it leaks personal preferences across users and makes the
  privacy boundary fuzzy. Tenant-level shared context, if ever wanted, is a
  separate feature with its own consent model.
- **Write-side DLP redaction** (SSN/credit-card scanning on store, reusing
  `backend/src/dlp/detectors.ts`): deferred. The outbound detectors are
  tuned for streams, and silent redaction on write would degrade legitimate
  memories ("my phone number is …"). It needs a product decision, not a
  silent default. Recorded as a follow-up.
- **Vector/semantic retrieval over facts**: deferred. The corpus is small
  per user; most-recent-N with a token cap is predictable, cheap, and
  explainable. Revisit if usage shows it missing relevant older facts.

## Consequences

- One extra indexed query per chat turn (bounded at 25 rows); negligible
  latency impact.
- Memories inherit the request's classification policy: a `PUBLIC` turn
  never sees `CONFIDENTIAL` facts, and a fact can never raise a turn's
  clearance.
- Deleting a fact is immediate and total — there is no soft-delete or
  history of memories, matching the user's right to see and delete what is
  remembered.
- Live RLS enforcement and the full migration chain still require a
  live-database CI job; mocked tests prove the application scoping, not the
  database enforcement (labeled accordingly in the test files).
