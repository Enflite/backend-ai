/**
 * shell/ContextSidebar.tsx — the 272px contextual sidebar shell.
 *
 * Views that need secondary, in-context navigation (Chat's conversation
 * list; R3/R5 add task/form/SyteLine panels) render it here — visually
 * subordinate to the icon rail: subtle `--secondary` background, slotted
 * header and footer, scrollable content, no brand mark, so the app reads
 * as one product instead of competing sidebars.
 *
 * Responsive (see index.css, next to the other shell styles):
 *   >1050px   272px sidebar, 68px rail
 *   ≤1050px   238px sidebar, 60px rail
 *   ≤720px    sidebar hidden → slide-over toggled by its own floating
 *             menu button (in normal flow, so it never overlaps view
 *             chrome); a backdrop click closes it. The owning view keeps
 *             the open state and typically closes the panel on select.
 *
 * Desktop collapse (`collapsed`) renders the slim icon strip; on mobile
 * an open panel always renders full-width regardless of `collapsed`.
 */
import type { ReactNode } from 'react';
import { Icon } from '../components/icons';

interface ContextSidebarProps {
  /** Accessible name for the panel. */
  label: string;
  /** Slotted header (section label + panel actions). */
  header?: ReactNode;
  /** Scrollable main content. */
  children: ReactNode;
  /** Slotted footer (usage, status, …). */
  footer?: ReactNode;
  /** Desktop: render the slim collapsed strip instead of the panel. */
  collapsed?: boolean;
  /** Content for the slim collapsed strip (icon buttons). */
  collapsedContent?: ReactNode;
  /** Mobile (≤720px) slide-over state — owned by the view. */
  mobileOpen: boolean;
  /** Toggles the mobile slide-over. */
  onMobileToggle: () => void;
}

export default function ContextSidebar({
  label,
  header,
  children,
  footer,
  collapsed = false,
  collapsedContent,
  mobileOpen,
  onMobileToggle,
}: ContextSidebarProps) {
  const showSlim = collapsed && !mobileOpen;
  return (
    <>
      <button
        type="button"
        className="context-sidebar__menu"
        aria-label={mobileOpen ? `Close ${label}` : `Open ${label}`}
        aria-expanded={mobileOpen}
        onClick={onMobileToggle}
      >
        <Icon name="menu" size={18} />
      </button>
      {mobileOpen && (
        <div
          className="context-sidebar__backdrop"
          onClick={onMobileToggle}
          aria-hidden="true"
        />
      )}
      <aside
        className="context-sidebar"
        aria-label={label}
        data-open={mobileOpen}
        data-collapsed={collapsed}
      >
        {showSlim ? (
          <div className="context-sidebar__collapsed">{collapsedContent}</div>
        ) : (
          <>
            {header && <div className="context-sidebar__header">{header}</div>}
            <div className="context-sidebar__content">{children}</div>
            {footer && <div className="context-sidebar__footer">{footer}</div>}
          </>
        )}
      </aside>
    </>
  );
}
