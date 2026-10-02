/**
 * probe.ts — capability probing for Studio connections.
 *
 * Never claim an operation works without a successful probe. On test/save,
 * the probe hits the connection's upstream for the 7 known GET endpoints
 * (bound to the real catalog actions) plus the documented candidate write
 * endpoints, and stores per-operation status (ok / unsupported / error).
 *
 * Safety: write candidates are probed with OPTIONS only — never POST/PUT/
 * DELETE against an unknown upstream, because a real write handler could
 * mutate SyteLine state. An OPTIONS 2xx means the endpoint exists (its
 * Allow header is recorded); 404/405/501 means the upstream has no such
 * endpoint; anything else is an honest error. Until a write candidate
 * probes ok, its catalog entry shows supported:false with the reason.
 *
 * GET probes read only the first response chunk (then cancel the body) so
 * a collection endpoint without pagination cannot dump a huge payload into
 * the probe.
 */

import type { CapabilityProbeStatus } from '../types.js';

export type FetchFn = typeof fetch;

export interface ProbeCandidate {
  /** Catalog action id (or candidate op id for writes). */
  operationId: string;
  method: 'GET' | 'OPTIONS';
  path: string;
  /** When true this candidate mutates state and must only ever be
   *  probed safely (OPTIONS). */
  writeCandidate: boolean;
}

export const GET_CANDIDATES: ProbeCandidate[] = [
  { operationId: 'syteline.getItem', method: 'GET', path: '/api/items', writeCandidate: false },
  { operationId: 'syteline.getSalesOrder', method: 'GET', path: '/api/sales-orders', writeCandidate: false },
  { operationId: 'syteline.getItemAvailability', method: 'GET', path: '/api/items/availability', writeCandidate: false },
  { operationId: 'syteline.getOpenPurchaseOrders', method: 'GET', path: '/api/purchase-orders', writeCandidate: false },
  { operationId: 'syteline.getWorkOrders', method: 'GET', path: '/api/work-orders', writeCandidate: false },
  { operationId: 'syteline.getBom', method: 'GET', path: '/api/boms', writeCandidate: false },
  { operationId: 'syteline.getCustomer', method: 'GET', path: '/api/customers', writeCandidate: false },
];

/**
 * Documented candidate write endpoints. These do NOT exist on the current
 * upstream (the read-only REST API): they are listed so the probe can
 * honestly record their absence and the catalog can show write entries as
 * supported:false + reason instead of pretending they work.
 */
export const WRITE_CANDIDATES: ProbeCandidate[] = [
  { operationId: 'syteline.record.create', method: 'OPTIONS', path: '/api/records', writeCandidate: true },
  { operationId: 'syteline.record.update', method: 'OPTIONS', path: '/api/records', writeCandidate: true },
  { operationId: 'syteline.record.delete', method: 'OPTIONS', path: '/api/records', writeCandidate: true },
  { operationId: 'syteline.ido.invoke', method: 'OPTIONS', path: '/api/ido/invoke', writeCandidate: true },
];

export const PROBE_CANDIDATES: ProbeCandidate[] = [...GET_CANDIDATES, ...WRITE_CANDIDATES];

const PROBE_TIMEOUT_MS = 10000;

function classify(status: number, candidate: ProbeCandidate): CapabilityProbeStatus['status'] {
  if (status >= 200 && status < 400) return 'ok';
  if (status === 404 || status === 405 || status === 501) return 'unsupported';
  return 'error';
}

async function probeOne(
  baseUrl: string,
  token: Buffer,
  candidate: ProbeCandidate,
  fetchFn: FetchFn
): Promise<CapabilityProbeStatus> {
  const url = new URL(candidate.path, baseUrl).toString();
  const headers: Record<string, string> = { accept: 'application/json' };
  // The bearer token is sent only to the connection's own baseUrl (already
  // HTTPS-or-loopback validated at store time) and never leaves this call.
  const tokenText = token.toString('utf8');
  headers.authorization = `Bearer ${tokenText}`;

  const probedAt = new Date().toISOString();
  let response: Response;
  try {
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    response = await fetchFn(url, { method: candidate.method, headers, signal });
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'request failed';
    return {
      operationId: candidate.operationId,
      probedMethod: candidate.method,
      probedPath: candidate.path,
      status: 'error',
      detail: detail.length > 200 ? detail.slice(0, 200) : detail,
      probedAt,
    };
  }
  const status = classify(response.status, candidate);
  let detail: string | undefined;
  if (status === 'ok') {
    if (candidate.method === 'GET') {
      // Read one chunk to prove the body exists, then stop.
      try {
        const reader = response.body?.getReader();
        if (reader) {
          await reader.read();
          await reader.cancel();
        }
      } catch {
        // The status already proved the endpoint; body read is best-effort.
      }
    } else {
      const allow = response.headers.get('allow');
      if (allow) detail = `Allow: ${allow}`;
    }
  } else if (status === 'unsupported') {
    detail =
      candidate.writeCandidate
        ? `OPTIONS ${response.status}: the upstream exposes no write endpoint here`
        : `GET ${response.status}: endpoint not exposed by this upstream`;
  } else {
    detail =
      response.status === 401 || response.status === 403
        ? `HTTP ${response.status}: unauthorized — check the connection's token`
        : `HTTP ${response.status}`;
  }
  return {
    operationId: candidate.operationId,
    probedMethod: candidate.method,
    probedPath: candidate.path,
    status,
    httpStatus: response.status,
    ...(detail ? { detail } : {}),
    probedAt,
  };
}

export interface ConnectionProbeResult {
  probedAt: string;
  reachable: boolean;
  operations: CapabilityProbeStatus[];
}

/**
 * Probe every known + candidate operation against the connection's upstream.
 * `token` is used in-memory for the probe requests; callers zero-fill it
 * when the probe completes. Fetch is injectable for tests.
 */
export async function probeConnection(
  baseUrl: string,
  token: Buffer,
  fetchFn: FetchFn = fetch
): Promise<ConnectionProbeResult> {
  const operations: CapabilityProbeStatus[] = [];
  for (const candidate of PROBE_CANDIDATES) {
    operations.push(await probeOne(baseUrl, token, candidate, fetchFn));
  }
  const probedAt = new Date().toISOString();
  const reachable = operations.some((op) => op.status === 'ok');
  return { probedAt, reachable, operations };
}

/** Look up the last probe status for one operation id. */
export function probeStatusFor(
  operations: CapabilityProbeStatus[] | undefined,
  operationId: string
): CapabilityProbeStatus['status'] | undefined {
  return operations?.find((op) => op.operationId === operationId)?.status;
}
