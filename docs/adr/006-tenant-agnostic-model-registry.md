# ADR-006: Tenant-agnostic model registry

**Status:** Accepted

## Context

Models (weights, provider endpoints, capabilities, licenses) are platform
assets, not tenant data. But which model a tenant may use — and which model
serves a given capability for that tenant — is a tenant-scoped decision that
must be admin-controlled and auditable.

## Decision

- The `models` table carries **no `tenant_id`** (migration `001_init.sql`):
  registration, evaluation, approval, and lifecycle are platform-wide.
- Tenant access is computed, not stored: `listApprovedModelsForUser` intersects
  the model's `allowed_classifications` and status with the caller's tenant,
  role, and clearance at request time.
- Per-tenant serving choice lives in a separate table,
  `model_serving_defaults(tenant_id, capability)` (migration
  `017_model_lifecycle.sql`), managed by admins via
  `GET/PUT /api/v1/admin/serving-defaults`.

## Consequences

- Evaluating or approving a model once benefits every tenant; there is no
  per-tenant model sprawl.
- Tenant isolation for serving is enforced at the decision point (serving
  resolution), not by duplicating model rows.
- A tenant can never see, let alone select, a model that is not approved for
  them — the `/api/v1/models` listing is already filtered.
