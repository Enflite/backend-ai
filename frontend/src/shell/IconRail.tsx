/**
 * shell/IconRail.tsx — the 68px global icon rail.
 *
 * The single global nav for the whole platform: Enflite mark up top, one
 * icon button per rail destination, theme toggle + identity + sign out at
 * the bottom. Active destination gets the accent-tinted background and the
 * 2px accent edge; hover lifts 1px (160ms ease, Relay rhythm).
 *
 * Permission-aware: every destination always renders so users can discover
 * what exists. Items whose required permissions the user lacks render
 * dimmed with a lock affordance and a tooltip naming the missing
 * permission — `aria-disabled`, never a dead link, never hidden. The rail
 * is a convenience, not a security boundary: views still enforce access.
 */
import type { RefObject } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuth } from '../auth';
import { useTheme } from '../hooks/useTheme';
import { Icon } from '../components/icons';
import { IconButton } from '../components/ui/primitives';
import { hasAnyPermission, railNavItems, requiredPermissionLabel, type NavItem } from './navRegistry';

function RailEntry({ item, permissions }: { item: NavItem; permissions: string[] }) {
  const allowed = hasAnyPermission(permissions, item.permissions);
  if (!allowed) {
    const required = requiredPermissionLabel(item);
    return (
      <button
        type="button"
        aria-disabled="true"
        aria-label={`${item.label} — requires ${required} permission`}
        title={`Requires ${required} permission`}
        onClick={(event) => event.preventDefault()}
        className="rail-button rail-button--locked"
      >
        <Icon name={item.icon} size={20} />
        <span className="rail-lock" aria-hidden="true">
          <Icon name="lock" size={11} />
        </span>
      </button>
    );
  }
  return (
    <NavLink
      to={item.to}
      end={item.to === '/'}
      title={item.label}
      aria-label={item.label}
      className={({ isActive }) => `rail-button${isActive ? ' active' : ''}`}
    >
      <Icon name={item.icon} size={20} />
    </NavLink>
  );
}

function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  const platform = navigator.platform ?? '';
  const userAgentData = (navigator as { userAgentData?: { platform?: string } }).userAgentData;
  return /mac/i.test(userAgentData?.platform ?? platform);
}

export default function IconRail({
  onOpenPalette,
  paletteTriggerRef,
}: {
  /** Opens the global command palette (the rail owns the search trigger). */
  onOpenPalette: () => void;
  /** Ref for the palette to return focus to on close. */
  paletteTriggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const { user, logout } = useAuth();
  const [theme, toggleTheme] = useTheme();
  const permissions = user?.permissions ?? [];
  const initials = (user?.displayName ?? '?')
    .split(/\s+/)
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

  return (
    <nav aria-label="Primary" className="icon-rail">
      <NavLink to="/" end aria-label="Enflite AI home" className="rail-logo" title="Home">
        <img src="/enflite-logo.png" alt="" width={32} height={32} />
      </NavLink>

      <div className="rail-nav">
        <button
          ref={paletteTriggerRef}
          type="button"
          onClick={onOpenPalette}
          aria-keyshortcuts="meta+k control+k"
          aria-label={`Search (${isMacPlatform() ? '⌘K' : 'Ctrl+K'})`}
          title={`Search (${isMacPlatform() ? '⌘K' : 'Ctrl+K'})`}
          className="rail-button"
        >
          <Icon name="search" size={20} />
        </button>
        {railNavItems().map((item) => (
          <RailEntry key={item.to} item={item} permissions={permissions} />
        ))}
      </div>

      <div className="rail-bottom">
        <IconButton
          label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          onClick={toggleTheme}
        >
          <Icon name={theme === 'dark' ? 'sun' : 'moon'} size={16} />
        </IconButton>
        <div
          className="rail-avatar"
          title={user?.displayName ?? 'Signed in'}
          aria-label={user?.displayName ?? 'Signed in'}
        >
          {initials}
        </div>
        <button
          type="button"
          onClick={() => void logout()}
          className="rail-signout"
          title="Sign out"
        >
          Sign out
        </button>
      </div>
    </nav>
  );
}
