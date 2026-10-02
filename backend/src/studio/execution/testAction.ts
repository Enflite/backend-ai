/**
 * testAction.ts — single-action test execution (the "Postman half").
 *
 * Executes ONE catalog action against the REAL upstream of a named
 * connection and returns the request that was sent plus the response that
 * came back (status, truncated body, duration). No mocks, no fixtures.
 *
 * Honesty rules:
 * - unknown connection → 409 STUDIO_CONNECTION_NOT_FOUND / _NOT_CONFIGURED
 * - unknown action → 404
 * - action not supported on this connection (no successful probe, or a
 *   write op the upstream lacks) → 409, never executed
 * - invalid params → 400 with the zod issues
 * - upstream unreachable → 502 with a clear message
 *
 * The token is decrypted in memory for the single request and the buffer
 * is zero-filled in a finally block. The token never appears in the
 * request view, logs, audit events, or errors.
 */

import { config } from '../../config.js';
import { Errors } from '../../errors.js';
import type { AuthContext } from '../../authz/permissions.js';
import { recordAudit } from '../../audit/audit.js';
import { resolveConnectionTarget } from '../connections/store.js';
import { getCatalogAction, evaluateAvailability } from '../catalog/catalog.js';
import type { ActionTestResult, CapabilityProbeStatus } from '../types.js';

export type FetchFn = typeof fetch;

/** Response body preview cap: enough to inspect, never a context dump. */
const BODY_PREVIEW_BYTES = 16 * 1024;

function buildUrl(baseUrl: string, path: string, params: Record<string, unknown>): URL {
  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

async function readBodyPreview(response: Response): Promise<{ preview: string; truncated: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { preview: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = BODY_PREVIEW_BYTES - total;
      if (value.length >= remaining) {
        chunks.push(value.subarray(0, remaining));
        total = BODY_PREVIEW_BYTES;
        truncated = true;
        break;
      }
      chunks.push(value);
      total += value.length;
    }
    await reader.cancel();
  } catch {
    // Body read is best-effort; the status already told the story.
    truncated = total >= BODY_PREVIEW_BYTES;
  }
  const bytes = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return { preview: bytes.toString('utf8'), truncated };
}

export interface TestActionOptions {
  fetchFn?: FetchFn;
  requestId?: string;
}

/**
 * Execute one catalog action against the real upstream of `connectionId`.
 * Throws AppError (409/404/400/502); never executes an unsupported action.
 */
export async function testAction(
  auth: AuthContext,
  connectionId: string,
  actionId: string,
  params: Record<string, unknown>,
  probeOperations: CapabilityProbeStatus[] | undefined,
  options: TestActionOptions = {}
): Promise<ActionTestResult> {
  const fetchFn = options.fetchFn ?? fetch;

  const entry = getCatalogAction(actionId);
  if (!entry) {
    throw Errors.notFound('STUDIO_ACTION_NOT_FOUND', `Unknown action '${actionId}'`);
  }
  if (!entry.operation || !entry.knownReal) {
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: options.requestId,
      action: 'STUDIO_ACTION_TESTED',
      success: false,
      reason: 'Action is not supported on the current upstream',
      metadata: { connectionId, actionId, supported: false },
    });
    throw Errors.conflict(
      'STUDIO_ACTION_UNSUPPORTED',
      `'${actionId}' is not available: ${entry.unsupportedReason ?? 'the upstream does not expose this operation'}`
    );
  }

  const { supported, supportReason } = evaluateAvailability(entry, probeOperations);
  if (!supported) {
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: options.requestId,
      action: 'STUDIO_ACTION_TESTED',
      success: false,
      reason: 'Action availability not confirmed by capability probe',
      metadata: { connectionId, actionId, supported: false },
    });
    throw Errors.conflict('STUDIO_ACTION_UNPROBED', `'${actionId}' cannot run yet: ${supportReason}`);
  }

  const parsed = entry.paramsSchema.safeParse(params);
  if (!parsed.success) {
    throw Errors.badRequest(
      'VALIDATION_ERROR',
      `Invalid params for action '${actionId}'`,
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    );
  }

  const connection = await resolveConnectionTarget(auth.tenantId, connectionId);
  const startedAt = Date.now();
  try {
    const url = buildUrl(connection.baseUrl, entry.operation.path, parsed.data as Record<string, unknown>);
    let response: Response;
    try {
      const signal = AbortSignal.timeout(config.SYTELINE_TIMEOUT_MS);
      response = await fetchFn(url.toString(), {
        method: entry.operation.method,
        headers: {
          authorization: `Bearer ${connection.token.toString('utf8')}`,
          accept: 'application/json',
        },
        signal,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : 'request failed';
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: options.requestId,
        action: 'STUDIO_ACTION_TESTED',
        success: false,
        reason: 'Upstream request failed',
        metadata: { connectionId, actionId, detail: detail.slice(0, 200) },
      });
      throw Errors.badGateway(
        'STUDIO_UPSTREAM_UNREACHABLE',
        `The '${connection.name}' connection's upstream did not answer: ${detail.slice(0, 200)}`
      );
    }
    const { preview, truncated } = await readBodyPreview(response);
    const durationMs = Date.now() - startedAt;
    const result: ActionTestResult = {
      request: {
        method: entry.operation.method,
        url: url.toString(),
        params: parsed.data as Record<string, unknown>,
      },
      response: {
        status: response.status,
        bodyTruncated: { truncated, preview },
        durationMs,
      },
      connectionId: connection.id,
      actionId: entry.id,
      executedAt: new Date().toISOString(),
    };
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: options.requestId,
      action: 'STUDIO_ACTION_TESTED',
      success: response.ok,
      reason: response.ok ? undefined : `Upstream returned HTTP ${response.status}`,
      metadata: { connectionId, actionId, httpStatus: response.status, durationMs },
    });
    return result;
  } finally {
    connection.token.fill(0);
  }
}
