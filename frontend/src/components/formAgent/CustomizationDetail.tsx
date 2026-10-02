/**
 * formAgent/CustomizationDetail.tsx — the detail view for one SyteLine Form
 * AI Agent customization request.
 *
 * Header (title, form name, status, timestamps), then for the result states
 * (awaiting_review / completed) a review hero: the result summary, the
 * approve-to-PR actions (Open review PR, View full diff on GitHub, Mark as
 * merged — the human merges the review PR on GitHub first; the agent never
 * merges), and commit metadata. A Changes section renders the file-by-file
 * change list from the validated plan (`plan`) — never fabricated — and a
 * Validation section tells the "what was checked" story from the verify
 * step, result summary, open items, and assumptions. The eight pipeline
 * steps render via mergeSteps(liveSteps), then the blocked section and the
 * actions (Cancel, Mark as merged).
 *
 * Polls the detail endpoint while the status is non-terminal. The API
 * behind FORM_CUSTOMIZATION_API_ENABLED=false (default off) maps to
 * DisabledState; missing syteline:forms maps to NotAuthorizedState.
 */
import { useCallback, useEffect, useState } from "react"
import { useParams } from "react-router-dom"
import {
  cancelFormCustomization,
  getFormCustomization,
  markFormCustomizationMerged,
} from "../../api/formAgent"
import { DisabledState, NotAuthorizedState } from "../ui/ErrorState"
import ErrorState from "../ui/ErrorState"
import Spinner from "../ui/Spinner"
import StatusBadge from "../ui/StatusBadge"
import { Badge, Button, Card, SectionLabel } from "../ui/primitives"
import { usePolling } from "../../hooks/usePolling"
import {
  blockedTitle,
  isTerminalStatus,
  mergeSteps,
  statusMeta,
  type CustomizationPlan,
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

/** External-link styled like a button (primitives' Button renders <button> only). */
function ExternalAction({
  href,
  variant,
  children,
}: {
  href: string
  variant: "primary" | "outline"
  children: React.ReactNode
}) {
  const primary = variant === "primary"
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="inline-flex items-center justify-center gap-1.5 font-medium rounded-md whitespace-nowrap text-sm px-3.5 py-2"
      style={
        primary
          ? { background: "var(--accent)", color: "var(--accent-foreground)" }
          : { background: "transparent", color: "var(--foreground)", border: "1px solid var(--border)" }
      }
    >
      {children}
    </a>
  )
}

function MetadataItem({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs" style={{ color: "var(--muted-foreground)" }}>
        {label}
      </dt>
      <dd className="text-sm mt-0.5 break-words" style={{ color: "var(--foreground)" }}>
        {children}
      </dd>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Review hero — the approve-to-PR surface for the result states       */
/* ------------------------------------------------------------------ */

function ReviewHero({
  detail,
  onMarkMerged,
  acting,
}: {
  detail: FormCustomizationDetail
  onMarkMerged: () => void
  acting: boolean
}) {
  const diffUrl = detail.prUrl ? `${detail.prUrl}/files` : null
  return (
    <Card className="mt-6 p-5 animate-fade-up">
      <section aria-labelledby="review-heading">
        <SectionLabel>Review</SectionLabel>
        <h2
          id="review-heading"
          className="text-base font-semibold mt-1"
          style={{ color: "var(--foreground)" }}
        >
          {detail.status === "completed" ? "Merged and completed" : "Ready for review"}
        </h2>
        {detail.resultSummary && (
          <p className="text-sm mt-2 break-words" style={{ color: "var(--foreground)" }}>
            {detail.resultSummary}
          </p>
        )}
        <div className="flex flex-wrap gap-2 mt-4">
          {detail.prUrl ? (
            <ExternalAction href={detail.prUrl} variant="primary">
              Open review PR
            </ExternalAction>
          ) : (
            // Honest pending state: the pipeline has not opened the PR yet.
            <Button
              variant="outline"
              disabled
              title="The pipeline is still running — the review PR will appear here."
            >
              Review PR pending
            </Button>
          )}
          {diffUrl ? (
            <ExternalAction href={diffUrl} variant="outline">
              View full diff on GitHub
            </ExternalAction>
          ) : (
            <Button
              variant="outline"
              disabled
              title="The pipeline is still running — the full diff will appear once the review PR is open."
            >
              Full diff not ready yet
            </Button>
          )}
          {detail.status === "awaiting_review" && (
            <Button variant="primary" onClick={onMarkMerged} disabled={acting}>
              {acting && <Spinner size={14} />}
              Mark as merged
            </Button>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 mt-4">
          <MetadataItem label="Repository">
            {detail.repoUrl ? (
              <a
                href={detail.repoUrl}
                target="_blank"
                rel="noreferrer"
                className="break-all"
                style={{ color: "var(--accent)" }}
              >
                {detail.repoUrl.replace(/^https:\/\/github\.com\//, "")}
              </a>
            ) : (
              "—"
            )}
          </MetadataItem>
          <MetadataItem label="Pull request">
            {detail.prUrl ? (
              <a
                href={detail.prUrl}
                target="_blank"
                rel="noreferrer"
                style={{ color: "var(--accent)" }}
              >
                Open on GitHub
              </a>
            ) : (
              "Pipeline still running"
            )}
          </MetadataItem>
          <MetadataItem label="Flow">
            {detail.flow.name} v{detail.flow.version}
          </MetadataItem>
          <MetadataItem label="Requested by">{detail.requestedBy ?? "—"}</MetadataItem>
        </dl>
      </section>
    </Card>
  )
}

/* ------------------------------------------------------------------ */
/* Changes — file-by-file, rendered only from the validated plan       */
/* ------------------------------------------------------------------ */

function ChangeCategory({
  title,
  count,
  children,
}: {
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <div className="mt-4">
      <div className="flex items-center gap-2 mb-1">
        <h4 className="text-xs font-semibold" style={{ color: "var(--foreground)" }}>
          {title}
        </h4>
        <Badge tone="blue">{count}</Badge>
      </div>
      {children}
    </div>
  )
}

function ChangesSection({ detail }: { detail: FormCustomizationDetail }) {
  const plan: CustomizationPlan | undefined = detail.plan
  return (
    <div className="mt-6">
      <SectionLabel>Changes</SectionLabel>
      {!plan ? (
        <Card className="mt-2 p-5">
          <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
            The change list appears once the agent&apos;s plan step has completed.
          </p>
        </Card>
      ) : (
        <div className="mt-2 space-y-4">
          {/* The rebuilt form XML — the artifact every plan produces. */}
          <Card className="p-5 animate-fade-up">
            <div className="flex items-center gap-2 flex-wrap">
              <h3
                className="text-sm font-semibold font-mono break-all"
                style={{ color: "var(--foreground)" }}
              >
                {detail.evidence?.formXml ?? `${detail.formName}.xml`}
              </h3>
              <Badge tone="neutral">form XML</Badge>
            </div>
            {plan.fields.length > 0 && (
              <ChangeCategory title="Fields added" count={plan.fields.length}>
                <ul className="space-y-1.5">
                  {plan.fields.map((f) => (
                    <li
                      key={f.field}
                      className="flex items-center gap-2 flex-wrap text-sm"
                      style={{ color: "var(--foreground)" }}
                    >
                      <code className="font-mono text-xs" style={{ color: "var(--accent)" }}>
                        {f.field}
                      </code>
                      <span>{f.caption}</span>
                      <Badge tone="gray">{f.kind}</Badge>
                      {f.userDefinedType && (
                        <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                          {f.userDefinedType}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </ChangeCategory>
            )}
            {plan.relabels.length > 0 && (
              <ChangeCategory title="Relabels" count={plan.relabels.length}>
                <ul className="space-y-1.5">
                  {plan.relabels.map((r) => (
                    <li
                      key={r.component}
                      className="flex items-center gap-2 flex-wrap text-sm"
                      style={{ color: "var(--foreground)" }}
                    >
                      <code className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {r.component}
                      </code>
                      <span aria-hidden="true" style={{ color: "var(--muted-foreground)" }}>
                        →
                      </span>
                      <span className="font-medium">“{r.newCaption}”</span>
                    </li>
                  ))}
                </ul>
              </ChangeCategory>
            )}
            {plan.resizes.length > 0 && (
              <ChangeCategory title="Resizes" count={plan.resizes.length}>
                <ul className="space-y-1.5">
                  {plan.resizes.map((r) => (
                    <li
                      key={r.component}
                      className="flex items-center gap-2 flex-wrap text-sm"
                      style={{ color: "var(--foreground)" }}
                    >
                      <code className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {r.component}
                      </code>
                      <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                        {Object.entries(r.changes)
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(", ")}
                      </span>
                    </li>
                  ))}
                </ul>
              </ChangeCategory>
            )}
            {plan.designNotes && (
              <p
                className="text-xs mt-4 break-words"
                style={{ color: "var(--muted-foreground)" }}
              >
                {plan.designNotes}
              </p>
            )}
          </Card>

          {/* The implementation-plan deck artifact, when the verify step built it. */}
          {detail.evidence?.deck && (
            <Card className="p-5 animate-fade-up">
              <div className="flex items-center gap-2 flex-wrap">
                <h3
                  className="text-sm font-semibold font-mono break-all"
                  style={{ color: "var(--foreground)" }}
                >
                  {detail.evidence.deck}
                </h3>
                <Badge tone="neutral">deck</Badge>
              </div>
              <p className="text-xs mt-2" style={{ color: "var(--muted-foreground)" }}>
                Implementation-plan deck — included as an artifact in the review PR.
              </p>
            </Card>
          )}
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Validation — the "what was checked" story                           */
/* ------------------------------------------------------------------ */

function ValidationSection({ detail }: { detail: FormCustomizationDetail }) {
  const verify = mergeSteps(detail.steps).find((s) => s.name === "verify")
  return (
    <div className="mt-6">
      <SectionLabel>Validation</SectionLabel>
      <Card className="mt-2 p-5">
        <section aria-labelledby="validation-heading">
          <h3
            id="validation-heading"
            className="text-sm font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            Verify step
          </h3>
          <div className="flex items-center gap-2 mt-2">
            <StepIcon status={verify?.live?.status} />
            <p className="text-sm" style={{ color: "var(--foreground)" }}>
              {verify?.live?.status === "done"
                ? "Passed — deterministic rebuild check, project docs, and deck."
                : verify?.live?.status === "failed"
                  ? "Failed — see the blocked reason above."
                  : "Not finished yet."}
            </p>
          </div>
          {verify?.live?.detail && (
            <p className="text-xs mt-1 font-mono" style={{ color: "var(--muted-foreground)" }}>
              {verify.live.detail}
            </p>
          )}
          {(verify?.live?.startedAt || verify?.live?.completedAt) && (
            <p className="text-xs mt-1" style={{ color: "var(--muted-foreground)" }}>
              {verify.live.startedAt && `Started ${formatTimestamp(verify.live.startedAt)}`}
              {verify.live.startedAt && verify.live.completedAt && " · "}
              {verify.live.completedAt && `Finished ${formatTimestamp(verify.live.completedAt)}`}
            </p>
          )}
          {detail.evidence?.openItems && detail.evidence.openItems.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold mb-1" style={{ color: "var(--muted-foreground)" }}>
                OPEN ITEMS
              </h4>
              <ul className="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--foreground)" }}>
                {detail.evidence.openItems.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {detail.evidence?.assumptions && detail.evidence.assumptions.length > 0 && (
            <div className="mt-4">
              <h4 className="text-xs font-semibold mb-1" style={{ color: "var(--muted-foreground)" }}>
                ASSUMPTIONS
              </h4>
              <ul className="text-sm space-y-1 list-disc pl-5" style={{ color: "var(--foreground)" }}>
                {detail.evidence.assumptions.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </Card>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* The view                                                            */
/* ------------------------------------------------------------------ */

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

  // Panel layout: the FormsView workspace provides the sidebar and the
  // scroll container; the detail constrains its own measure and keeps every
  // section (header, review hero, Changes, Validation, Pipeline, Blocked,
  // Actions).
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-6">
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

        {/* Approve-to-PR hero */}
        {showResult && (
          <ReviewHero
            detail={detail}
            onMarkMerged={() => void handleMarkMerged()}
            acting={acting === "merge"}
          />
        )}

        {/* File-by-file changes from the validated plan — whenever one exists. */}
        {(showResult || detail.plan) && <ChangesSection detail={detail} />}

        {/* What was checked */}
        {showResult && <ValidationSection detail={detail} />}

        {/* Pipeline steps */}
        <section className="mt-6" aria-labelledby="pipeline-heading">
          <h2
            id="pipeline-heading"
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
            style={{ background: "var(--danger-bg)", border: "1px solid #cf0c2c40" }}
          >
            <h2 className="text-sm font-semibold" style={{ color: "var(--danger)" }}>
              {blockedTitle(detail.blockedReason)}
            </h2>
            {detail.blockedDetail && (
              <p
                className="text-sm mt-1 break-words"
                style={{ color: "var(--danger)" }}
              >
                {detail.blockedDetail}
              </p>
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
                <Button
                  variant="primary"
                  onClick={() => void handleMarkMerged()}
                  disabled={acting !== null}
                >
                  {acting === "merge" && <Spinner size={14} />}
                  Mark as merged
                </Button>
              </div>
            )}
            {canCancel && (
              <Button
                variant="outline"
                onClick={() => void handleCancel()}
                disabled={acting !== null}
                style={{ color: "var(--danger)" }}
              >
                {acting === "cancel" && <Spinner size={14} />}
                Cancel customization
              </Button>
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
