/**
 * testAction.ts — single-action test execution (the "Postman half").
 *
 * Executes ONE catalog action against the REAL upstream of a named
 * connection and returns the request that was sent plus the response that
 * came back (status, truncated body, duration). No mocks, no fixtures.
 *
 * The execution itself lives in the shared core (execution/executeAction.ts)
 * so the test endpoint and the flow tools (`studio.executeAction` /
 * `studio.executeWriteAction`) run the identical honest path. This module
 * adds the endpoint's audit contract on top:
 *
 * - unknown action → 404 (no audit; nothing was attempted)
 * - action unsupported / unprobed / upstream unreachable → 409/502 with a
 *   STUDIO_ACTION_TESTED failure audit
 * - invalid params → 400 (no audit; nothing left the box)
 * - completed request → STUDIO_ACTION_TESTED with success = 2xx
 *
 * The token is decrypted in memory for the single request and the buffer
 * is zero-filled in a finally block (in the shared core). The token never
 * appears in the request view, logs, audit events, or errors.
 */

import { Errors } from '../../errors.js';
import type { AuthContext } from '../../authz/permissions.js';
import { recordAudit } from '../../audit/audit.js';
import { getCatalogAction } from '../catalog/catalog.js';
import type { ActionTestResult, CapabilityProbeStatus } from '../types.js';
import {
  executeCatalogAction,
  isAuditedActionFailure,
  type FetchFn,
} from './executeAction.js';

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
  // Unknown action: 404 before anything is attempted (no audit).
  const entry = getCatalogAction(actionId);
  if (!entry) {
    throw Errors.notFound('STUDIO_ACTION_NOT_FOUND', `Unknown action '${actionId}'`);
  }

  const auditFailure = async (reason: string, metadata: Record<string, unknown>) => {
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: options.requestId,
      action: 'STUDIO_ACTION_TESTED',
      success: false,
      reason,
      metadata: { connectionId, actionId, ...metadata },
    });
  };

  let result;
  try {
    result = await executeCatalogAction(
      auth.tenantId,
      connectionId,
      actionId,
      params,
      probeOperations,
      { fetchFn: options.fetchFn }
    );
  } catch (error) {
    if (isAuditedActionFailure(error)) {
      const code = (error as { code?: string }).code;
      await auditFailure(
        code === 'STUDIO_ACTION_UNSUPPORTED'
          ? 'Action is not supported on the current upstream'
          : code === 'STUDIO_ACTION_UNPROBED'
            ? 'Action availability not confirmed by capability probe'
            : 'Upstream request failed',
        code === 'STUDIO_UPSTREAM_UNREACHABLE'
          ? { detail: (error as { rawDetail?: string }).rawDetail ?? '' }
          : { supported: false }
      );
    }
    throw error;
  }

  const actionResult: ActionTestResult = {
    request: result.request,
    response: {
      status: result.status,
      bodyTruncated: { truncated: result.bodyTruncated, preview: result.bodyText },
      durationMs: result.durationMs,
    },
    connectionId: result.connectionId,
    actionId: result.actionId,
    executedAt: new Date().toISOString(),
  };
  const ok = result.status >= 200 && result.status < 300;
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    requestId: options.requestId,
    action: 'STUDIO_ACTION_TESTED',
    success: ok,
    reason: ok ? undefined : `Upstream returned HTTP ${result.status}`,
    metadata: { connectionId, actionId, httpStatus: result.status, durationMs: result.durationMs },
  });
  return actionResult;
}
