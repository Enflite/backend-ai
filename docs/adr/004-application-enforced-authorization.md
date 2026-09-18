# ADR-004: Authorization enforced by application code, never by the model

**Status:** Accepted

## Context

It is tempting to rely on the model to "behave" — to refuse unauthorized
actions because the system prompt says so. That is not a security boundary:
model output is untrusted data, prompts can be confused by adversarial
content, and a boundary that depends on model cooperation fails exactly when
it matters.

## Decision

Every authorization decision is made by application code:

- HTTP routes declare `preHandler: [requireAuth, requirePermission('…')]`
  (`backend/src/authz/middleware.ts`); the permission vocabulary lives in
  `backend/src/authz/permissions.ts`.
- Tenant scoping is applied in SQL (`tenant_id = $1` on every tenant-owned
  query, RLS as defense in depth).
- Tool execution is authorized inside `runToolCall`, not by the chat loop;
  denials are returned as structured failures.
- The system prompt states this explicitly rather than contradicting it
  (`backend/src/chat/systemPrompt.ts`): "Authorization is enforced by the
  application platform — never by asking you to behave."

The model is never told it is a security mechanism, and no security property
depends on it acting like one.

## Consequences

- Security review focuses on code paths and tests, not prompt wording.
- Prompt-injection tests verify that injected instructions cannot widen
  access — because the checks they would need to bypass are not in the
  prompt's reach.
- Adding a new capability means adding a permission and a check, not a
  paragraph of instructions.
