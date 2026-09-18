-- 009_session_security.sql
-- Refresh-token reuse detection and session inventory support:
--  - replaced_refresh_token_hash / replaced_at retain the superseded token hash
--    briefly after rotation. Presenting a superseded token is treated as
--    token theft: all of the user's sessions are revoked and a security audit
--    event is emitted.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_refresh_token_hash TEXT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS replaced_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_sessions_replaced_hash
  ON sessions (replaced_refresh_token_hash) WHERE replaced_refresh_token_hash IS NOT NULL;
