/**
 * FormsView — the Form AI Agent workspace: Relay-style 272px sidebar +
 * main execution panel. The view renders shell/ContextSidebar itself
 * (the chat pattern) — no App.tsx changes.
 *
 * Nested routes under /forms:
 *   /forms        sidebar list + "Select a customization to review it"
 *   /forms/new    the submission form (unchanged)
 *   /forms/:id    CustomizationDetail, constrained to the panel measure
 */
import { useState } from "react"
import { Route, Routes, useLocation, useNavigate } from "react-router-dom"
import ContextSidebar from "../shell/ContextSidebar"
import NewCustomizationForm from "../components/formAgent/NewCustomizationForm"
import CustomizationDetail from "../components/formAgent/CustomizationDetail"
import {
  FormsSidebarBody,
  FormsSidebarCollapsed,
  FormsSidebarHeader,
  useFormCustomizations,
} from "../components/formAgent/FormsSidebar"

/** /forms with nothing selected — the panel stays honest about it. */
function NoSelectionPanel({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-4 py-16 text-center animate-fade-up">
        <p
          className="text-sm font-medium"
          style={{ color: "var(--foreground)" }}
        >
          Select a customization to review it
        </p>
        <p
          className="text-sm mt-2"
          style={{ color: "var(--muted-foreground)" }}
        >
          The agent&apos;s pipeline steps, change list, validation, and review
          PR live here.
        </p>
        <button
          type="button"
          onClick={onNew}
          className="mt-4 text-sm font-medium px-4 py-2 rounded-md"
          style={{
            background: "var(--accent)",
            color: "var(--accent-foreground)",
          }}
        >
          New customization
        </button>
      </div>
    </div>
  )
}

export default function FormsView() {
  const navigate = useNavigate()
  const location = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  /** Mobile (≤720px) slide-over state — closed on select/new. */
  const [mobileOpen, setMobileOpen] = useState(false)

  // The sidebar list reloads immediately on every navigation (e.g. a new
  // submission landing on /forms/:id) and otherwise polls at 15s.
  const { items, loading, error, problem, retry } = useFormCustomizations(
    location.pathname,
  )

  // Selection comes from the nested route: /forms/:id (never "new").
  const selectionMatch = location.pathname.match(/^\/forms\/([^/]+)$/)
  let selectedId: string | null = null
  if (selectionMatch && selectionMatch[1] !== "new") {
    try {
      selectedId = decodeURIComponent(selectionMatch[1])
    } catch {
      selectedId = null
    }
  }

  function goNew() {
    navigate("/forms/new")
    setMobileOpen(false)
  }

  function select(id: string) {
    navigate(`/forms/${id}`)
    setMobileOpen(false)
  }

  return (
    <div
      className="flex flex-1 min-h-0 overflow-hidden"
      style={{ background: "var(--background)" }}
    >
      <ContextSidebar
        label="Form customizations"
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        onMobileToggle={() => setMobileOpen((value) => !value)}
        header={
          <FormsSidebarHeader
            count={problem ? null : items.length}
            loading={loading}
            onNew={goNew}
            onToggle={() => setCollapsed((value) => !value)}
          />
        }
        collapsedContent={
          <FormsSidebarCollapsed
            onNew={goNew}
            onToggle={() => setCollapsed((value) => !value)}
          />
        }
      >
        <FormsSidebarBody
          items={items}
          loading={loading}
          error={error}
          problem={problem}
          selectedId={selectedId}
          onSelect={select}
          onRetry={retry}
        />
      </ContextSidebar>
      <div className="flex flex-col flex-1 min-w-0 min-h-0">
        <Routes>
          <Route index element={<NoSelectionPanel onNew={goNew} />} />
          <Route path="new" element={<NewCustomizationForm />} />
          <Route path=":id" element={<CustomizationDetail />} />
        </Routes>
      </div>
    </div>
  )
}
