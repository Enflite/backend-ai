/**
 * router.ts — capability-aware model resolution for chat turns (Phase 6).
 *
 * The user never picks a model; they just talk to the assistant. When the
 * client does not name a model and the conversation has none pinned, the
 * router classifies the turn (see classifier.ts) and resolves the serving
 * default for that capability:
 *
 *   capability default → 'chat' default → first approved model
 *
 * Every step is a deterministic fallback: a capability default the caller
 * is not granted falls through to the next (it is a curation gap, not a
 * turn failure), and a missing default falls back to the legacy
 * first-approved behavior. The only hard failure is "no approved model at
 * all", which keeps the existing NO_APPROVED_MODEL error.
 *
 * What this does NOT do (ADR-004): the router makes no security decision.
 * Model approval, tenant grants, classification policy, and endpoint
 * allowlisting are re-verified downstream by getApprovedModelForUser on
 * every turn, exactly as before — classification only selects among models
 * the caller is already approved to use. An explicit client modelId is
 * honored untouched (API power users); a pinned conversation model keeps
 * the conversation's voice stable across turns.
 */
import { AppError, Errors } from '../../errors.js';
import { config } from '../../config.js';
import { getApprovedModelForUser, listApprovedModelsForUser } from '../gateway/modelRegistry.js';
import { resolveServingModel } from '../gateway/modelLifecycle.js';
import { classifyTask, type TaskCapability, type TaskClassificationInput } from './classifier.js';
export type { TaskCapability };

export interface ChatModelRoute {
  modelId: string;
  /**
   * Present only when the router classified the turn. Absent for explicit
   * client modelIds and pinned conversation models — there was no routing
   * decision to report.
   */
  routing?: { capability: TaskCapability; reasons: string[] };
}

export interface ResolveChatModelInput {
  tenantId: string;
  userId: string;
  roleId: string;
  /** Client-supplied modelId: honored as-is, never re-routed. */
  explicitModelId?: string;
  /** Model already pinned on the conversation, if any. */
  pinnedModelId?: string | null;
  content: string;
  documentIds?: string[];
  sytelineToolsOffered: boolean;
}

/**
 * Resolve the capability default, tolerating a default the caller is not
 * granted: getApprovedModelForUser throws MODEL_NOT_APPROVED for a default
 * that exists but isn't approved for this user/tenant, and the router
 * treats that as "no usable default for this capability" rather than
 * failing the turn. Any other error propagates.
 */
async function resolveDefault(
  tenantId: string,
  userId: string,
  roleId: string,
  capability: string
): Promise<string | undefined> {
  try {
    return (await resolveServingModel(tenantId, userId, roleId, capability))?.id;
  } catch (error) {
    if (error instanceof AppError && error.code === 'MODEL_NOT_APPROVED') return undefined;
    throw error;
  }
}

export async function resolveChatModel(input: ResolveChatModelInput): Promise<ChatModelRoute> {
  if (input.explicitModelId) {
    // Approval is re-verified by the caller via getApprovedModelForUser,
    // exactly as before routing existed.
    return { modelId: input.explicitModelId };
  }
  if (input.pinnedModelId) {
    return { modelId: input.pinnedModelId };
  }

  const classificationInput: TaskClassificationInput = {
    content: input.content,
    documentIds: input.documentIds,
    sytelineToolsOffered: input.sytelineToolsOffered,
  };
  const classification = config.ROUTING_ENABLED
    ? classifyTask(classificationInput)
    : { capability: 'chat' as TaskCapability, reasons: ['routing-disabled'] };

  // Deterministic fallback chain: the classified capability first, then the
  // general chat default, then the legacy first-approved model.
  const chain =
    classification.capability === 'chat' ? ['chat'] : [classification.capability, 'chat'];
  let modelId: string | undefined;
  for (const capability of chain) {
    modelId = await resolveDefault(input.tenantId, input.userId, input.roleId, capability);
    if (modelId) break;
  }
  modelId ??= (await listApprovedModelsForUser(input.tenantId, input.userId, input.roleId))[0]?.id;
  if (!modelId) throw Errors.forbidden('NO_APPROVED_MODEL', 'No approved model is available');

  // Routing metadata is emitted only when routing actually classified the
  // turn. When ROUTING_ENABLED=false the escape hatch is a true no-op: the
  // legacy chat default is served with no MODEL_ROUTED audit and no pinning.
  return {
    modelId,
    ...(config.ROUTING_ENABLED
      ? { routing: { capability: classification.capability, reasons: classification.reasons } }
      : {}),
  };
}
