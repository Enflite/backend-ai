-- 015_message_metadata.sql
--
-- Adds a JSONB metadata column to messages so stream status travels outside
-- the message text (see backend/src/ai/gateway/gateway.ts `streamMetadata`),
-- and backfills rows that still carry the legacy in-content interrupted
-- marker "[incomplete: stream ended before the model finished]".
--
-- Discovered automatically by backend/src/db/migrate.ts via filename
-- ordering; runs inside a transaction like the other DDL migrations.

ALTER TABLE messages ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}';

-- Backfill: strip the legacy trailing marker into metadata. Idempotent: the
-- WHERE clause only matches rows that still contain the marker text and have
-- not already been backfilled, so re-running this migration changes nothing.
UPDATE messages
SET content = regexp_replace(
      content,
      E'\n\n\\[incomplete: stream ended before the model finished\\][[:space:]]*$',
      ''
    ),
    metadata = metadata || '{"stream_interrupted": true, "stream_status": "interrupted"}'::jsonb
WHERE role = 'assistant'
  AND content LIKE '%[incomplete: stream ended before the model finished]%'
  AND NOT COALESCE((metadata ->> 'stream_interrupted')::boolean, false);
