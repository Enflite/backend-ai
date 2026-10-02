/**
 * shell/shell.test.ts — unit tests for the shell v2 navigation plumbing.
 *
 * Covers the pure helpers behind the icon rail: permission filtering,
 * rail membership, locked-item tooltips, and icon-name coverage against
 * the shared icon set. Component rendering is validated in CI by
 * typecheck + build; these tests pin the data contracts.
 */
import { describe, expect, it } from 'vitest';
import { ICON_NAMES } from '../components/icons';
import {
  hasAnyPermission,
  NAV_ITEMS,
  railNavItems,
  requiredPermissionLabel,
  type NavItem,
} from './navRegistry';

describe('hasAnyPermission', () => {
  it('allows everyone when no permissions are required', () => {
    expect(hasAnyPermission([], undefined)).toBe(true);
    expect(hasAnyPermission([], [])).toBe(true);
  });

  it('allows when the user holds any one of the required permissions', () => {
    expect(hasAnyPermission(['syteline:forms'], ['syteline:ui', 'syteline:forms'])).toBe(true);
  });

  it('denies when the user holds none of the required permissions', () => {
    expect(hasAnyPermission(['chat:read'], ['syteline:ui', 'syteline:forms'])).toBe(false);
    expect(hasAnyPermission([], ['syteline:ui'])).toBe(false);
  });
});

describe('railNavItems', () => {
  it('renders the Relay rail order: Home, Chat, Tasks, Board, Forms, SyteLine, Studio', () => {
    expect(railNavItems().map((item) => item.to)).toEqual([
      '/',
      '/chat',
      '/tasks',
      '/board',
      '/forms',
      '/syteline',
      '/studio',
    ]);
  });

  it('keeps the Agents directory out of the rail (palette covers it)', () => {
    const agents = NAV_ITEMS.find((item) => item.to === '/agents');
    expect(agents).toBeDefined();
    expect(agents?.hideFromRail).toBe(true);
    expect(railNavItems().every((item) => item.to !== '/agents')).toBe(true);
  });

  it('keeps the Agents directory discoverable in the registry for the palette', () => {
    const agents = NAV_ITEMS.find((item) => item.to === '/agents');
    expect(agents?.label).toBe('Agents');
    expect(agents?.permissions).toEqual(['syteline:ui', 'syteline:forms']);
  });

  it('permission-filters the rail exactly like the old nav did', () => {
    const visible = (permissions: string[]) =>
      railNavItems().filter((item) => hasAnyPermission(permissions, item.permissions));
    // Everyone sees Home + Chat. hasAnyPermission is any-of, so Board
    // (['syteline:ui', 'syteline:forms']) unlocks with either permission.
    expect(visible([]).map((item) => item.to)).toEqual(['/', '/chat']);
    expect(visible(['syteline:ui']).map((item) => item.to)).toEqual(['/', '/chat', '/tasks', '/board', '/syteline']);
    expect(visible(['syteline:forms']).map((item) => item.to)).toEqual(['/', '/chat', '/board', '/forms']);
    expect(visible(['syteline:ui', 'syteline:forms']).map((item) => item.to)).toEqual([
      '/',
      '/chat',
      '/tasks',
      '/board',
      '/forms',
      '/syteline',
    ]);
  });
});

describe('requiredPermissionLabel', () => {
  it('joins multiple permissions with "or"', () => {
    const item: NavItem = { to: '/board', label: 'Board', icon: 'layout', permissions: ['syteline:ui', 'syteline:forms'] };
    expect(requiredPermissionLabel(item)).toBe('syteline:ui or syteline:forms');
  });

  it('returns an empty string when nothing is required', () => {
    const item: NavItem = { to: '/', label: 'Home', icon: 'home' };
    expect(requiredPermissionLabel(item)).toBe('');
  });
});

describe('nav icons', () => {
  it('every registry destination names an icon from the shared set', () => {
    const names = new Set<string>(ICON_NAMES);
    for (const item of NAV_ITEMS) {
      expect(names.has(item.icon), `${item.to} references unknown icon "${item.icon}"`).toBe(true);
    }
  });

  it('rail destinations have distinct icons', () => {
    const icons = railNavItems().map((item) => item.icon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});
