import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as gateway from '../src/ai/gateway/gateway.js';
import { streamMetadata } from '../src/ai/gateway/gateway.js';

/**
 * The legacy in-content interrupted marker is gone: stream status now
 * travels in `messages.metadata` (migration 015), so history readers see
 * the clean model text plus a machine-readable status.
 */
describe('stream status metadata', () => {
  it('marks interrupted turns with stream_interrupted=true and stream_status=interrupted', () => {
    expect(streamMetadata('interrupted')).toEqual({
      stream_status: 'interrupted',
      stream_interrupted: true,
    });
  });

  it('marks completed turns with stream_status=completed and no interruption flag', () => {
    const metadata = streamMetadata('completed');
    expect(metadata).toEqual({ stream_status: 'completed' });
    expect('stream_interrupted' in metadata).toBe(false);
  });

  it('no longer mutates message content with an in-band marker', () => {
    expect('STREAM_INTERRUPTED_MARKER' in gateway).toBe(false);
    expect('markStreamInterrupted' in gateway).toBe(false);
  });

  it('migration 015 adds the metadata column and backfills the legacy marker idempotently', () => {
    const sql = readFileSync(
      new URL('../src/db/migrations/015_message_metadata.sql', import.meta.url),
      'utf8'
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS metadata');
    expect(sql).toContain('JSONB NOT NULL');
    // The backfill moves the legacy marker text into metadata…
    expect(sql).toContain('[incomplete: stream ended before the model finished]');
    expect(sql).toContain('"stream_interrupted": true');
    expect(sql).toContain('"stream_status": "interrupted"');
    // …and is idempotent: re-running must skip already-backfilled rows.
    expect(sql).toMatch(/NOT\s+COALESCE\(\(metadata\s*->>\s*'stream_interrupted'\)/);
  });
});
