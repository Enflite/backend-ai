/**
 * shell/navRegistry.tsx — the single source of truth for global navigation.
 *
 * AppShell renders this list; the command palette reuses it for its
 * "Go to" group. Everything here is permission-aware: every destination
 * carries the permissions required to reach it, and consumers use
 * `hasAnyPermission` to decide what to show.
 *
 * Nav teams: destinations in this registry are real, live routes — never
 * placeholders.
 */
import type { ReactNode } from 'react';

export interface NavItem {
  to: string;
  label: string;
  /** Render when the user holds any of these (undefined = everyone). */
  permissions?: string[];
  /** Section grouping; items without one render above all sections. */
  section?: string;
  icon: (active: boolean) => ReactNode;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', icon: (a) => <IconHome active={a} /> },
  { to: '/chat', label: 'Chat', icon: (a) => <IconChat active={a} /> },
  { to: '/agents', label: 'Agents', permissions: ['syteline:ui', 'syteline:forms'], icon: (a) => <IconAgents active={a} /> },
  { to: '/board', label: 'Board', permissions: ['syteline:ui', 'syteline:forms'], icon: (a) => <IconBoard active={a} /> },
  { to: '/forms', label: 'Form AI Agent', permissions: ['syteline:forms'], icon: (a) => <IconForm active={a} /> },
  { to: '/syteline', label: 'SyteLine', permissions: ['syteline:ui'], icon: (a) => <IconSyteLine active={a} /> },
  { to: '/studio', label: 'Studio', permissions: ['studio:manage', 'studio:run'], icon: (a) => <IconStudio active={a} /> },
  // 'Agents' section: specialized AI agents register here (see AppShell header comment).
];

export function hasAnyPermission(permissions: string[], required?: string[]): boolean {
  if (!required || required.length === 0) return true;
  return required.some((p) => permissions.includes(p));
}

function IconHome({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M2.5 7.5L8 2.5l5.5 5V13a1 1 0 01-1 1h-3.5v-4h-2v4H3.5a1 1 0 01-1-1V7.5z" /></svg>;
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
function IconStudio({ active }: { active: boolean }) {
  return <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={active ? 1.8 : 1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M9 1.5L3.5 9H7l-1 5.5L11.5 7H8l1-5.5z" /></svg>;
}

export function IconLock() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><rect x="3.5" y="7" width="9" height="6.5" rx="1.5" /><path d="M5.5 7V5a2.5 2.5 0 015 0v2" /></svg>;
}

export function IconSearch() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>;
}

export function IconSun() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round"><circle cx="8" cy="8" r="3.25" /><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5L3.4 12.6" /></svg>;
}

export function IconMoon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"><path d="M13.2 10.2A5.6 5.6 0 015.8 2.8a5.6 5.6 0 107.4 7.4z" /></svg>;
}
