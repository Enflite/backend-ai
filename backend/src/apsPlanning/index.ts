/**
 * index.ts — the APS Planning Agent's narrow public interface.
 *
 * backend-ai is the platform; the APS Planning Agent is a product on it.
 * Everything outside this module interacts with the product ONLY through
 * this surface:
 *
 * - `apsPlanningRoutes` — Fastify route registration (`/api/v1/aps/*`)
 * - `apsJudge` / `overrideApsJudge` — the standalone/chat-context
 *   agent-judgment seam (explain/correlate/prioritize/recommend)
 * - `getSubstrateClient` / `overrideSubstrateClient` — the seam to the
 *   sibling-owned deterministic pipeline (flows invoked by name;
 *   aps_issues reads)
 * - `APS_PLANNING_VERSION` / `PRODUCT_NAME` / `SUBSTRATE_FLOW_NAMES` —
 *   independent versioning + the sibling flow names this module invokes
 * - domain types (zod) — `types.ts`
 *
 * The module's internals (store, prompts, procedures) are never imported
 * directly by the rest of the codebase, and the module itself depends
 * only on stable platform seams: auth, config, audit, the AI gateway,
 * the documents intake, and the Flows platform. No chat/conversation
 * internals. The sibling's pipeline (`backend/src/aps/`, the .flow.json
 * definitions) is consumed by contract through `substrate.ts` — never
 * rebuilt here.
 */

export { APS_PLANNING_VERSION, PRODUCT_NAME, SUBSTRATE_FLOW_NAMES } from './version.js';
export { apsPlanningRoutes } from './routes.js';
export { apsJudge, overrideApsJudge } from './agentJudgment.js';
export type {
  ApsJudgmentActor,
  ApsJudgmentFn,
  ApsJudgmentRequest,
  ApsJudgmentResult,
  IssueSummary,
} from './agentJudgment.js';
export { buildExplainRequest, buildPrioritizeRequest, buildRecommendRequest, buildSummariesFromSnapshot } from './agentJudgment.js';
export {
  getSubstrateClient,
  overrideSubstrateClient,
  substrateErrorToHttp,
  SubstrateUnavailableError,
} from './substrate.js';
export type {
  AnalysisFlowInput,
  InvokeFlowResult,
  SubstrateClient,
  SubstrateIssue,
  SubstrateIssueSnapshot,
  VerifyFlowInput,
} from './substrate.js';
export { getProcedureGuidance, allProcedureGuidance } from './procedures.js';
export { APS_PLANNING_KNOWLEDGE, APS_PLANNING_KNOWLEDGE_VERSION } from './knowledge.js';
export { compareSnapshots, issueIdentityKey, toPlanningRow } from './types.js';
export type {
  AnalysisStatus,
  ApsAnalysisDoc,
  ApsJudgmentInput,
  ColumnMap,
  ComparisonVerdict,
  Evidence,
  ExceptionType,
  ExportType,
  JudgmentKind,
  PlanningRow,
  Recommendation,
  RootCause,
  RowVerdict,
  Severity,
  Snapshot,
  SnapshotComparison,
  SyteLineProcedure,
} from './types.js';
