-- 010_login_lockout.sql
-- Per-account login failure tracking with escalating temporary lockout to
-- blunt distributed password spraying (the per-IP route rate limit alone
-- cannot stop a botnet spraying one account from many IPs).

ALTER TABLE users ADD COLUMN IF NOT EXISTS failed_login_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS locked_until TIMESTAMPTZ;
