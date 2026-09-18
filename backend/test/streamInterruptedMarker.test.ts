import { describe, expect, it } from 'vitest';
import { markStreamInterrupted, STREAM_INTERRUPTED_MARKER } from '../src/ai/gateway/gateway.js';

describe('stream-interrupted marker', () => {
  it('appends the marker to partially streamed assistant content', () => {
    const content = 'The answer so far is';
    const marked = markStreamInterrupted(content);
    expect(marked).toBe(`${content}\n\n${STREAM_INTERRUPTED_MARKER}`);
  });

  it('trims trailing whitespace before appending the marker', () => {
    expect(markStreamInterrupted('partial\n\n')).toBe(`partial\n\n${STREAM_INTERRUPTED_MARKER}`);
  });

  it('is idempotent: never appends the marker twice', () => {
    const marked = markStreamInterrupted('partial');
    expect(markStreamInterrupted(marked)).toBe(marked);
    expect(marked.split(STREAM_INTERRUPTED_MARKER).length - 1).toBe(1);
  });

  it('exposes the marker text for clients parsing persisted transcripts', () => {
    expect(STREAM_INTERRUPTED_MARKER).toContain('incomplete');
    expect(markStreamInterrupted('x')).toContain(STREAM_INTERRUPTED_MARKER);
  });
});
