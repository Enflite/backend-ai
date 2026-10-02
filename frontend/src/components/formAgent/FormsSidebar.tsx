/**
 * formAgent/FormsSidebar.tsx — the Form AI Agent workspace sidebar.
 *
 * Relay-style panel (rendered by FormsView inside shell/ContextSidebar):
 * a live list of form customizations with status dots, selected-row accent
 * edge, header ("Form customizations" + count + New), and the same honest
 * states the old history view had (DisabledState / NotAuthorizedState /
 * empty / error).
 *
 * Every row traces to real API data (api/formAgent listFormCustomizations).
 * The list polls every 15s (usePolling — paused while the tab is hidden,
 * backed off on failures) and refreshes immediately whenever the caller
 * bumps `refreshKey` (e.g. after submitting a new customization).
 */
import { useCallback, useEffect, useState } from "react"
import { listFormCustomizations } from "../../api/formAgent"
import { usePolling } from "../../hooks/usePolling"
import { relativeTime } from "../../board/types"
import { DisabledState, NotAuthorizedState } from "../ui/ErrorState"
import ErrorState from "../ui/ErrorState"
import Spinner from "../ui/Spinner"
import { IconButton, SectionLabel, Button } from "../ui/primitives"
import { Icon } from "../icons"
import {
  classifyFormAgentError,
  formAgentErrorMessage,
} from "../../formAgent/errors"
import {
  statusMeta,
  type FormCustomizationListItem,
  type FormCustomizationStatus,
} from "../../formAgent/types"

const STATUS_DOT_MODIFIERS: Record<FormCustomizationStatus, string> = {
  requested: "requested",
  in_progress: "in_progress",
  awaiting_review: "awaiting_review",
  completed: "completed",
  blocked: "blocked",
  cancelled: "cancelled",
}

/**
 * CSS class for a status dot — one modifier per real
 * FormCustomizationStatus (see index.css, next to the ctx-row rules).
 * in_progress gets the shared pulse animation (already
 * prefers-reduced-motion-safe). Unknown values fall back to the neutral
 * base dot rather than inventing a color.
 */
export function statusDotClass(status: FormCustomizationStatus): string {
  const modifier = STATUS_DOT_MODIFIERS[status] ?? "unknown"
  return `form-status-dot ${modifier}${status === "in_progress" ? " animate-pulse-dot" : ""}`
}

export function FormStatusDot({ status }: { status: FormCustomizationStatus }) {
  const meta = statusMeta(status)
  return (
    <span
      className={statusDotClass(status)}
      role="img"
      aria-label={meta.label}
      title={meta.label}
    />
  )
}

export interface FormCustomizationListState {
  items: FormCustomizationListItem[]
  loading: boolean
  error: string | null
  problem: "disabled" | "forbidden" | null
  retry: () => void
}

/**
 * The customization list + its polling lifecycle. Bump `refreshKey`
 * (typically the current pathname) to reload immediately; the 15s poll
 * keeps the list live otherwise.
 */
export function useFormCustomizations(refreshKey: string): FormCustomizationListState {
  const [items, setItems] = useState<FormCustomizationListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<"disabled" | "forbidden" | null>(null)

  const load = useCallback(async (background = false) => {
    if (!background) setLoading(true)
    try {
      const result = await listFormCustomizations()
      setItems(result)
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
  }, [])

  useEffect(() => {
    void load()
  }, [load, refreshKey])

  // 15s cadence; usePolling pauses while the tab is hidden and backs off
  // on consecutive failures.
  usePolling(() => load(true), { intervalMs: 15000 })

  return { items, loading, error, problem, retry: () => void load() }
}

/** Panel header: section label + count + New, and the collapse toggle. */
export function FormsSidebarHeader({
  count,
  loading,
  onNew,
  onToggle,
}: {
  /** null while the list can't be counted (disabled/forbidden). */
  count: number | null
  loading: boolean
  onNew: () => void
  onToggle: () => void
}) {
  return (
    <div>
      <div className="flex items-center justify-between gap-2">
        <SectionLabel>Form customizations</SectionLabel>
        <IconButton label="Collapse form panel" onClick={onToggle}>
          <Icon name="panel-left" size={16} />
        </IconButton>
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <p
          className="text-xs"
          style={{ color: "var(--muted-foreground)" }}
          aria-live="polite"
        >
          {loading
            ? "Loading…"
            : count === null
              ? "—"
              : `${count} ${count === 1 ? "customization" : "customizations"}`}
        </p>
        <Button variant="primary" size="sm" onClick={onNew}>
          <span aria-hidden="true">
            <Icon name="plus" size={13} />
          </span>
          New
        </Button>
      </div>
    </div>
  )
}

/** Collapsed-strip content: expand + new customization. */
export function FormsSidebarCollapsed({
  onNew,
  onToggle,
}: {
  onNew: () => void
  onToggle: () => void
}) {
  return (
    <>
      <IconButton label="Expand form panel" onClick={onToggle}>
        <Icon name="panel-right" size={16} />
      </IconButton>
      <IconButton label="New customization" onClick={onNew}>
        <Icon name="plus" size={16} />
      </IconButton>
    </>
  )
}

/** Panel content: the live customization list and the honest states. */
export function FormsSidebarBody({
  items,
  loading,
  error,
  problem,
  selectedId,
  onSelect,
  onRetry,
}: {
  items: FormCustomizationListItem[]
  loading: boolean
  error: string | null
  problem: "disabled" | "forbidden" | null
  selectedId: string | null
  onSelect: (id: string) => void
  onRetry: () => void
}) {
  if (problem === "disabled") {
    return (
      <div className="px-3 py-4">
        <DisabledState
          product="Form AI Agent"
          hint="The Form AI Agent is switched off on the backend (FORM_CUSTOMIZATION_API_ENABLED=false). An administrator needs to enable it before customizations can be submitted."
        />
      </div>
    )
  }
  if (problem === "forbidden") {
    return (
      <div className="px-3 py-4">
        <NotAuthorizedState product="the SyteLine Form AI Agent" />
      </div>
    )
  }
  if (loading) {
    return (
      <div className="grid place-items-center py-12" role="status" aria-label="Loading customizations">
        <Spinner size={20} />
      </div>
    )
  }
  if (error) {
    return (
      <div className="px-3 py-4">
        <ErrorState message={error} onRetry={onRetry} />
      </div>
    )
  }
  if (items.length === 0) {
    return (
      <div
        className="rounded-lg p-6 text-center mx-3"
        style={{
          background: "var(--card)",
          border: "1px solid var(--border)",
        }}
      >
        <p className="text-sm font-medium" style={{ color: "var(--foreground)" }}>
          No customizations yet
        </p>
        <p
          className="text-xs mt-1"
          style={{ color: "var(--muted-foreground)" }}
        >
          Submit the first one with the New button — the agent drafts the
          SyteLine form customization through a governed pipeline.
        </p>
      </div>
    )
  }
  return (
    <div className="px-2 pb-2">
      <div className="ctx-list" role="list" aria-label="Form customizations">
        {items.map((item) => {
          const selected = selectedId === item.id
          return (
            <div key={item.id} className="relative" role="listitem">
              <button
                type="button"
                onClick={() => onSelect(item.id)}
                aria-current={selected ? "true" : undefined}
                className={`ctx-row${selected ? " ctx-row--selected" : ""}`}
              >
                <span className="form-row__main">
                  <FormStatusDot status={item.status} />
                  <span className="ctx-row__title">{item.title}</span>
                </span>
                <span className="ctx-row__meta">
                  {item.formName} · {relativeTime(item.updatedAt) || "—"}
                </span>
                {selected && (
                  <span className="ctx-row__edge" aria-hidden="true" />
                )}
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
