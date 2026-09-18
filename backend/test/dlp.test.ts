/**
 * dlp.test.ts — DLP outbound boundary unit tests (Phase 5c).
 *
 * Covers the deterministic detectors (SSN, Luhn-validated cards), the
 * streaming guard's cross-chunk handling, and the external hook's
 * fail-open behavior. VALIDATED IN CI.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  findDlpMatches,
  luhnValid,
  panShapePlausible,
  redactText,
  DLP_MARKERS,
} from '../src/dlp/detectors.js';
import { DlpStreamGuard, DLP_MAX_PATTERN_LEN } from '../src/dlp/streamGuard.js';
import { config } from '../src/config.js';

describe('dlp detectors', () => {
  it('detects and redacts SSNs with a visible marker', () => {
    const { text, detections } = redactText('my ssn is 123-45-6789 ok');
    expect(text).toBe(`my ssn is ${DLP_MARKERS.ssn} ok`);
    expect(detections).toEqual(['ssn']);
  });

  it('detects Luhn-valid card numbers with spaces and dashes', () => {
    // 4111-1111-1111-1111 (Visa test) and 378282246310005 (Amex test).
    const { text, detections } = redactText('pay 4111-1111-1111-1111 or 378282246310005 now');
    expect(text).toBe(`pay ${DLP_MARKERS.credit_card} or ${DLP_MARKERS.credit_card} now`);
    expect(detections).toEqual(['credit_card', 'credit_card']);
  });

  it('does not redact digit runs that fail Luhn', () => {
    const input = 'order 4111-1111-1111-1112 ref 1234567890123456';
    const { text, detections } = redactText(input);
    expect(text).toBe(input);
    expect(detections).toEqual([]);
  });

  it('does not false-positive on order numbers, UUIDs, or long runs', () => {
    const inputs = [
      'order SO-66012 shipped',
      'id 550e8400-e29b-41d4-a716-446655440000 done',
      'snowflake 12345678901234567890 here',
      'call 555-123-4567 today',
    ];
    for (const input of inputs) {
      const { text, detections } = redactText(input);
      expect(text).toBe(input);
      expect(detections).toEqual([]);
    }
  });

  it('findDlpMatches returns offsets in order without overlaps', () => {
    const text = 'a 123-45-6789 b 4111111111111111 c';
    const matches = findDlpMatches(text);
    expect(matches).toHaveLength(2);
    expect(text.slice(matches[0]!.start, matches[0]!.end)).toBe('123-45-6789');
    expect(text.slice(matches[1]!.start, matches[1]!.end)).toBe('4111111111111111');
  });

  it('luhnValid enforces length and checksum', () => {
    expect(luhnValid('4111111111111111')).toBe(true);
    expect(luhnValid('4111111111111112')).toBe(false);
    expect(luhnValid('123')).toBe(false);
  });

  it('redacts true PANs in plausible groupings (spaced, dashed, Amex, contiguous)', () => {
    // Visa test PAN 4111111111111111 and Amex test PAN 378282246310005.
    const inputs = [
      'card 4111 1111 1111 1111 ok',
      'card 4111-1111-1111-1111 ok',
      'card 3782 822463 10005 ok', // Amex 4-6-5
      'card 4111111111111111 ok',
      'card 378282246310005 ok',
    ];
    for (const input of inputs) {
      const { text, detections } = redactText(input);
      expect(text).toBe(`card ${DLP_MARKERS.credit_card} ok`);
      expect(detections).toEqual(['credit_card']);
    }
  });

  it('does not redact Luhn-passing digit runs with implausible PAN groupings (ERP tables)', () => {
    // Spaced ERP numeric columns whose digit runs pass Luhn by chance but
    // are grouped 4-5-3-5 and 5-5-6 — no card network groups PANs that way.
    const inputs = [
      'row: qty 1200 34500 800 12908 pcs',
      'totals 12000 34500 800136 end',
    ];
    for (const input of inputs) {
      expect(luhnValid(input.replace(/\D/g, ''))).toBe(true); // guard: the test is meaningful
      const { text, detections } = redactText(input);
      expect(text).toBe(input);
      expect(detections).toEqual([]);
    }
  });

  it('rejects mixed separators even when the digits pass Luhn', () => {
    const input = 'card 4111-1111 1111-1111 ok'; // 4111111111111111 passes Luhn
    const { text, detections } = redactText(input);
    expect(text).toBe(input);
    expect(detections).toEqual([]);
  });

  it('panShapePlausible accepts real PAN shapes and rejects table-like ones', () => {
    expect(panShapePlausible('4111 1111 1111 1111')).toBe(true);
    expect(panShapePlausible('4111-1111-1111-1111')).toBe(true);
    expect(panShapePlausible('3782 822463 10005')).toBe(true); // Amex 4-6-5
    expect(panShapePlausible('3056 930902 5904')).toBe(true); // Diners 4-6-4
    expect(panShapePlausible('4111111111111111')).toBe(true); // contiguous
    expect(panShapePlausible('1200 34500 800 12908')).toBe(false); // 4-5-3-5
    expect(panShapePlausible('12000 34500 800136')).toBe(false); // 5-5-6
    expect(panShapePlausible('4111-1111 1111-1111')).toBe(false); // mixed separators
    expect(panShapePlausible('1234')).toBe(false); // too short
  });
});

describe('dlp stream guard', () => {
  it('emits clean text immediately — no added latency without trailing digits', async () => {
    const guard = new DlpStreamGuard(false);
    const first = await guard.process('hello world, this is a test of the streaming guard');
    expect(first.emit).toBe('hello world, this is a test of the streaming guard');
    expect(first.detections).toEqual([]);
    const flushed = await guard.flush();
    expect(flushed.emit).toBe('');
  });

  it('holds back only the trailing digit run until the next chunk', async () => {
    const guard = new DlpStreamGuard(false);
    const first = await guard.process('order 12345');
    expect(first.emit).toBe('order');
    const second = await guard.process(' shipped');
    // No pattern formed: the held run flows out with the next chunk.
    expect(second.emit).toBe(' 12345 shipped');
    const flushed = await guard.flush();
    expect(flushed.emit).toBe('');
  });

  it('catches a pattern split across chunks with a single marker', async () => {
    const guard = new DlpStreamGuard(false);
    const emits: string[] = [];
    // Card number split mid-way across three provider chunks.
    for (const chunk of ['the card is 4111 1111 11', '11 1111 and the ssn ', '123-45-6789 done']) {
      const { emit, detections } = await guard.process(chunk);
      emits.push(emit);
      void detections;
    }
    const flushed = await guard.flush();
    emits.push(flushed.emit);
    const combined = emits.join('');
    // The full sensitive values never appear in any emission.
    expect(combined).not.toContain('4111 1111 1111 1111');
    expect(combined).not.toContain('123-45-6789');
    expect(combined).toContain(DLP_MARKERS.credit_card);
    expect(combined).toContain(DLP_MARKERS.ssn);
    expect(combined).toContain('done');
  });

  it('never emits partial digits of a cross-boundary match', async () => {
    const guard = new DlpStreamGuard(false);
    const filler = 'x'.repeat(DLP_MAX_PATTERN_LEN + 10);
    const emits: string[] = [];
    // The SSN lands exactly across the emit/hold split.
    const first = await guard.process(filler + 'ssn 123-45-67');
    emits.push(first.emit);
    expect(first.emit).toBe(filler + 'ssn');
    const second = await guard.process('89 end');
    emits.push(second.emit);
    const flushed = await guard.flush();
    emits.push(flushed.emit);
    const combined = emits.join('');
    expect(combined).not.toContain('123-45-6789');
    expect(combined).toContain(DLP_MARKERS.ssn);
  });

  it('redacts a pattern completed exactly at flush time', async () => {
    const guard = new DlpStreamGuard(false);
    const first = await guard.process('ssn 123-45-678');
    expect(first.emit).toBe('ssn');
    const second = await guard.process('9');
    // Still held: a complete digit-shaped run at the window end.
    expect(second.emit).toBe('');
    const flushed = await guard.flush();
    expect(flushed.emit).toBe(' ' + DLP_MARKERS.ssn);
    expect(flushed.detections).toEqual(['ssn']);
  });

  it('accumulates detections across the whole turn', async () => {
    const guard = new DlpStreamGuard(false);
    const kinds: string[] = [];
    for (const chunk of ['a 123-45-6789 ', 'b 4111111111111111 ', 'c']) {
      const { detections } = await guard.process(chunk);
      kinds.push(...detections);
    }
    kinds.push(...(await guard.flush()).detections);
    expect(kinds).toEqual(['ssn', 'credit_card']);
  });
});

describe('dlp external hook', () => {
  const originalEndpoint = config.DLP_EXTERNAL_ENDPOINT;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = originalEndpoint;
  });

  it('applies the hook redaction on top of built-in redaction', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = 'https://dlp.example/scan';
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'hook says [custom]' }),
    });
    const guard = new DlpStreamGuard(true);
    const { emit } = await guard.process('some clean text with no trailing digits');
    expect(emit).toBe('hook says [custom]');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://dlp.example/scan',
      expect.objectContaining({ method: 'POST' })
    );
    const flushed = await guard.flush();
    expect(flushed.emit).toBe('');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never overlaps hook calls when the guard is used concurrently', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = 'https://dlp.example/scan';
    let resolveHook!: (value: unknown) => void;
    fetchMock.mockReturnValue(
      new Promise((resolve) => {
        resolveHook = resolve;
      })
    );
    const guard = new DlpStreamGuard(true);
    const first = guard.process('first window text');
    // While the first hook call is still in flight, a concurrent window
    // flows through with built-in redaction only instead of queueing
    // behind it. (In the chat route windows are sequential and each one
    // awaits the hook, bounded by DLP_EXTERNAL_TIMEOUT_MS.)
    const second = await guard.process('second window text');
    expect(second.emit).toBe('second window text');
    resolveHook({ ok: true, json: async () => ({ text: 'hook first' }) });
    expect((await first).emit).toBe('hook first');
    const flushed = await guard.flush();
    expect(flushed.emit).toBe('');
  });

  it('fails open to built-in redaction when the hook errors', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = 'https://dlp.example/scan';
    fetchMock.mockRejectedValue(new Error('sidecar down'));
    const guard = new DlpStreamGuard(true);
    const { emit } = await guard.process('card 4111-1111-1111-1111 ' + 'z'.repeat(80));
    const flushed = await guard.flush();
    const combined = emit + flushed.emit;
    expect(combined).toContain(DLP_MARKERS.credit_card);
    expect(combined).not.toContain('4111-1111-1111-1111');
  });

  it('does not call the hook when unconfigured', async () => {
    (config as Record<string, unknown>).DLP_EXTERNAL_ENDPOINT = undefined;
    const guard = new DlpStreamGuard(false);
    await guard.process('plain text ' + 'w'.repeat(80));
    await guard.flush();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
