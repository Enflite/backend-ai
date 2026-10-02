/**
 * formAgent/FormsHistory.tsx — the Form AI Agent index: a "New
 * customization" button plus the request history with a status filter.
 *
 * The API behind FORM_CUSTOMIZATION_API_ENABLED=false (default off) maps
 * to DisabledState; missing syteline:forms maps to NotAuthorizedState.
 */
import { useCallback, useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { listFormCustomizations } from "../../api/formAgent"
import { DisabledState, NotAuthorizedState } from "../ui/ErrorState"
import ErrorState from "../ui/ErrorState"
import Spinner from "../ui/Spinner"
import StatusBadge from "../ui/StatusBadge"
import {
  isTerminalStatus,
  statusMeta,
  type FormCustomizationListItem,
  type FormCustomizationStatus,
} from "../../formAgent/types"
import {
  classifyFormAgentError,
  formAgentErrorMessage,
} from "../../formAgent/errors"

const STATUS_OPTIONS: Array<{
  value: "" | FormCustomizationStatus
  label: string
}> = [
  { value: "", label: "All statuses" },
  { value: "requested", label: "Requested" },
  { value: "in_progress", label: "In progress" },
  { value: "awaiting_review", label: "Awaiting review" },
  { value: "completed", label: "Completed" },
  { value: "blocked", label: "Blocked" },
  { value: "cancelled", label: "Cancelled" },
]

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export default function FormsHistory() {
  const navigate = useNavigate()
  const [items, setItems] = useState<FormCustomizationListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [problem, setProblem] = useState<"disabled" | "forbidden" | null>(null)
  const [filter, setFilter] = useState<"" | FormCustomizationStatus>("")

  const load = useCallback(
    async (background = false) => {
      if (background) setRefreshing(true)
      else setLoading(true)
      try {
        const result = await listFormCustomizations(filter || undefined)
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
        setRefreshing(false)
      }
    },
    [filter],
  )

  useEffect(() => {
    void load()
  }, [load])

  if (problem === "disabled") {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <DisabledState
          product="Form AI Agent"
          hint="The Form AI Agent is switched off on the backend (FORM_CUSTOMIZATION_API_ENABLED=false). An administrator needs to enable it before customizations can be submitted."
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

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="max-w-3xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1
              className="text-lg font-semibold"
              style={{ color: "var(--foreground)" }}
            >
              Form AI Agent
            </h1>
            <p
              className="text-sm mt-1"
              style={{ color: "var(--muted-foreground)" }}
            >
              Request SyteLine form customizations and track the agent's
              pipeline.
            </p>
          </div>
          <button
            onClick={() => navigate("/forms/new")}
            className="text-sm font-medium px-4 py-2 rounded-md flex-shrink-0"
            style={{
              background: "var(--accent)",
              color: "var(--accent-foreground)",
            }}
          >
            New customization
          </button>
        </div>

        <div className="flex items-center gap-2 mt-5">
          <label
            htmlFor="status-filter"
            className="text-sm"
            style={{ color: "var(--muted-foreground)" }}
          >
            Status
          </label>
          <select
            id="status-filter"
            value={filter}
            onChange={(e) =>
              setFilter(e.target.value as "" | FormCustomizationStatus)
            }
            className="text-sm px-2 py-1.5 rounded-md"
            style={{
              background: "var(--background)",
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => void load(true)}
            disabled={loading || refreshing}
            className="text-sm px-3 py-1.5 rounded-md disabled:opacity-60 inline-flex items-center gap-2"
            style={{
              border: "1px solid var(--border)",
              color: "var(--foreground)",
            }}
          >
            {refreshing && <Spinner size={12} />}
            Refresh
          </button>
        </div>

        <div className="mt-4">
          {loading ? (
            <div className="grid place-items-center py-16">
              <Spinner size={24} />
            </div>
          ) : error ? (
            <ErrorState message={error} onRetry={() => void load()} />
          ) : items.length === 0 ? (
            <div
              className="rounded-lg p-8 text-center text-sm"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
                color: "var(--muted-foreground)",
              }}
            >
              No customizations yet. Submit the first one with the button above.
            </div>
          ) : (
            <ul
              className="rounded-lg"
              style={{
                background: "var(--card)",
                border: "1px solid var(--border)",
              }}
            >
              {items.map((item, i) => {
                const meta = statusMeta(item.status)
                return (
                  <li key={item.id}>
                    <button
                      onClick={() => navigate(`/forms/${item.id}`)}
                      className="w-full text-left px-4 py-3 hover:bg-[var(--secondary)]"
                      style={{
                        borderBottom:
                          i < items.length - 1
                            ? "1px solid var(--border)"
                            : "none",
                      }}
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <p
                            className="text-sm font-medium truncate"
                            style={{ color: "var(--foreground)" }}
                          >
                            {item.title}
                            {!isTerminalStatus(item.status) && (
                              <span
                                className="ml-2 inline-flex align-middle"
                                style={{ color: "var(--accent)" }}
                              >
                                <Spinner size={12} />
                              </span>
                            )}
                          </p>
                          <p
                            className="text-xs mt-0.5 font-mono truncate"
                            style={{ color: "var(--muted-foreground)" }}
                          >
                            {item.formName} · updated{" "}
                            {formatTimestamp(item.updatedAt)}
                          </p>
                        </div>
                        <StatusBadge
                          label={meta.label}
                          color={meta.color}
                          bg={meta.bg}
                        />
                      </div>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
