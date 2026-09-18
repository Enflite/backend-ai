-- 007_model_tuning.sql: per-model provider tuning and ordered fallback.
--
-- request_timeout_ms: per-model inference timeout override. NULL falls back to
--   the server AI_REQUEST_TIMEOUT_MS default.
-- max_tokens / temperature: passed through to OpenAI-compatible providers.
--   NULL means "let the provider decide".
-- fallback_model_id: when the primary model fails (network error, 5xx, timeout),
--   the gateway fails over ONCE to this model, which must itself be APPROVED,
--   enabled, and granted to the calling user. Chains are not followed: a
--   failing fallback surfaces the error instead of cascading.

ALTER TABLE models ADD COLUMN IF NOT EXISTS request_timeout_ms INTEGER
  CHECK (request_timeout_ms IS NULL OR request_timeout_ms >= 1000);
ALTER TABLE models ADD COLUMN IF NOT EXISTS max_tokens INTEGER
  CHECK (max_tokens IS NULL OR max_tokens > 0);
ALTER TABLE models ADD COLUMN IF NOT EXISTS temperature DOUBLE PRECISION
  CHECK (temperature IS NULL OR (temperature >= 0 AND temperature <= 2));
ALTER TABLE models ADD COLUMN IF NOT EXISTS fallback_model_id UUID
  REFERENCES models(id) ON DELETE SET NULL;

-- A model cannot fall back to itself.
ALTER TABLE models ADD CONSTRAINT models_fallback_not_self
  CHECK (fallback_model_id IS NULL OR fallback_model_id <> id) NOT VALID;
