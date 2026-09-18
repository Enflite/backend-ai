-- 020: single-use OIDC authorization request storage (Phase 5b).
--
-- Holds the PKCE verifier between /auth/oidc/login and /auth/oidc/callback.
-- Rows are deleted when the state is consumed (single-use) and expired rows
-- are cleaned up opportunistically on each new login attempt.

CREATE TABLE IF NOT EXISTS oidc_auth_requests (
  state TEXT PRIMARY KEY,
  code_verifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oidc_auth_requests_expires
  ON oidc_auth_requests (expires_at);

-- Pre-auth table (the user has no session yet during the OIDC flow), so no
-- RLS: rows are addressed by unguessable random state values and expire in
-- 10 minutes.
