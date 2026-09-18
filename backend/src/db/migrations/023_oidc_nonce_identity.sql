-- 023: OIDC nonce storage and stable issuer+subject identity mapping (Phase 5b).
--
-- Nonce: the OIDC flow must bind the authorization request to the ID token
-- (replay protection). The nonce is generated per login attempt, stored
-- alongside the PKCE verifier, sent to the IdP, and verified against the
-- ID token's nonce claim on callback.
--
-- oidc_identities: stable identity mapping keyed by the verified
-- (issuer, subject) pair. Provisioning must not rely on email alone:
-- emails change and are reassigned; issuer+subject is the IdP's stable
-- identifier for the user.

ALTER TABLE oidc_auth_requests
  ADD COLUMN IF NOT EXISTS nonce TEXT;

CREATE TABLE IF NOT EXISTS oidc_identities (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT oidc_identities_pkey PRIMARY KEY (issuer, subject)
);

CREATE INDEX IF NOT EXISTS idx_oidc_identities_user
  ON oidc_identities (user_id);

-- Pre-auth tables (no session exists during the OIDC flow), so no RLS:
-- auth request rows are addressed by unguessable random state values and
-- expire in 10 minutes; identity rows are keyed by the IdP-verified
-- issuer+subject pair and only ever looked up by that exact key.
