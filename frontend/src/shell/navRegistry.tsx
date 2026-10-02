/**
 * shell/navRegistry.tsx — the single source of truth for global navigation.
 *
 * IconRail renders this list; the command palette reuses it for its
 * "Go to" group. Everything here is permission-aware: every destination
 * carries the permissions required to reach it, and consumers use
 * `hasAnyPermission` to decide what to show.
 *
 * Icons are IconName keys into components/icons.tsx — the rail and the
 * palette both render them through the shared Icon component.
 *
 * Nav teams: destinations in this registry are real, live routes — never
 * placeholders. A destination with `hideFromRail` stays discoverable via
 * the palette and direct links, but takes no slot on the 68px icon rail.
 */
import type { IconName } from '../components/icons';

export interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  /** Render when the user holds any of these (undefined = everyone). */
  permissions?: string[];
  /** Section grouping; items without one render above all sections. */
  section?: string;
  /** Palette/directory-only: never rendered on the icon rail. */
  hideFromRail?: boolean;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: 'home' },
  { to: '/chat', label: 'Chat', icon: 'chat' },
  { to: '/agents/tasks', label: 'Tasks', icon: 'activity', permissions: ['syteline:ui'] },
  { to: '/board', label: 'Board', icon: 'layout', permissions: ['syteline:ui', 'syteline:forms'] },
  { to: '/forms', label: 'Form AI Agent', icon: 'file', permissions: ['syteline:forms'] },
  { to: '/syteline', label: 'SyteLine', icon: 'server', permissions: ['syteline:ui'] },
  { to: '/studio', label: 'Studio', icon: 'bolt', permissions: ['studio:manage', 'studio:run'] },
  // Agents directory: no rail slot (the palette covers it), but it must stay
  // discoverable — it is the index of every agent surface under /agents/*.
  { to: '/agents', label: 'Agents', icon: 'spark', permissions: ['syteline:ui', 'syteline:forms'], hideFromRail: true },
  // 'Agents' section: specialized AI agents register here as NavItems.
];

export function hasAnyPermission(permissions: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((p) => permissions.includes(p));
}

/** The items that earn a slot on the icon rail (pure — unit-tested). */
export function railNavItems(): NavItem[] {
  return NAV_ITEMS.filter((item) => !item.hideFromRail);
}

/** Human-readable permission requirement, for locked-item tooltips. Pure — unit-tested. */
export function requiredPermissionLabel(item: NavItem): string {
  return (item.permissions ?? []).join(' or ');
}
