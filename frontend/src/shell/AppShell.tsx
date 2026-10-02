/**
 * shell/AppShell.tsx — application shell: left navigation rail, user footer,
 * and the routed view outlet.
 *
 * Nav items are permission-aware: an item renders only when the signed-in
 * user holds at least one of its required permissions (no requirement =
 * everyone). Views themselves still handle 403/disabled states from the
 * API — the nav is a convenience, not a security boundary.
 */
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth';

interface NavItem {
  to: string;
  label: string;
  /** Render when the user holds any of these (undefined = everyone). */
  permissions?: string[];
  icon: (active: boolean) => React.ReactNode;
}

const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Chat', icon: (a) => <IconChat active={a} /> },
  { to: '/board', label: 'Board', permissions: ['syteline:ui', 'syteline:forms'], icon: (a) => <IconBoard active={a} /> },
  { to: '/forms', label: 'Form AI Agent', permissions: ['syteline:forms'], icon: (a) => <IconForm active={a} /> },
  { to: '/syteline', label: 'SyteLine', permissions: ['syteline:ui'], icon: (a) => <IconSyteLine active={a} /> },
];

export function hasAnyPermission(permissions: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((p) => permissions.includes(p));
}

export default function AppShell() {
  const { user, logout } = useAuth();
  const permissions = user?.permissions ?? [];
  const visible = NAV_ITEMS.filter((item) => hasAnyPermission(permissions, item.permissions));
  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--background)' }}>
      <nav
        aria-label="Primary"
        className="flex flex-col flex-shrink-0 py-4"
        style={{ width: 216, background: 'var(--card)', borderRight: '1px solid var(--border)' }}
      >
        <div className="px-4 pb-4 flex items-center gap-2" style={{ borderBottom: '1px solid var(--border)' }}>
          <img src="/enflite-logo.png" alt="Enflite" className="h-6 w-auto" />
          <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Enflite AI</span>
        </div>
        <div className="flex-1 px-2 py-3 space-y-1 overflow-y-auto">
          {visible.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className="flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium"
              style={({ isActive }) => ({
                background: isActive ? 'var(--secondary)' : 'transparent',
                color: isActive ? 'var(--foreground)' : 'var(--secondary-foreground)',
              })}
            >
              {({ isActive }) => (
                <>
                  <span style={{ color: isActive ? 'var(--accent)' : 'var(--muted-foreground)' }}>{item.icon(isActive)}</span>
                  {item.label}
                </>
              )}
            </NavLink>
          ))}
        </div>
        <div className="px-3 pt-3" style={{ borderTop: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2.5 px-1 py-1">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0"
              style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
            >
              {initials}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>{user?.displayName}</p>
              <p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>{user?.roleName}</p>
            </div>
            <button
              onClick={() => void logout()}
              className="text-xs px-2 py-1 rounded-md hover:bg-secondary"
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
function IconBoard({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round"><rect x="2" y="2" width="3.5" height="12" rx="1" /><rect x="6.25" y="2" width="3.5" height="8" rx="1" /><rect x="10.5" y="2" width="3.5" height="10" rx="1" /></svg>;
}
function IconForm({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M4 2h6l3 3v7a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" /><path d="M10 2v3h3M6 8h4M6 11h4" /></svg>;
}
function IconSyteLine({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M2 6h12M6 6v8" /></svg>;
}
