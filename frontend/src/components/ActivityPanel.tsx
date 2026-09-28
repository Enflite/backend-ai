import type { ActivityEntry, ActivityKind } from '../activity';
import { formatEntryTime } from '../activity';

interface ActivityPanelProps {
  open: boolean;
  onClose: () => void;
  /** Newest-first entries for the active conversation. */
  entries: ActivityEntry[];
  /** Jump to the message an entry belongs to. */
  onJump: (messageId: string) => void;
}

const KIND_ICON: Record<ActivityKind, React.ReactNode> = {
  tools: <IconWrench />,
  vision: <IconEye />,
  failover: <IconSwap />,
  sources: <IconBook />,
  attachment: <IconClip />,
  privacy: <IconShield />,
  web: <IconGlobe />,
};

const KIND_LABEL: Record<ActivityKind, string> = {
  tools: 'Tools',
  vision: 'Vision',
  failover: 'Model',
  sources: 'Sources',
  attachment: 'Attachment',
  privacy: 'Privacy',
  web: 'Web',
};

/**
 * Slide-over panel showing what the AI has done in this conversation —
 * tool calls, vision switches, sources used, attachments reviewed.
 * Entries are tappable: jumping scrolls to and highlights the message.
 */
export default function ActivityPanel({ open, onClose, entries, onJump }: ActivityPanelProps) {
  if (!open) return null;
  return (
    <>
      <div
        className="fixed inset-0 z-40"
        style={{ background: 'rgba(26,26,26,0.18)' }}
        onClick={onClose}
        aria-hidden="true"
      />
      <aside
        className="fixed top-0 right-0 bottom-0 z-50 w-80 max-w-[85vw] flex flex-col activity-panel-enter"
        style={{ background: 'var(--card)', borderLeft: '1px solid var(--border)' }}
        role="dialog"
        aria-label="AI activity"
      >
        <div className="flex items-center justify-between px-4 py-3 flex-shrink-0" style={{ borderBottom: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>Activity</h2>
          <button
            onClick={onClose}
            aria-label="Close activity panel"
            className="p-1.5 rounded-md"
            style={{ color: 'var(--muted-foreground)' }}
          >
            <IconClose />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-2">
          {entries.length === 0 ? (
            <p className="text-sm text-center py-10 px-4" style={{ color: 'var(--muted-foreground)' }}>
              Nothing here yet — ask the AI something and its work will show up here.
            </p>
          ) : (
            <ul className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {entries.map((entry) => (
                <li key={entry.id}>
                  <button
                    onClick={() => entry.messageId && onJump(entry.messageId)}
                    disabled={!entry.messageId}
                    className="w-full text-left flex items-start gap-3 px-2 py-3 rounded-lg enabled:hover:bg-secondary disabled:cursor-default"
                    title={entry.messageId ? 'Jump to message' : undefined}
                  >
                    <span
                      className="w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 mt-0.5"
                      style={{ background: 'var(--secondary)', color: 'var(--accent)' }}
                      aria-hidden="true"
                    >
                      {KIND_ICON[entry.kind]}
                    </span>
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>
                        {entry.title}
                      </span>
                      {entry.detail && (
                        <span className="block text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>
                          {entry.detail}
                        </span>
                      )}
                      <span className="block text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                        {KIND_LABEL[entry.kind]} · {formatEntryTime(entry.at)}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>
    </>
  );
}

function IconClose() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 3l10 10M13 3L3 13" /></svg>;
}
function IconWrench() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M10.5 2.5a3 3 0 00-4 4L2 11l3 3 4.5-4.5a3 3 0 004-4L11 8 8 5l2.5-2.5z" /></svg>;
}
function IconEye() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8z" /><circle cx="8" cy="8" r="2" /></svg>;
}
function IconSwap() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h8l-2-2M12 10H4l2 2" /></svg>;
}
function IconBook() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M3 2h8a2 2 0 012 2v10H5a2 2 0 01-2-2V2z" /><path d="M3 2v10a2 2 0 002 2h8" /></svg>;
}
function IconClip() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M11 7l-4.5 4.5a2.5 2.5 0 01-3.5-3.5L8.5 2.5a4 4 0 015.7 5.7L8 14.5" /></svg>;
}
function IconShield() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M8 1.5l5 2v4c0 3.5-2.5 6-5 7-2.5-1-5-3.5-5-7v-4l5-2z" /></svg>;
}
function IconGlobe() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6.5" /><path d="M1.5 8h13M8 1.5c-3.5 3.5-3.5 9.5 0 13 3.5-3.5 3.5-9.5 0-13z" /></svg>;
}
