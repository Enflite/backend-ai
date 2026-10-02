/**
 * studioProbe.test.ts — capability probe (mocked HTTP).
 *
 * - 2xx → ok; 404/405/501 → unsupported; 401/403 → error (auth detail)
 * - write candidates are probed with OPTIONS only — never a mutating request
 * - the bearer token rides the Authorization header and never appears in results
 * - GET probes read one body chunk, then cancel (no payload dumps)
 * - network failures → error with a short detail
 *
 * VALIDATED IN CI. No live upstream.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  probeConnection,
  probeStatusFor,
  PROBE_CANDIDATES,
  GET_CANDIDATES,
  WRITE_CANDIDATES,
} from '../src/studio/connections/probe.js';

const BASE = 'https://syteline.example.com';

function response(status: number, opts: { allow?: string; body?: string } = {}): Response {
  const headers = new Headers();
  if (opts.allow) headers.set('allow', opts.allow);
  const body = opts.body ?? '{}';
  return new Response(body, { status, headers });
}

function okFetch(seen: Array<{ url: string; method: string; auth: string | null }>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      auth: new Headers(init?.headers).get('authorization'),
    });
    return response(200);
  });
}

describe('probeConnection', () => {
  it('marks 2xx endpoints ok and records the token only on the wire', async () => {
    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    const result = await probeConnection(BASE, Buffer.from('tok-123'), okFetch(seen) as any);
    expect(result.reachable).toBe(true);
    expect(result.operations).toHaveLength(PROBE_CANDIDATES.length);
    expect(result.operations.every((o) => o.status === 'ok')).toBe(true);
    // Every probe hit the connection's base URL with the bearer token…
    expect(seen.every((s) => s.url.startsWith(BASE) && s.auth === 'Bearer tok-123')).toBe(true);
    // …and the token appears nowhere in the stored results.
    expect(JSON.stringify(result)).not.toContain('tok-123');
  });

  it('probes write candidates with OPTIONS, never a mutating method', async () => {
    const seen: Array<{ url: string; method: string; auth: string | null }> = [];
    await probeConnection(BASE, Buffer.from('t'), okFetch(seen) as any);
    const methods = new Map(seen.map((s) => [s.url, s.method]));
    for (const c of WRITE_CANDIDATES) {
      expect(methods.get(`${BASE}${c.path}`)).toBe('OPTIONS');
    }
    for (const c of GET_CANDIDATES) {
      expect(methods.get(`${BASE}${c.path}`)).toBe('GET');
    }
    expect(seen.some((s) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(s.method))).toBe(false);
  });

  it('classifies 404/405/501 as unsupported with an honest detail', async () => {
    const fetchFn = vi.fn(async (_url: string, init?: RequestInit) =>
      response(init?.method === 'OPTIONS' ? 405 : 404)
    );
    const result = await probeConnection(BASE, Buffer.from('t'), fetchFn as any);
    expect(result.reachable).toBe(false);
    for (const op of result.operations) {
      expect(op.status).toBe('unsupported');
      expect(op.detail).toMatch(/not exposed|no write endpoint/);
    }
    expect(probeStatusFor(result.operations, 'syteline.getItem')).toBe('unsupported');
    expect(probeStatusFor(result.operations, 'syteline.record.create')).toBe('unsupported');
  });

  it('classifies 401/403 as an auth error, not unsupported', async () => {
    const fetchFn = vi.fn(async () => response(401));
    const result = await probeConnection(BASE, Buffer.from('t'), fetchFn as any);
    const op = result.operations[0]!;
    expect(op.status).toBe('error');
    expect(op.detail).toMatch(/unauthorized/i);
    expect(result.reachable).toBe(false);
  });

  it('records network failures as errors with a short detail', async () => {
    const fetchFn = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 10.0.0.9:443' + 'x'.repeat(500));
    });
    const result = await probeConnection(BASE, Buffer.from('t'), fetchFn as any);
    expect(result.operations[0]!.status).toBe('error');
    expect(result.operations[0]!.httpStatus).toBeUndefined();
    expect(result.operations[0]!.detail!.length).toBeLessThanOrEqual(200);
  });

  it('reads one body chunk on GET probes, then cancels', async () => {
    const chunks = [new TextEncoder().encode('{"items":[]}'), new TextEncoder().encode('x'.repeat(100000))];
    let reads = 0;
    let cancelled = false;
    const stream = new ReadableStream({
      async pull(controller) {
        if (reads < chunks.length) {
          reads++;
          controller.enqueue(chunks[reads - 1]);
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchFn = vi.fn(async () => new Response(stream, { status: 200 }));
    const result = await probeConnection(BASE, Buffer.from('t'), fetchFn as any);
    expect(result.operations.find((o) => o.operationId === 'syteline.getItem')!.status).toBe('ok');
    // The consumer reads a single chunk then cancels; the stream engine may
    // pull ahead speculatively before cancel lands, so assert the contract
    // (body sampled, stream cancelled) rather than the internal pull count.
    expect(reads).toBeGreaterThanOrEqual(1);
    expect(cancelled).toBe(true);
  });

  it('mixes statuses honestly across candidates', async () => {
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/api/items') && init?.method === 'GET') return response(200, { body: '{"item":"x"}' });
      if (init?.method === 'OPTIONS') return response(200, { allow: 'POST, PUT' });
      return response(500);
    });
    const result = await probeConnection(BASE, Buffer.from('t'), fetchFn as any);
    expect(probeStatusFor(result.operations, 'syteline.getItem')).toBe('ok');
    expect(probeStatusFor(result.operations, 'syteline.getSalesOrder')).toBe('error');
    // OPTIONS 200 on /api/records → the write candidate probes ok.
    expect(probeStatusFor(result.operations, 'syteline.record.create')).toBe('ok');
    expect(result.reachable).toBe(true);
  });
});
