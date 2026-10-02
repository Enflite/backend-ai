/**
 * components/icons.tsx — the shared 24×24 stroke icon set.
 *
 * One `Icon({ name, size })` component for the whole frontend: the icon
 * rail, the contextual sidebars, and the command palette all render from
 * here, so an icon's look never drifts between surfaces. Paths follow the
 * Relay reference's stroke grammar (1.7px stroke, round caps/joins) —
 * rewritten here in our 24-grid so they stay crisp at 14–20px.
 *
 * Only add icons that are actually used somewhere.
 */
import type { ReactNode } from 'react';

export type IconName =
  | 'home'
  | 'chat'
  | 'activity'
  | 'layout'
  | 'file'
  | 'server'
  | 'lock'
  | 'search'
  | 'plus'
  | 'x'
  | 'menu'
  | 'sun'
  | 'moon'
  | 'edit'
  | 'trash'
  | 'panel-left'
  | 'panel-right'
  | 'spark'
  | 'terminal'
  | 'check'
  | 'bolt';

const ICON_PATHS: Record<IconName, ReactNode> = {
  home: (
    <>
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10.5V20h4.5v-5.5h3V20H18v-9.5" />
    </>
  ),
  chat: (
    <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H9l-5 4.5V6Z" />
  ),
  activity: (
    <path d="M4 12h3l2.1-6 3.8 12 2.2-6H20" />
  ),
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M9 9h12" />
    </>
  ),
  file: (
    <>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z" />
      <path d="M14 3v6h6" />
    </>
  ),
  server: (
    <>
      <rect x="3" y="4" width="18" height="7" rx="2" />
      <rect x="3" y="13" width="18" height="7" rx="2" />
      <path d="M7 7.5h.01M7 16.5h.01" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  x: <path d="m6 6 12 12M18 6 6 18" />,
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5 5l1.6 1.6M17.4 17.4 19 19M19 5l-1.6 1.6M6.6 17.4 5 19" />
    </>
  ),
  moon: <path d="M20 13.5A8 8 0 0 1 10.5 4 8 8 0 1 0 20 13.5Z" />,
  edit: (
    <>
      <path d="m14.5 4.5 5 5L8 21H3v-5L14.5 4.5Z" />
      <path d="m12.5 6.5 5 5" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M9.5 7V5h5v2" />
      <path d="M6.5 7l1 13h9l1-13" />
    </>
  ),
  'panel-left': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9.5 4v16" />
    </>
  ),
  'panel-right': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M14.5 4v16" />
    </>
  ),
  spark: (
    <path d="m12 3 1.25 4.1a5.2 5.2 0 0 0 3.55 3.55L21 12l-4.2 1.35a5.2 5.2 0 0 0-3.55 3.55L12 21l-1.25-4.1a5.2 5.2 0 0 0-3.55-3.55L3 12l4.2-1.35a5.2 5.2 0 0 0 3.55-3.55Z" />
  ),
  terminal: <path d="m5 7 4 5-4 5M12 17h7" />,
  check: <path d="m5 12 4 4L19 6" />,
  bolt: (
    <path d="M13.5 2.25 5.25 13.5h5.25L9 21.75l8.25-11.25H12l1.5-8.25Z" />
  ),
};

/** Every name this set can render — navRegistry tests assert its icons are all covered. */
export const ICON_NAMES = Object.keys(ICON_PATHS) as IconName[];

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name]}
    </svg>
  );
}
