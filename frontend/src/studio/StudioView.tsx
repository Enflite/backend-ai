/**
 * studio/StudioView.tsx — Automation Studio section shell at /studio/*.
 *
 * Secondary nav lives inside the studio area (Automations, Runs, APIs,
 * Connections, IDOs, Logs, Settings) — subordinate to the global rail,
 * per the shell's secondary-nav convention. Every item is permission-aware:
 * the whole section requires studio:manage or studio:run (both auto-granted
 * under the current all-grant posture), and Logs/Settings additionally
 * require studio:manage.
 */
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useAuth } from '../auth';
import { hasAnyPermission } from '../shell/navRegistry';
import { NotAuthorizedState } from '../components/ui/ErrorState';
import { STUDIO_MANAGE_PERMISSIONS, STUDIO_VIEW_PERMISSIONS } from './types';
import './studio.css';
import AutomationsView from './views/AutomationsView';
import BuilderView from './views/BuilderView';
import NewAutomationView from './views/NewAutomationView';
import RunsView from './views/RunsView';
import RunDetailView from './views/RunDetailView';
import ApisView from './views/ApisView';
import ConnectionsView from './views/ConnectionsView';
import IdosView from './views/IdosView';
import LogsView from './views/LogsView';
import SettingsView from './views/SettingsView';

interface StudioNavItem {
  id: string;
  label: string;
  to: string;
  match: RegExp;
  /** Item renders when the user holds any of these. */
  permissions: string[];
}

const STUDIO_NAV: StudioNavItem[] = [
  { id: 'automations', label: 'Automations', to: 'automations', match: /^\/automations/, permissions: STUDIO_VIEW_PERMISSIONS },
  { id: 'runs', label: 'Runs', to: 'runs', match: /^\/runs/, permissions: STUDIO_VIEW_PERMISSIONS },
  { id: 'apis', label: 'APIs', to: 'apis', match: /^\/apis/, permissions: STUDIO_VIEW_PERMISSIONS },
  { id: 'connections', label: 'Connections', to: 'connections', match: /^\/connections/, permissions: STUDIO_VIEW_PERMISSIONS },
  { id: 'idos', label: 'IDOs', to: 'idos', match: /^\/idos/, permissions: STUDIO_VIEW_PERMISSIONS },
  { id: 'logs', label: 'Logs', to: 'logs', match: /^\/logs/, permissions: STUDIO_MANAGE_PERMISSIONS },
  { id: 'settings', label: 'Settings', to: 'settings', match: /^\/settings/, permissions: STUDIO_MANAGE_PERMISSIONS },
];

function StudioNav({ base, items }: { base: string; items: StudioNavItem[] }) {
  return (
    <nav aria-label="Studio sections" className="flex items-center gap-1 overflow-x-auto" style={{ borderBottom: '1px solid var(--border)' }}>
      {items.map((item) => (
        <NavLink
          key={item.id}
          to={`${base}${item.to}`}
          className="relative px-3 py-2.5 text-[13px] font-medium whitespace-nowrap"
          style={({ isActive }) => ({
            color: isActive ? 'var(--foreground)' : 'var(--muted-foreground)',
          })}
        >
          {({ isActive }) => (
            <>
              <span className="hover:text-[var(--foreground)]" style={{ transition: 'color 160ms ease' }}>
                {item.label}
              </span>
              {isActive && (
                <span
                  aria-hidden="true"
                  className="absolute inset-x-2 bottom-0"
                  style={{ height: '2px', background: 'var(--accent)' }}
                />
              )}
            </>
          )}
        </NavLink>
      ))}
    </nav>
  );
}

function breadcrumbFor(pathname: string): string {
  const relative = pathname.replace(/^\/studio\/?/, '');
  const first = relative.split('/')[0] || 'automations';
  const item = STUDIO_NAV.find((i) => i.id === first);
  const label = item ? item.label : 'Automations';
  return `/studio/${label.toLowerCase()}${relative.includes('/new') ? '/new' : ''}`;
}

export default function StudioView() {
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  const location = useLocation();

  if (!hasAnyPermission(permissions, STUDIO_VIEW_PERMISSIONS)) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <NotAuthorizedState product="Automation Studio" />
        </div>
      </div>
    );
  }

  const visibleNav = STUDIO_NAV.filter((item) => hasAnyPermission(permissions, item.permissions));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl" style={{ padding: 'clamp(20px, 3vw, 40px) clamp(20px, 4vw, 56px)' }}>
        {/* Breadcrumb area — machine-readable path in mono. */}
        <p className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }} aria-label="Breadcrumb">
          {breadcrumbFor(location.pathname)}
        </p>
        <p
          className="mt-2 text-[10px] font-bold uppercase"
          style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
        >
          Automation Studio
        </p>
        <h1
          className="mt-1 font-semibold"
          style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)', letterSpacing: '-0.02em' }}
        >
          SyteLine Automation
        </h1>
        <p className="mt-1" style={{ fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)' }}>
          Build, run, and audit governed automations against your SyteLine tenants.
        </p>

        <div className="mt-5">
          <StudioNav base="/studio/" items={visibleNav} />
        </div>

        <div className="pt-6">
          <Routes>
            <Route index element={<Navigate to="automations" replace />} />
            <Route path="automations" element={<AutomationsView />} />
            <Route path="automations/new" element={<NewAutomationView />} />
            <Route path="automations/:id" element={<BuilderView mode="edit" />} />
            <Route path="runs" element={<RunsView />} />
            <Route path="runs/:runId" element={<RunDetailView />} />
            <Route path="apis" element={<ApisView />} />
            <Route path="connections" element={<ConnectionsView />} />
            <Route path="idos" element={<IdosView />} />
            <Route path="logs" element={<LogsView />} />
            <Route path="settings" element={<SettingsView />} />
            <Route path="*" element={<Navigate to="automations" replace />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
