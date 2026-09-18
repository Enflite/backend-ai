-- 012_refresh_token_history.sql
-- Reuse detection previously retained only the immediately previous refresh
-- token hash: an attacker presenting a token superseded two or more rotations
-- ago would not be detected. Keep a short rolling history (last 5 hashes) so
-- reuse detection survives several legitimate rotations. The single
-- replaced_refresh_token_hash / replaced_at pair from 009 is retained as the
-- most-recent entry for the indexed hot path.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS previous_refresh_token_hashes TEXT[] NOT NULL DEFAULT '{}';
CREATE INDEX IF NOT EXISTS idx_sessions_prev_hashes
  ON sessions USING GIN (previous_refresh_token_hashes);
