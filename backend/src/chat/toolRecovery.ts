/**
 * Agentic error recovery for the chat tool-calling loop.
 *
 * Charter `docs/assistant-quality.md` §2.5: a failed tool call is not a dead
 * end — retry once when the failure looks transient; otherwise the (already
 * sanitized) error is fed back to the model so it can explain what failed in
 * plain language and offer the next-best path.
 *
 * The retry lives here, in the chat loop — not in `runToolCall` — so the
 * direct `/tools/:name/execute` API stays single-attempt and deterministic.
 * Every attempt is still audited by `runToolCall` itself, so a retry is fully
 * traceable in `tool_executions` and the audit log.
 */
import type { runToolCall, ToolCallResult } from '../tools/gateway.js';

/** Injectable tool runner; defaults to the real one at the call site. */
export type ToolCallRunner = typeof runToolCall;
export type ToolCallRunnerOptions = Parameters<ToolCallRunner>[0];

export interface ToolRecoveryOutcome {
  /** The result to feed back to the model (first attempt or retry). */
  result: ToolCallResult;
  /** True when a second attempt was made. */
  retried: boolean;
}

/**
 * Error codes where a second attempt has a realistic chance of succeeding:
 * per-tool deadline fired, upstream 5xx/network blip, or an adapter-level
 * throw (usually transient infrastructure). Everything else is deterministic
 * and must NOT be retried blindly:
 * - INVALID_TOOL_ARGUMENTS / INVALID_TOOL_PARAMETERS: the model's fault —
 *   the error is fed back so the model can fix its arguments itself.
 * - TOOL_NOT_FOUND / TOOL_FORBIDDEN / TOOL_CLASSIFICATION_DENIED /
 *   CONFIRMATION_REQUIRED / SYTELINE_NOT_CONFIGURED: policy or
 *   configuration — retrying the identical call cannot succeed.
 */
const TRANSIENT_TOOL_ERROR_CODES: ReadonlySet<string> = new Set([
  'TOOL_TIMEOUT',
  'SYTELINE_UPSTREAM_ERROR',
  'TOOL_EXECUTION_FAILED',
]);

/** True when the failure looks transient and one retry is warranted. */
export function isTransientToolError(errorCode: string | undefined): boolean {
  return errorCode !== undefined && TRANSIENT_TOOL_ERROR_CODES.has(errorCode);
}

/**
 * Runs one tool call with bounded recovery: a single retry when the first
 * attempt fails with a transient-looking error code. Never retries
 * successes, never retries deterministic failures, and never retries after
 * the caller went away (an answer nobody will read must not burn another
 * tool slot).
 */
export async function runToolCallWithRecovery(
  runner: ToolCallRunner,
  options: ToolCallRunnerOptions,
): Promise<ToolRecoveryOutcome> {
  const first = await runner(options);
  if (first.ok || !isTransientToolError(first.errorCode)) {
    return { result: first, retried: false };
  }
  if (options.signal.aborted) {
    return { result: first, retried: false };
  }
  const second = await runner(options);
  return { result: second, retried: true };
}
