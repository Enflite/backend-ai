/**
 * substrate.ts — the narrow seam to the sibling coordinator's APS
 * pipeline (the deterministic exception-resolution substrate).
 *
 * The sibling owns (landed on main, PR #64):
 * - the deterministic rules engine (`backend/src/aps/rules.ts`)
 * - the `aps_issues` store (`backend/src/aps/issues.ts`)
 * - the 10 flow-substrate tools (`backend/src/aps/apsTools.ts`,
 *   registered in the tool registry)
 * - the flow definitions (`flows/aps-exception-analysis.flow.json`,
 *   `flows/aps-exception-verify.flow.json`)
 *
 * This module NEVER rebuilds any of that. It consumes the pipeline only
 * through this seam:
 * - invoke a flow BY NAME through the Flows platform (`createRun` —
 *   the live alias resolves the published version);
 * - read issues/snapshots through the sibling's store (imported
 *   directly — the sibling landed before this PR, so the seam is real,
 *   not mocked).
 *
 * HONESTY: the flow .json files ship in the repo, but flows are
 * tenant data — they must be PUBLISHED on a tenant (live alias) before
 * `createRun` can invoke them. Until then, flow invocation raises
 * `SubstrateUnavailableError` and the REST layer is honest about it
 * (`pending-substrate` / 409 SUBSTRATE_UNAVAILABLE). In tests the seam
 * is mocked via `overrideSubstrateClient` and labeled as mocked.
 */

import type { AuthContext } from '../authz/permissions.js';
import { createRun, getRun } from '../flows/flowStore.js';
import { getIssue as siblingGetIssue, type ApsIssueDoc, type ApsSnapshot } from '../aps/issues.js';
import { Errors } from '../errors.js';
import { SUBSTRATE_FLOW_NAMES } from './version.js';

/** The substrate (sibling pipeline) is not available on this deployment. */
export class SubstrateUnavailableError extends Error {
  readonly code = 'SUBSTRATE_UNAVAILABLE';
  constructor(detail: string) {
    super(`APS pipeline substrate unavailable: ${detail}`);
    this.name = 'SubstrateUnavailableError';
  }
}

/**
 * The sibling's `ApsIssueDoc`, imported directly (sibling landed, PR #64).
 * Snapshot rows are `unknown[]` at rest; callers coerce per-row with
 * `toPlanningRow` (types.ts) before identity matching.
 */
export type SubstrateIssue = ApsIssueDoc;
export type SubstrateIssueSnapshot = ApsSnapshot;

/** Inputs to the sibling's `aps-exception-analysis` flow (its declared inputs). */
export interface AnalysisFlowInput {
  exceptionReportDocumentId: string;
  /** Empty string = create a new issue on first analysis. */
  issueId: string;
  site: string;
}

/** Inputs to the sibling's `aps-exception-verify` flow (its declared inputs). */
export interface VerifyFlowInput {
  issueId: string;
  newReportDocumentId: string;
  site: string;
}

export interface InvokeFlowResult {
  runId: string;
  flowName: string;
  flowVersion: number;
}

/** Narrow interface the module calls; mocked in tests, real after rebase. */
export interface SubstrateClient {
  invokeAnalysisFlow(auth: AuthContext, input: AnalysisFlowInput): Promise<InvokeFlowResult>;
  invokeVerifyFlow(auth: AuthContext, input: VerifyFlowInput): Promise<InvokeFlowResult>;
  getIssue(tenantId: string, issueId: string): Promise<SubstrateIssue | null>;
  getFlowRunStatus(
    tenantId: string,
    runId: string,
  ): Promise<{ status: string; outputs?: Record<string, unknown> } | null>;
}

function flowNotFoundMeansSubstrate(error: unknown, flowName: string): never {
  const code = (error as { code?: string })?.code;
  if (code === 'FLOW_NOT_FOUND' || code === 'NO_LIVE_VERSION' || code === 'FLOW_VERSION_NOT_FOUND') {
    throw new SubstrateUnavailableError(
      `flow "${flowName}" is not published on this tenant — the APS exception pipeline has not landed yet`,
    );
  }
  throw error;
}

async function invokeFlow(
  auth: AuthContext,
  flowName: string,
  inputs: Record<string, unknown>,
): Promise<InvokeFlowResult> {
  try {
    const { run } = await createRun(auth, flowName, { inputs }, auth.clearance);
    return { runId: run._id, flowName: run.flowName, flowVersion: run.flowVersion };
  } catch (error) {
    return flowNotFoundMeansSubstrate(error, flowName);
  }
}

/**
 * Default client: flow invocation goes through the Flows platform and
 * issue reads go straight to the sibling's `aps_issues` store (both real
 * on main). Flow invocation still throws SubstrateUnavailableError until
 * the flows are PUBLISHED on the tenant (flows are tenant data — the
 * .json definitions ship in the repo, the live alias is per-tenant).
 */
const defaultClient: SubstrateClient = {
  invokeAnalysisFlow: (auth, input) =>
    invokeFlow(auth, SUBSTRATE_FLOW_NAMES.analysis, {
      exceptionReportDocumentId: input.exceptionReportDocumentId,
      issueId: input.issueId,
      site: input.site,
    }),
  invokeVerifyFlow: (auth, input) =>
    invokeFlow(auth, SUBSTRATE_FLOW_NAMES.verify, {
      issueId: input.issueId,
      newReportDocumentId: input.newReportDocumentId,
      site: input.site,
    }),
  getIssue: (tenantId, issueId) => siblingGetIssue(tenantId, issueId),
  getFlowRunStatus: async (tenantId, runId) => {
    const run = await getRun(tenantId, runId);
    if (!run) return null;
    return { status: run.status, outputs: (run as { outputs?: Record<string, unknown> }).outputs };
  },
};

let clientOverride: SubstrateClient | null = null;

/** Test-only seam: substitute the substrate client (mocked, labeled). */
export function overrideSubstrateClient(client: SubstrateClient | null): void {
  clientOverride = client;
}

/** The active substrate client (override in tests). */
export function getSubstrateClient(): SubstrateClient {
  return clientOverride ?? defaultClient;
}

/** Map a substrate failure to an HTTP error (honest, no pretending). */
export function substrateErrorToHttp(error: unknown): never {
  if (error instanceof SubstrateUnavailableError) {
    throw Errors.conflict('SUBSTRATE_UNAVAILABLE', error.message);
  }
  throw error;
}
