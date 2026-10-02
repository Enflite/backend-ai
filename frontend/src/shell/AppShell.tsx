/**
 * shell/AppShell.tsx — application shell: global navigation rail, user
 * footer, and the routed view outlet.
 *
 * Information architecture: one global nav for the whole platform. Views
 * that need contextual navigation (e.g. Chat's conversation list) render
 * it as a *secondary panel inside the view* — visually subordinate to this
 * rail (subtle background, section label, no brand mark), so the app reads
 * as one product instead of competing sidebars.
 *
 * Nav items are permission-aware: every item always renders so users can
 * discover what exists. Items whose required permissions the signed-in user
 * lacks render disabled with a lock icon and a tooltip naming the missing
 * permission (no requirement = everyone, always enabled). Views themselves
 * still handle 403/disabled states from the API — the nav is a convenience,
 * not a security boundary.
 *
 * AGENT EXTENSION SLOT: specialized AI agents register here as NavItems with
 * `section: 'Agents'`. The section renders only when it has items, so no
 * dead UI ships before an agent lands. Example (APS Planning Agent):
 *
 *   { to: '/aps', label: 'APS Planning Agent', section: 'Agents',
 *     permissions: ['aps:plan'], icon: (a) => <IconAps active={a} /> },
 *
 * The top-level "Agents" entry above is the agents product area itself
 * (views/AgentsView.tsx) — a directory of the agent surfaces in the app.
 * Agent teams own their views and sub-routes under /agents/*; they plug
 * into this shell and the shared design tokens.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';
import { SectionLabel } from '../components/ui/primitives';

interface NavItem {
  to: string;
  label: string;
  /** Render when the user holds any of these (undefined = everyone). */
  permissions?: string[];
  /** Section grouping; items without one render above all sections. */
  section?: string;
  icon: (active: boolean) => React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Chat', icon: (a) => <IconChat active={a} /> },
  { to: '/agents', label: 'Agents', permissions: ['syteline:ui', 'syteline:forms'], icon: (a) => <IconAgents active={a} /> },
  { to: '/board', label: 'Board', permissions: ['syteline:ui', 'syteline:forms'], icon: (a) => <IconBoard active={a} /> },
  { to: '/forms', label: 'Form AI Agent', permissions: ['syteline:forms'], icon: (a) => <IconForm active={a} /> },
  { to: '/syteline', label: 'SyteLine', permissions: ['syteline:ui'], icon: (a) => <IconSyteLine active={a} /> },
  // 'Agents' section: specialized AI agents register here (see header comment).
];

export function hasAnyPermission(permissions: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((p) => permissions.includes(p));
}

function NavEntry({ item, permissions }: { item: NavItem; permissions: string[] }) {
  const allowed = hasAnyPermission(permissions, item.permissions);
  if (!allowed) {
    const required = (item.permissions ?? []).join(' or ');
    return (
      <div
        aria-disabled="true"
        title={`Requires ${required} permission`}
        className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium cursor-not-allowed select-none"
        style={{ color: 'var(--muted-foreground)', opacity: 0.55 }}
      >
        <span aria-hidden="true" className="flex-shrink-0">{item.icon(false)}</span>
        <span className="flex-1 truncate">{item.label}</span>
        <span aria-hidden="true" title={`Requires ${required} permission`} className="flex-shrink-0"><IconLock /></span>
      </div>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={item.label}
      className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium"
      style={({ isActive }) => ({
        background: isActive ? 'var(--secondary)' : 'transparent',
        color: isActive ? 'var(--foreground)' : 'var(--secondary-foreground)',
      })}
    >
      {({ isActive }) => (
        <>
          <span className="flex-shrink-0" style={{ color: isActive ? 'var(--accent)' : 'var(--muted-foreground)' }} aria-hidden="true">
            {item.icon(isActive)}
          </span>
          <span className="truncate">{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const permissions = user?.permissions ?? [];
  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  const topLevel = NAV_ITEMS.filter((item) => !item.section);
  const sections = [...new Set(NAV_ITEMS.map((item) => item.section).filter(Boolean))] as string[];

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--background)' }}>
      <nav
        aria-label="Primary"
        className="flex flex-col flex-shrink-0 py-4"
        style={{ width: 224, background: 'var(--card)', borderRight: '1px solid var(--border)' }}
      >
        <div className="px-4 pb-4 flex items-center gap-2.5 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <img src="/enflite-logo.png" alt="Enflite" className="h-6 w-auto" />
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>Enflite AI</span>
        </div>
        <div className="flex-1 px-2.5 py-3 space-y-0.5 overflow-y-auto">
          {topLevel.map((item) => (
            <NavEntry key={item.to} item={item} permissions={permissions} />
          ))}
          {sections.map((section) => {
            const items = NAV_ITEMS.filter((item) => item.section === section);
            if (items.length === 0) return null;
            return (
              <div key={section} className="pt-4">
                <div className="px-3 pb-1.5">
                  <SectionLabel>{section}</SectionLabel>
                </div>
                <div className="space-y-0.5">
                  {items.map((item) => (
                    <NavEntry key={item.to} item={item} permissions={permissions} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
        <div className="px-3 pt-3 flex-shrink-0" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2.5 px-1 py-1">
            <div
              className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
              style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--border)' }}
              aria-hidden="true"
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>{user?.displayName}</p>
              <p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>{user?.roleName}</p>
            </div>
            <button
              onClick={() => void logout()}
              className="text-xs px-2 py-1.5 rounded-md hover:bg-secondary font-medium"
              style={{ color: 'var(--muted-foreground)' }}
              title="Sign out"
            >
              Sign out
            </button>
          </div>
        </div>
      </nav>
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <Outlet />
      </main>
    </div>
  );
}

function IconChat({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3v-3H3a1 1 0 01-1-1V3z" /></svg>;
}
function IconAgents({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4.5" width="10" height="7.5" rx="2.5" /><path d="M8 4.5V2.5M6 12v2M10 12v2" /><circle cx="6.4" cy="8.2" r="0.7" fill="currentColor" stroke="none" /><circle cx="9.6" cy="8.2" r="0.7" fill="currentColor" stroke="none" /></svg>;
}
function IconBoard({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round"><rect x="2" y="2" width="3.5" height="12" rx="1" /><rect x="6.25" y="2" width="3.5" height="8" rx="1" /><rect x="10.5" y="2" width="3.5" height="10" rx="1" /></svg>;
}
function IconForm({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 2h6l3 3v7a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" /><path d="M10 2v3h3M6 8h4M6 11h4" /></svg>;
}
function IconSyteLine({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 6h12M6 6v8" /></svg>;
}

function IconLock() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></svg>;
}
