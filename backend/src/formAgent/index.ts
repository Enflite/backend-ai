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
 * - `FORM_CUSTOMIZATION_FLOW_NAME` — the platform flow executing the pipeline
 * - `FORM_AGENT_VERSION` — product versioning (the flow itself is
 *   versioned by the Flows platform from flows/syteline-form-customization.flow.json)
 *
 * The pipeline definition lives in flows/syteline-form-customization.flow.json
 * (repo root); the step implementations are the `formagent.*` platform
 * tools (flowTools.ts) wrapping the pure step functions (steps.ts).
 *
 * The module's internals (steps, store, prompts) are never imported
 * directly by the rest of the codebase, and the module itself depends
 * only on stable platform seams: auth, config, audit, the AI gateway,
 * the malware boundary, and the `syteline/forms` machinery's public
 * exports. No chat/conversation internals.
 */

export { FORM_AGENT_VERSION, PRODUCT_NAME } from './version.js';
export { formAgentRoutes } from './routes.js';
export {
  startFormAgentScheduler,
  stopFormAgentScheduler,
  kickFormAgentRunner,
} from './scheduler.js';
export { processRequestedCustomizations } from './runner.js';
export { FORM_CUSTOMIZATION_FLOW_NAME, ensureFlowLive, loadFormCustomizationFlowJson } from './flowEnsure.js';
export { formAiToolDefinitions } from './flowTools.js';
export { StepInputError } from './steps.js';
export type { FlowStepOutcome, FlowStepStatus } from './types.js';
