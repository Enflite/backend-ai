/**
 * executeAction.ts — shared execution core for catalog actions.
 *
 * One honest path for running a catalog action against a connection's real
 * upstream, used by:
 * - the single-action test endpoint (execution/testAction.ts), and
 * - the flow tools `studio.executeAction` / `studio.executeWriteAction`
 *   (automations/tools.ts), which is how compiled automations execute.
 *
 * Honesty rules (identical everywhere):
 * - unknown action → 404 STUDIO_ACTION_NOT_FOUND
 * - action not bound to a real operation, or a write op the upstream
 *   lacks → 409 STUDIO_ACTION_UNSUPPORTED, never executed
 * - action not confirmed by the connection's capability probe →
 *   409 STUDIO_ACTION_UNPROBED, never executed
 * - invalid params → 400 VALIDATION_ERROR
 * - upstream unreachable → 502 STUDIO_UPSTREAM_UNREACHABLE
 *
 * The bearer token is decrypted in memory for the single request and the
 * buffer is zero-filled in a finally block. It never appears in results,
 * logs, or errors. This module does NOT audit — callers audit in their own
 * context (the test endpoint audits STUDIO_ACTION_TESTED; flow executions
 * are audited by runToolCall + the flow runner's step audit).
 */

import { config } from '../../config.js';
import { Errors, AppError } from '../../errors.js';
import { probeConnection } from '../connections/probe.js';
import { getConnection, resolveConnectionTarget } from '../connections/store.js';
import { getCatalogAction, evaluateAvailability } from '../catalog/catalog.js';
import type { CapabilityProbeStatus } from '../types.js';

export type FetchFn = typeof fetch;

/** Response body preview cap: enough to inspect, never a context dump. */
const BODY_PREVIEW_BYTES = 16 * 1024;

export interface CatalogActionRequestView {
  method: string;
  /** The URL that was hit, token-free. */
  url: string;
  params: Record<string, unknown>;
}

export interface CatalogActionHttpResult {
  request: CatalogActionRequestView;
  /** Upstream HTTP status. */
  status: number;
  /** Response body preview (capped at BODY_PREVIEW_BYTES). */
  bodyText: string;
  bodyTruncated: boolean;
  durationMs: number;
  connectionId: string;
  connectionName: string;
  actionId: string;
}

export interface ExecuteActionOptions {
  fetchFn?: FetchFn;
  /** Cooperative cancellation (the flow runner passes its step signal). */
  signal?: AbortSignal;
}

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

/** Combine the caller's signal with the upstream timeout into one signal. */
function requestSignal(external: AbortSignal | undefined): {
  signal: AbortSignal;
  cleanup: () => void;
} {
  const timeout = AbortSignal.timeout(config.SYTELINE_TIMEOUT_MS);
  if (!external || external.aborted) {
    return { signal: external?.aborted ? external : timeout, cleanup: () => undefined };
  }
  const controller = new AbortController();
  const onTimeout = (): void => controller.abort(timeout.reason);
  const onExternal = (): void => controller.abort(external.reason);
  timeout.addEventListener('abort', onTimeout, { once: true });
  external.addEventListener('abort', onExternal, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      timeout.removeEventListener('abort', onTimeout);
      external.removeEventListener('abort', onExternal);
    },
  };
}

/**
 * Resolve the capability-probe operations used to gate an action.
 * Stored connections carry their last probe; the env-backed 'default' is
 * probed live (its probe is never persisted) — the same honesty model as
 * the catalog and single-action test endpoints.
 */
export async function resolveProbeOperations(
  tenantId: string,
  connectionId: string,
): Promise<CapabilityProbeStatus[] | undefined> {
  if (connectionId === 'default') {
    const target = await resolveConnectionTarget(tenantId, connectionId);
    try {
      return (await probeConnection(target.baseUrl, target.token)).operations;
    } finally {
      target.token.fill(0);
    }
  }
  const doc = await getConnection(tenantId, connectionId);
  if (!doc) {
    throw Errors.conflict(
      'STUDIO_CONNECTION_NOT_FOUND',
      `Connection '${connectionId}' does not exist in this tenant. Create it under /api/v1/studio/connections first.`,
    );
  }
  return doc.probe?.operations;
}

/**
 * Execute one catalog action against the real upstream of `connectionId`.
 * Throws AppError (404/409/400/502); never executes an unsupported action.
 * No audit here — callers audit in their own context.
 */
export async function executeCatalogAction(
  tenantId: string,
  connectionId: string,
  actionId: string,
  params: Record<string, unknown>,
  probeOperations: CapabilityProbeStatus[] | undefined,
  options: ExecuteActionOptions = {},
): Promise<CatalogActionHttpResult> {
  const fetchFn = options.fetchFn ?? fetch;

  const entry = getCatalogAction(actionId);
  if (!entry) {
    throw Errors.notFound('STUDIO_ACTION_NOT_FOUND', `Unknown action '${actionId}'`);
  }
  if (!entry.operation || !entry.knownReal) {
    throw Errors.conflict(
      'STUDIO_ACTION_UNSUPPORTED',
      `'${actionId}' is not available: ${entry.unsupportedReason ?? 'the upstream does not expose this operation'}`,
    );
  }

  const { supported, supportReason } = evaluateAvailability(entry, probeOperations);
  if (!supported) {
    throw Errors.conflict('STUDIO_ACTION_UNPROBED', `'${actionId}' cannot run yet: ${supportReason}`);
  }

  const parsed = entry.paramsSchema.safeParse(params);
  if (!parsed.success) {
    throw Errors.badRequest(
      'VALIDATION_ERROR',
      `Invalid params for action '${actionId}'`,
      parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    );
  }

  const connection = await resolveConnectionTarget(tenantId, connectionId);
  const { signal, cleanup } = requestSignal(options.signal);
  const startedAt = Date.now();
  try {
    const url = buildUrl(connection.baseUrl, entry.operation.path, parsed.data as Record<string, unknown>);
    let response: Response;
    try {
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
      const gatewayError = Errors.badGateway(
        'STUDIO_UPSTREAM_UNREACHABLE',
        `The '${connection.name}' connection's upstream did not answer: ${detail.slice(0, 200)}`,
      );
      // The raw fetch detail (unprefixed) for callers that audit it.
      (gatewayError as { rawDetail?: string }).rawDetail = detail.slice(0, 200);
      throw gatewayError;
    }
    const { preview, truncated } = await readBodyPreview(response);
    return {
      request: {
        method: entry.operation.method,
        url: url.toString(),
        params: parsed.data as Record<string, unknown>,
      },
      status: response.status,
      bodyText: preview,
      bodyTruncated: truncated,
      durationMs: Date.now() - startedAt,
      connectionId: connection.id,
      connectionName: connection.name,
      actionId: entry.id,
    };
  } finally {
    cleanup();
    connection.token.fill(0);
  }
}

/** True for the failure codes the test endpoint audits (mirrors the
 *  pre-refactor testAction audit behavior exactly). */
export function isAuditedActionFailure(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'STUDIO_ACTION_UNSUPPORTED' ||
      error.code === 'STUDIO_ACTION_UNPROBED' ||
      error.code === 'STUDIO_UPSTREAM_UNREACHABLE')
  );
}
