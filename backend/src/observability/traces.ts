/**
 * observability/traces.ts — trace/request correlation helpers.
 *
 * Correlation scheme (documented in docs/scale.md):
 *
 * - Every inbound request gets a `requestId` (client-supplied via
 *   `x-request-id`, or a generated UUID) and a `traceId` (the W3C
 *   `traceparent` trace-id when the client sends a valid header, otherwise a
 *   generated 32-hex-char id). Both are echoed back as `x-request-id` /
 *   `x-trace-id` response headers — see requestId.ts.
 * - server.ts attaches both as fields on the per-request pino logger
 *   (`req.log.child({ requestId, traceId })`), so every log line emitted
 *   through `req.log` — gateway, provider, tool calls — carries them.
 * - Outbound provider calls forward the trace context: the chat gateway
 *   passes `requestId` into gatewayStream, and tool executions receive it via
 *   runToolCall's `requestId` option. A downstream service that understands
 *   W3C traceparent can continue the trace with
 *   `traceparent: 00-{traceId}-{spanId}-01`.
 */
import { FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';

export interface TraceContext {
  requestId?: string;
  traceId?: string;
}

/** Pick the correlation fields off a request (or anything carrying them). */
export function correlationFields(source: TraceContext): { requestId?: string; traceId?: string } {
  const fields: { requestId?: string; traceId?: string } = {};
  if (source.requestId) fields.requestId = source.requestId;
  if (source.traceId) fields.traceId = source.traceId;
  return fields;
}

/**
 * Build a W3C `traceparent` header value that continues this request's trace
 * as a new child span. `spanId` must be 16 lowercase hex chars; when omitted
 * a random one is generated.
 */
export function buildTraceparent(traceId: string, spanId?: string): string {
  const span = spanId ?? randomBytes(8).toString('hex');
  return `00-${traceId}-${span}-01`;
}

/** Type guard for Fastify requests that have passed through requestIdHook. */
export function hasTraceContext(req: FastifyRequest): req is FastifyRequest & Required<TraceContext> {
  return typeof (req as TraceContext).requestId === 'string' && typeof (req as TraceContext).traceId === 'string';
}
