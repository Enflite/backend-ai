/**
 * routing — Phase 6 capability routing.
 *
 * The user talks to the assistant; the platform picks the model by task.
 * `classifyTask` (deterministic, rule-based, zero-latency) maps a turn to
 * a capability; `resolveChatModel` resolves the serving default for that
 * capability with a deterministic fallback chain.
 */
export { classifyTask, isTaskCapability, TASK_CAPABILITIES } from './classifier.js';
export type { TaskCapability, TaskClassification, TaskClassificationInput } from './classifier.js';
export { resolveChatModel } from './router.js';
export type { ChatModelRoute, ResolveChatModelInput } from './router.js';
