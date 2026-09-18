# ADR-001: Docs-only PRs stay separate from code PRs

**Status:** Accepted

## Context

Architecture and roadmap documents (e.g. PR #5's `TODO.md` and
`docs/architecture.mmd`) describe the system; code PRs change it. Mixing the
two in one review makes it impossible to judge either: a reviewer can't tell
whether the blueprint changed because the code changed, or the code changed
because the blueprint said so.

## Decision

Documentation PRs are docs-only: they may add or correct prose, diagrams,
roadmaps, and decision records, but they must not contain implementation.
Implementation lands in follow-up PRs that reference the docs. When docs
describe planned work, they say so explicitly (`TODO.md` is a build queue,
not a changelog).

## Consequences

- Docs PRs (e.g. #5, #7, #10) review fast: no test runs, no migration
  scrutiny, just accuracy of the description against the code.
- Code PRs can be judged against a stable, already-merged blueprint.
- A docs PR that sneaks in code must be split before merge.
