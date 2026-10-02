/**
 * views/AgentsView.tsx — the Agents product area: nested routes under /agents.
 *
 * Specialized AI agents that do operational work. The index is a directory
 * of the agent surfaces registered in the app — every entry is a live
 * destination with honest permission-gated status, never a placeholder.
 *
 * Agent teams: add entries to AGENT_SURFACES and sub-routes below as views
 * land (approvals, …). Surfaces whose views haven't landed yet are not listed.
 */
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { hasAnyPermission } from '../shell/AppShell';
import { Badge, Card, PageHeader } from '../components/ui/primitives';
import { NotAuthorizedState } from '../components/ui/ErrorState';
import TaskRedirect from '../tasks/TaskRedirect';
import WorkflowsView from '../agents/views/WorkflowsView';

export interface AgentSurface {
  id: string;
  label: string;
  description: string;
  to: string;
  /** Rendered (and linked) when the user holds any of these. */
  permissions?: string[];
}

export const AGENT_SURFACES: AgentSurface[] = [
  {
    id: 'syteline-task-agents',
    label: 'SyteLine Task Agents',
    description:
      'Give Enflite a task — it plans the SyteLine work, runs it as you, verifies each step, and pauses for your approval before any change. Full audit trail and screenshot evidence.',
    to: '/tasks',
    permissions: ['syteline:ui'],
  },
  {
    id: 'form-ai-agent',
    label: 'Form AI Agent',
    description:
      'Drafts SyteLine form customizations from your specs through a governed pipeline. Nothing merges without human review.',
    to: '/forms',
    permissions: ['syteline:forms'],
  },
  // New agent surfaces register here as their views land (e.g. APS Planning Agent).
];

/** Task workspaces drive SyteLine as the user — syteline:ui required. */
export function RequireTaskUi({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  if (!hasAnyPermission(user?.permissions ?? [], ['syteline:ui'])) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <NotAuthorizedState product="SyteLine task agents" />
        </div>
      </div>
    );
  }
  return <>{children}</>;
}

function AgentsDirectory() {
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <PageHeader
          title="Agents"
          description="Specialized AI agents that do operational work with your enterprise systems — not chatbots."
        />
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {AGENT_SURFACES.map((surface) => {
            const allowed = hasAnyPermission(permissions, surface.permissions);
            const required = (surface.permissions ?? []).join(' or ');
            const body = (
              <>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
                    {surface.label}
                  </h2>
                  {allowed ? (
                    <Badge tone="green">Available</Badge>
                  ) : (
                    <Badge tone="gray" title={`Requires ${required} permission`}>Locked</Badge>
                  )}
                </div>
                <p className="mt-1.5 text-sm leading-relaxed flex-1" style={{ color: 'var(--muted-foreground)' }}>
                  {surface.description}
                </p>
                <p className="mt-4 text-sm font-medium" style={{ color: allowed ? 'var(--accent)' : 'var(--muted-foreground)' }}>
                  {allowed ? 'Open →' : `Requires ${required} permission`}
                </p>
              </>
            );
            return (
              <Card key={surface.id} className="p-5">
                {allowed ? (
                  <Link to={surface.to} className="flex flex-col h-full" aria-label={`Open ${surface.label}`}>
                    {body}
                  </Link>
                ) : (
                  <div className="flex flex-col h-full" aria-label={`${surface.label} — locked`}>
                    {body}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export default function AgentsView() {
  return (
    <Routes>
      <Route index element={<AgentsDirectory />} />
      <Route
        path="tasks"
        element={
          <RequireTaskUi>
            <Navigate to="/tasks" replace />
          </RequireTaskUi>
        }
      />
      <Route
        path="tasks/new"
        element={
          <RequireTaskUi>
            <Navigate to="/tasks" replace />
          </RequireTaskUi>
        }
      />
      <Route
        path="tasks/:id"
        element={
          <RequireTaskUi>
            <TaskRedirect />
          </RequireTaskUi>
        }
      />
      <Route
        path="workflows"
        element={
          <RequireTaskUi>
            <WorkflowsView />
          </RequireTaskUi>
        }
      />
      <Route path="*" element={<Navigate to="/agents" replace />} />
      {/* Agent teams add sub-routes here as views land. */}
    </Routes>
  );
}
