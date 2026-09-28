# ADR-016: Default-open model serving

**Status:** Accepted

## Context

New users — including Jake's own `jsmith1@enflite.com` OIDC account — hit
the dead end "No approved model is available for your account" because
`listApprovedModelsForUser` returned `[]` whenever no `model_access` grant
rows existed for their principal. The product direction is that every user
has full access by default: the AI must work out of the box for every
account in every tenant, with no manual grant step. Security and compliance
stay invisible infrastructure — enforced outside the model — never
user-facing friction.

## Decision

- The tenant default model (the seeded Ollama `llama3.1:8b` doc,
  `meta-llama/Meta-Llama-3.1-8B-Instruct`) is **implicitly available to
  every user in every tenant**: `getApprovedModelForUser` no longer
  requires a grant row for the default model, and
  `listApprovedModelsForUser` includes it automatically. Migration 029
  flags it (`isDefault: true`); the registry self-heals the flag on read.
- Resolution is last-resort: chat/conversation model resolution is
  serving-default → first approved → ensured tenant default
  (`resolveDefaultOpenModel`), so `NO_APPROVED_MODEL` is unreachable in
  normal operation. `ensureTenantDefaultModel` is idempotent and
  create-on-read, but never resurrects a default an admin disabled.
- **Revocation is explicit, not the absence of a grant.** Because a missing
  row now means "allowed" for the default model, denial must be written:
  `model_access.revoked = true` per principal, set via
  `POST /admin/models/:id/access` (audited); clearing the row returns to
  the default-open default. An explicit revocation always wins.
- Non-default models stay **fail-closed**: an explicit grant row is still
  required. Lifecycle gates (ACTIVE/CANARY + enabled), eval-gated
  promotion, classification policy, and tenant isolation are unchanged.
- Permissions: `syteline:forms` joins the default `User` role (migration
  030 seeds the missing permission doc); platform/global administration
  (`model:manage`, `tenant:manage`, `audit:read`, …) stays admin-gated.

## Consequences

- Fresh OIDC/password users can chat immediately; no manual database step
  exists anywhere in the onboarding path.
- Admins who previously "revoked" the default by deleting grant rows must
  re-express the denial explicitly; until then the default is served.
- The `models` collection remains platform-global; only `model_access`
  and `model_serving_defaults` carry tenant scope.
