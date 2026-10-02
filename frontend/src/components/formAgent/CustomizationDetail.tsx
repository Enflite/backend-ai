/**
 * formAgent/CustomizationDetail.tsx — the detail view for one SyteLine Form
 * AI Agent customization request.
 *
 * Header (title, form name, status, timestamps), the eight pipeline steps
 * rendered via mergeSteps(liveSteps) with per-step status icons, detail
 * text, and timestamps, a result section (summary, review-PR link, repo
 * link, open items, assumptions), a blocked section, and actions:
 *   - Cancel: non-terminal states only, explicit confirm.
 *   - Mark merged: awaiting_review only, explicit confirm — the human
 *     merges the review PR on GitHub first, then records it here. This is
 *     the agent's terminal state; the human's mark is what completes it.
 *
 * Polls the detail endpoint while the status is non-terminal. The API
 * behind FORM_CUSTOMIZATION_API_ENABLED=false (default off) maps to
 * DisabledState; missing syteline:forms maps to NotAuthorizedState.
 */
import { useCallback, useEffect, useState } from "react"
import { Link, useParams } from "react-router-dom"
import {
  cancelFormCustomization,
  getFormCustomization,
  markFormCustomizationMerged,
} from "../../api/formAgent"
import { DisabledState, NotAuthorizedState } from "../ui/ErrorState"
import ErrorState from "../ui/ErrorState"
import Spinner from "../ui/Spinner"
import StatusBadge from "../ui/StatusBadge"
import { usePolling } from "../../hooks/usePolling"
import {
  blockedTitle,
  isTerminalStatus,
  mergeSteps,
  statusMeta,
  type FormCustomizationDetail,
  type FlowStepStatus,
} from "../../formAgent/types"
import {
  classifyFormAgentError,
  formAgentErrorMessage,
} from "../../formAgent/errors"

function formatTimestamp(value?: string): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function StepIcon({ status }: { status: FlowStepStatus | undefined }) {
  if (status === "running") {
    return (
      <span style={{ color: "var(--accent)" }}>
        <Spinner size={16} />
      </span>
    )
  }
  if (status === "done") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="#15803d"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-label="Done"
      >
        <path d="M3 8.5l3.5 3.5L13 4.5" />
      </svg>
    )
  }
  if (status === "failed") {
    return (
      <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        strokeWidth="2"
        strokeLinecap="round"
        aria-label="Failed"
        style={{ stroke: 'var(--danger)' }}
      >
        <path d="M4 4l8 8M12 4l-8 8" />
      </svg>
    )
  }
  return (
    <span
      className="inline-block w-4 h-4 rounded-full"
      style={{ border: "2px solid var(--border)" }}
      aria-label="Pending"
    />
  )
}

export default function CustomizationDetail() {
  const { id } = useParams<{ id: string }>()
  const [detail, setDetail] = useState<FormCustomizationDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<"disabled" | "forbidden" | null>(null)
  const [acting, setActing] = useState<"cancel" | "merge" | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    if (!id) return
    try {
      const result = await getFormCustomization(id)
      setDetail(result)
      setError(null)
      setProblem(null)
    } catch (err) {
      const kind = classifyFormAgentError(err)
      if (kind === "disabled") setProblem("disabled")
      else if (kind === "forbidden") setProblem("forbidden")
      else setError(formAgentErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => {
    setLoading(true)
    setDetail(null)
    setError(null)
    setProblem(null)
    void load()
  }, [load])

  // Keep the view live while the agent is working; stop at the terminal
  // states (awaiting_review is terminal for the agent — the human acts next).
  const live = detail !== null && !isTerminalStatus(detail.status)
  usePolling(() => void load(), { intervalMs: 3000, active: live })

  const handleCancel = async () => {
    if (!id) return
    if (
      !window.confirm(
        "Cancel this customization? The agent will stop working on it.",
      )
    )
      return
    setActing("cancel")
    setActionError(null)
    try {
      await cancelFormCustomization(id)
      await load()
    } catch (err) {
      setActionError(formAgentErrorMessage(err))
    } finally {
      setActing(null)
    }
  }

  const handleMarkMerged = async () => {
    if (!id) return
    if (
      !window.confirm(
        "Record this customization as merged?\n\nOnly do this after you have merged the review PR on GitHub yourself.",
      )
    )
      return
    setActing("merge")
    setActionError(null)
    try {
      await markFormCustomizationMerged(id)
      await load()
    } catch (err) {
      setActionError(formAgentErrorMessage(err))
    } finally {
      setActing(null)
    }
  }

  if (problem === "disabled") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <DisabledState
          product="Form AI Agent"
          hint="The Form AI Agent is switched off on the backend (FORM_CUSTOMIZATION_API_ENABLED=false). An administrator needs to enable it before customizations can be tracked."
        />
      </div>
    )
  }
  if (problem === "forbidden") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NotAuthorizedState product="the SyteLine Form AI Agent" />
      </div>
    )
  }
  if (loading) {
    return (
      <div className="flex-1 grid place-items-center">
        <Spinner size={24} />
      </div>
    )
  }
  if (error || !detail) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <ErrorState
          message={error ?? "Customization not found"}
          onRetry={() => void load()}
        />
      </div>
    )
  }

  const meta = statusMeta(detail.status)
  const steps = mergeSteps(detail.steps)
  const canCancel = !isTerminalStatus(detail.status)
  const canMarkMerged = detail.status === "awaiting_review"
  const showResult =
    detail.status === "awaiting_review" || detail.status === "completed"

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        <Link
          to="/forms"
          className="text-sm"
          style={{ color: "var(--accent)" }}
        >
          ← All customizations
        </Link>

        {/* Header */}
        <div
          className="mt-3 rounded-lg p-5"
          style={{
            background: "var(--card)",
            border: "1px solid var(--border)",
          }}
        >
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1
                className="text-lg font-semibold break-words"
                style={{ color: "var(--foreground)" }}
              >
                {detail.title}
              </h1>
              <p
                className="text-sm mt-1 font-mono"
                style={{ color: "var(--muted-foreground)" }}
              >
                {detail.formName}
              </p>
            </div>
            <StatusBadge label={meta.label} color={meta.color} bg={meta.bg} />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 mt-4 text-sm">
            <div>
              <dt
                className="text-xs"
                style={{ color: "var(--muted-foreground)" }}
              >
                Requested
              </dt>
              <dd style={{ color: "var(--foreground)" }}>
                {formatTimestamp(detail.createdAt)}
              </dd>
            </div>
            <div>
              <dt
                className="text-xs"
                style={{ color: "var(--muted-foreground)" }}
              >
                Updated
              </dt>
              <dd style={{ color: "var(--foreground)" }}>
                {formatTimestamp(detail.updatedAt)}
              </dd>
            </div>
            {detail.requestedBy && (
              <div>
                <dt
                  className="text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  Requested by
                </dt>
                <dd style={{ color: "var(--foreground)" }}>
                  {detail.requestedBy}
                </dd>
              </div>
            )}
            {detail.completedAt && (
              <div>
                <dt
                  className="text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  Completed
                </dt>
                <dd style={{ color: "var(--foreground)" }}>
                  {formatTimestamp(detail.completedAt)}
                </dd>
              </div>
            )}
          </dl>
          <p
            className="text-xs mt-3"
            style={{ color: "var(--muted-foreground)" }}
          >
            Product {detail.product.name} {detail.product.version} · Flow{" "}
            {detail.flow.name} v{detail.flow.version}
          </p>
        </div>

        {/* Pipeline steps */}
        <section className="mt-6">
          <h2
            className="text-sm font-semibold mb-2"
            style={{ color: "var(--foreground)" }}
          >
            Pipeline
          </h2>
          <ol
            className="rounded-lg"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            {steps.map((step, i) => {
              const status = step.live?.status
              return (
                <li
                  key={step.name}
                  className="flex gap-3 px-4 py-3"
                  style={{
                    borderBottom:
                      i < steps.length - 1 ? "1px solid var(--border)" : "none",
                  }}
                  title={step.title}
                >
                  <div className="mt-0.5 flex-shrink-0">
                    <StepIcon status={status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p
                      className="text-sm font-medium"
                      style={{ color: "var(--foreground)" }}
                    >
                      {step.shortLabel}
                    </p>
                    {step.live?.detail && (
                      <p
                        className="text-xs mt-0.5 break-words"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {step.live.detail}
                      </p>
                    )}
                    {(step.live?.startedAt || step.live?.completedAt) && (
                      <p
                        className="text-xs mt-0.5"
                        style={{ color: "var(--muted-foreground)" }}
                      >
                        {step.live.startedAt &&
                          `Started ${formatTimestamp(step.live.startedAt)}`}
                        {step.live.startedAt && step.live.completedAt && " · "}
                        {step.live.completedAt &&
                          `Finished ${formatTimestamp(step.live.completedAt)}`}
                      </p>
                    )}
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        {/* Blocked */}
        {detail.status === "blocked" && (
          <section
            className="mt-6 rounded-lg p-5"
            style={{ background: "#fef2f2", border: "1px solid #fecaca" }}
          >
            <h2 className="text-sm font-semibold" style={{ color: "var(--danger)" }}>
              {blockedTitle(detail.blockedReason)}
            </h2>
            {detail.blockedDetail && (
              <p
                className="text-sm mt-1 break-words"
                style={{ color: "#7f1d1d" }}
              >
                {detail.blockedDetail}
              </p>
            )}
          </section>
        )}

        {/* Result */}
        {showResult && (
          <section
            className="mt-6 rounded-lg p-5"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            <h2
              className="text-sm font-semibold mb-2"
              style={{ color: "var(--foreground)" }}
            >
              Result
            </h2>
            {detail.resultSummary && (
              <p
                className="text-sm break-words"
                style={{ color: "var(--foreground)" }}
              >
                {detail.resultSummary}
              </p>
            )}
            <div className="flex flex-wrap gap-2 mt-3">
              {detail.prUrl && (
                <a
                  href={detail.prUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm font-medium px-4 py-2 rounded-md"
                  style={{
                    background: "var(--accent)",
                    color: "var(--accent-foreground)",
                  }}
                >
                  Open review PR
                </a>
              )}
              {detail.repoUrl && (
                <a
                  href={detail.repoUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm px-4 py-2 rounded-md"
                  style={{
                    border: "1px solid var(--border)",
                    color: "var(--foreground)",
                  }}
                >
                  Open repository
                </a>
              )}
            </div>
            {detail.evidence?.openItems &&
              detail.evidence.openItems.length > 0 && (
                <div className="mt-4">
                  <h3
                    className="text-xs font-semibold mb-1"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    OPEN ITEMS
                  </h3>
                  <ul
                    className="text-sm space-y-1 list-disc pl-5"
                    style={{ color: "var(--foreground)" }}
                  >
                    {detail.evidence.openItems.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
            {detail.evidence?.assumptions &&
              detail.evidence.assumptions.length > 0 && (
                <div className="mt-4">
                  <h3
                    className="text-xs font-semibold mb-1"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    ASSUMPTIONS
                  </h3>
                  <ul
                    className="text-sm space-y-1 list-disc pl-5"
                    style={{ color: "var(--foreground)" }}
                  >
                    {detail.evidence.assumptions.map((item, i) => (
                      <li key={i}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}
          </section>
        )}

        {/* Actions */}
        {(canCancel || canMarkMerged) && (
          <section
            className="mt-6 rounded-lg p-5"
            style={{
              background: "var(--card)",
              border: "1px solid var(--border)",
            }}
          >
            <h2
              className="text-sm font-semibold mb-2"
              style={{ color: "var(--foreground)" }}
            >
              Actions
            </h2>
            {canMarkMerged && (
              <div className="mb-4">
                <p
                  className="text-xs mb-2"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  The agent finished and opened the review PR — it never merges.
                  Merge the PR on GitHub yourself, then record it here to mark
                  this customization completed.
                </p>
                <button
                  onClick={() => void handleMarkMerged()}
                  disabled={acting !== null}
                  className="text-sm font-medium px-4 py-2 rounded-md disabled:opacity-60 inline-flex items-center gap-2"
                  style={{
                    background: "var(--accent)",
                    color: "var(--accent-foreground)",
                  }}
                >
                  {acting === "merge" && <Spinner size={14} />}
                  Mark as merged
                </button>
              </div>
            )}
            {canCancel && (
              <button
                onClick={() => void handleCancel()}
                disabled={acting !== null}
                className="text-sm px-4 py-2 rounded-md disabled:opacity-60 inline-flex items-center gap-2"
                style={{ border: "1px solid var(--border)", color: "var(--danger)" }}
              >
                {acting === "cancel" && <Spinner size={14} />}
                Cancel customization
              </button>
            )}
            {actionError && (
              <p className="text-sm mt-2" style={{ color: "var(--danger)" }}>
                {actionError}
              </p>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
