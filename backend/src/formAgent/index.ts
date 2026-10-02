/**
 * index.ts — the SyteLine Form AI Agent's narrow public interface.
 *
 * backend-ai is the platform; the Form AI Agent is a product on it.
 * Everything outside this module interacts with the product ONLY through
 * this surface:
 *
 * - `formAgentRoutes` — Fastify route registration (`/api/v1/form-customizations`)
 * - `startFormAgentScheduler` / `stopFormAgentScheduler` / `kickFormAgentRunner` — runner lifecycle
 * - `processRequestedCustomizations` — ops/test entry to the sweep
 * - `FORM_CUSTOMIZATION_FLOW` (+ types) — the declarative flow definition
 * - `AgentJudgmentFn` (+ types) — the agent-escalation seam
 * - `FORM_AGENT_VERSION` / `FORM_CUSTOMIZATION_FLOW_VERSION` — independent versioning
 *
 * The module's internals (steps, store, prompts) are never imported
 * directly by the rest of the codebase, and the module itself depends
 * only on stable platform seams: auth, config, audit, the AI gateway,
 * the malware boundary, and the `syteline/forms` machinery's public
 * exports. No chat/conversation internals.
 */

export { FORM_AGENT_VERSION, FORM_CUSTOMIZATION_FLOW_VERSION, PRODUCT_NAME } from './version.js';
export { formAgentRoutes } from './routes.js';
export {
  startFormAgentScheduler,
  stopFormAgentScheduler,
  kickFormAgentRunner,
} from './scheduler.js';
export { processRequestedCustomizations } from './runner.js';
export { FORM_CUSTOMIZATION_FLOW } from './flow.js';
export type { FlowDefinition, FlowStepDef, FlowStepKind, FlowPrecondition } from './flow.js';
export {
  runFlow,
  runFlowStep,
  StepInputError,
} from './flowRunner.js';
export type {
  FlowActor,
  FlowRunContext,
  FlowRunResult,
  FlowStepOutcome,
  FlowStepStatus,
  StepHandler,
  StepHandlerContext,
  StepResult,
  FlowRunnerDeps,
} from './flowRunner.js';
export { agentJudge, overrideAgentJudge } from './agentJudgment.js';
export type { AgentJudgmentFn, AgentJudgmentRequest, AgentJudgmentResult } from './agentJudgment.js';
