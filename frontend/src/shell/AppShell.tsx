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
import { useEffect, useRef, useState } from 'react';
import { useAuth } from '../auth';
import { IconButton, Kbd, SectionLabel } from '../components/ui/primitives';
import { useTheme } from '../hooks/useTheme';
import { hasAnyPermission, IconLock, IconMoon, IconSearch, IconSun, NAV_ITEMS, type NavItem } from './navRegistry';
import CommandPalette from '../components/CommandPalette';

/** Re-exported so existing importers (e.g. views/AgentsView) keep working. */
export { hasAnyPermission };
export type { NavItem };

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
  const [theme, toggleTheme] = useTheme();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const permissions = user?.permissions ?? [];
  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  // Global command palette toggle: Cmd/Ctrl+K. Registered on the shell so it
  // works from every view (the palette itself owns Escape-to-close).
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

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
          <button
            ref={paletteTriggerRef}
            type="button"
            onClick={() => setPaletteOpen(true)}
            aria-keyshortcuts="meta+k control+k"
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm mb-2"
            style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)', background: 'var(--secondary)' }}
          >
            <span aria-hidden="true" className="flex-shrink-0 inline-flex"><IconSearch /></span>
            <span className="flex-1 text-left">Search</span>
            <Kbd>{isMacPlatform() ? '⌘K' : 'Ctrl K'}</Kbd>
          </button>
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
            <IconButton
              label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
              onClick={toggleTheme}
              className="mr-0.5"
            >
              {theme === 'dark' ? <IconSun /> : <IconMoon />}
            </IconButton>
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
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        triggerRef={paletteTriggerRef}
      />
    </div>
  );
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const platform = navigator.platform ?? '';
  const userAgentData = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(userAgentData?.platform ?? platform);
}

/* Icons now live in ./navRegistry (shared with the command palette). */
