# ADR-010: Server-side sessions with refresh-token rotation

**Status:** Accepted

## Context

Stateless JWT-only auth cannot be revoked and gives no signal when a refresh
token is stolen. The platform needs revocation, theft detection, and
per-session visibility for audit.

## Decision

- Access is via short-lived JWTs (15m default); refresh uses opaque,
  single-use tokens stored server-side in `sessions`
  (`backend/src/auth/sessions.ts`).
- Every refresh **rotates**: the old token hash is kept in
  `previous_refresh_token_hashes` (migration `012_refresh_token_history.sql`).
  Presenting a superseded token signals theft → all of the user's sessions
  are revoked and a `SECURITY_REFRESH_TOKEN_REUSED` audit event is raised
  (`backend/src/auth/routes.ts`).
- Users can list and revoke individual sessions (`GET` / `DELETE
  /api/v1/auth/sessions`), or revoke all (`POST /api/v1/auth/logout/all`).
- Failed logins feed per-account lockout with escalating backoff (migration
  `010_login_lockout.sql`); locked accounts return the same generic 401 as
  bad credentials.

## Consequences

- Auth state lives in PostgreSQL: sessions survive restarts and are
  auditable, at the cost of a DB lookup per refresh.
- Token theft has a detection-and-response path, not just an expiry window.
