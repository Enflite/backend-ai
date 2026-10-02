/**
 * shell/TopBar.tsx — the single shared top bar for the app.
 *
 * AppShell renders the left nav rail; each routed view renders one TopBar
 * at the top of its content column instead of inventing its own header.
 * Views pass conversation- or page-level controls via the `left` / `right`
 * slots. Views must not render their own brand header — the shell nav
 * already carries the Enflite branding.
 */
import type { ReactNode } from 'react';

interface TopBarProps {
  /** Leading context: identity/status, page title, badges. */
  left?: ReactNode;
  /** Trailing controls: switchers, pickers, action buttons. */
  right?: ReactNode;
  /** Accessible label for the bar. */
  ariaLabel?: string;
}

export default function TopBar({ left, right, ariaLabel }: TopBarProps) {
  return (
    <header
      aria-label={ariaLabel}
      className="flex items-center justify-between px-4 py-2.5 flex-shrink-0 gap-3"
      style={{ borderBottom: '1px solid var(--border)', background: 'var(--background)' }}
    >
      <div className="flex items-center gap-3 min-w-0">{left}</div>
      <div className="flex items-center gap-3 flex-shrink-0">{right}</div>
    </header>
  );
}
