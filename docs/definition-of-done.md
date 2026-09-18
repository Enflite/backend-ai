# Definition of Done

The merge bar for the Enflite backend-ai repository. A PR is mergeable only
when **every** item below holds. The bar exists to keep the platform shippable
at all times — `main` is always deployable.

## 1. CI is green

- Backend (`npm test`, typecheck), frontend (typecheck + build), and
  compose-config checks pass on both the push and pull_request runs.
- A red check is never overridden, skipped, or "fixed later."

## 2. The diff has been hostile-reviewed

- The author has re-read the **full** diff as an attacker (auth bypass,
  tenant escape, injection, SSRF, secret leak) and as a future maintainer
  (clarity, naming, error handling).
- Automated review findings (CodeRabbit or equivalent) are **fixed or
  explicitly triaged with a written justification** — "will fix later" is
  not triage.

## 3. Tests prove the change

- New behavior ships with tests; bug fixes ship with regression tests.
- The PR description states test counts and results (e.g. "381/381 backend
  tests pass, 12 new").
- Deterministic tests run in CI. Tests requiring a judge model, GPU, or live
  infrastructure are versioned, clearly labeled, and never silently counted
  as passes.

## 4. Validation is labeled honestly

Every PR description carries the split:

- **VALIDATED IN CI** — actually ran here and passed (tests, typecheck,
  builds, migration syntax, mock-backed suites).
- **REQUIRES REAL GPU / PRODUCTION INFRASTRUCTURE** — needs live
  PostgreSQL+pgvector, vLLM, embedding service, object storage, malware
  scanner, or SyteLine, none of which exist in this sandbox.

Never claim validation that did not happen. Never imply a deployment is
compliant with anything — shipping code does not establish CMMC/NIST
compliance.

## 5. Security invariants hold

- Tenant isolation: every new query scoped by tenant; RLS as defense in depth.
- Authorization in application code (`requireAuth`, `requirePermission`),
  never delegated to prompts or the model.
- `UNKNOWN` classification fails closed; security-relevant actions audited.
- No secrets in code, logs, errors, URLs, or client responses.
- New endpoints declare the minimal permission; new migrations are reviewed
  for ordering, idempotency, and RLS/index correctness.

## 6. Docs travel with the code

- Behavior changes update the relevant docs (`docs/api.md` for endpoints,
  `docs/adr/` for new architectural decisions, `TODO.md` for roadmap
  movement).
- Docs-only changes ship in docs-only PRs (see ADR-001).

## 7. Merge mechanics

- **Merge commits, not squash** — history stays reviewable.
- One logical change per PR; no unrelated refactors smuggled in.
- After merge: delete the branch, confirm `main` is green.

## Release sign-off (for tagged releases, beyond a single PR)

1. All PRs since the last tag met this bar.
2. Migrations apply cleanly to a fresh database **and** upgrade from the
   previous release (tested where infrastructure exists; otherwise labeled
   per §4).
3. The eval suite shows no quality regression vs. the previous release
   (compare runs via `GET /admin/eval/compare`).
4. Known limitations are written down in the release notes — not discovered
   by the user.
