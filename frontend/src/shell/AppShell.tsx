/**
 * shell/AppShell.tsx — application shell: the 68px icon rail, the routed
 * view outlet, and the global command palette.
 *
 * Information architecture: one global nav for the whole platform (the
 * IconRail). Views that need contextual navigation (e.g. Chat's
 * conversation list) render it as a *secondary panel inside the view* via
 * shell/ContextSidebar — visually subordinate to the rail (subtle
 * background, section label, no brand mark), so the app reads as one
 * product instead of competing sidebars.
 *
 * Nav items are permission-aware: every item always renders so users can
 * discover what exists. Items whose required permissions the signed-in
 * user lacks render disabled with a lock affordance and a tooltip naming
 * the missing permission (no requirement = everyone, always enabled).
 * Views themselves still handle 403/disabled states from the API — the nav
 * is a convenience, not a security boundary.
 *
 * AGENT EXTENSION SLOT: specialized AI agents register in navRegistry as
 * NavItems with `section: 'Agents'`. The section renders only when it has
 * items, so no dead UI ships before an agent lands. Example (APS Planning
 * Agent):
 *
 *   { to: '/aps', label: 'APS Planning Agent', section: 'Agents',
 *     permissions: ['aps:plan'], icon: 'spark' },
 *
 * The Agents directory entry (`/agents`, views/AgentsView.tsx) takes no
 * rail slot — the palette covers it — but stays discoverable as the index
 * of the agent surfaces. Agent teams own their views and sub-routes under
 * /agents/*; they plug into this shell and the shared design tokens.
 */
import { Outlet } from 'react-router-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import IconRail from './IconRail';
import { hasAnyPermission, type NavItem } from './navRegistry';
import CommandPalette from '../components/CommandPalette';
import NewTaskDialog, { type NewTaskDialogOptions } from '../components/NewTaskDialog';
import { NewTaskDialogContext } from './newTaskDialogContext';

/** Re-exported so existing importers (e.g. views/AgentsView) keep working. */
export { hasAnyPermission };
export type { NavItem };
/** Re-exported so entry points import the hook from the shell. */
export { useNewTaskDialog } from './newTaskDialogContext';

export default function AppShell() {
  const [paletteOpen, setPaletteOpen] = useState(false);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const [dialog, setDialog] = useState<(NewTaskDialogOptions & { open: boolean }) | null>(null);

  const openNewTask = useCallback((options?: NewTaskDialogOptions) => {
    setDialog({ ...(options ?? {}), open: true });
  }, []);

  const closeDialog = useCallback(() => setDialog(null), []);

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

  return (
    <NewTaskDialogContext.Provider value={{ openNewTask }}>
    <div className="app-shell-root flex h-screen overflow-hidden">
      <IconRail
        onOpenPalette={() => setPaletteOpen(true)}
        paletteTriggerRef={paletteTriggerRef}
      />
      <main className="flex-1 min-w-0 flex flex-col overflow-hidden">
        <Outlet />
      </main>
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        triggerRef={paletteTriggerRef}
      />
      <NewTaskDialog
        open={dialog?.open ?? false}
        onClose={closeDialog}
        linkedConversationId={dialog?.conversationId}
      />
    </div>
    </NewTaskDialogContext.Provider>
  );
}
