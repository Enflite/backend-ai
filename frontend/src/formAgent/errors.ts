/**
 * formAgent/errors.ts — map form-customizations API failures to the UI
 * states they deserve.
 *
 * Backend contract (backend/src/formAgent/routes.ts):
 *   - 403 FEATURE_DISABLED when FORM_CUSTOMIZATION_API_ENABLED=false
 *     -> the product is switched off server-side (DisabledState)
 *   - 403 FORBIDDEN when the caller lacks syteline:forms
 *     -> NotAuthorizedState
 *   - 400 VALIDATION_ERROR when the request payload is invalid
 *     -> inline field/message errors on the submission form
 */
import { ApiError } from "../api"

export type FormAgentProblem = "disabled" | "forbidden" | "validation" | "other"

export function classifyFormAgentError(err: unknown): FormAgentProblem {
  if (err instanceof ApiError) {
    if (err.code === "FEATURE_DISABLED") return "disabled"
    if (err.status === 403) return "forbidden"
    if (err.code === "VALIDATION_ERROR") return "validation"
  }
  return "other"
}

/** Human-readable text for an unexpected API failure. */
export function formAgentErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.message) return err.message
  if (err instanceof Error && err.message) return err.message
  return "Request failed"
}
