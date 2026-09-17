import { useState } from 'react';
import type { Conversation } from '../types';

interface SidebarProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
  collapsed: boolean;
  onToggle: () => void;
}

function timeAgo(date: Date): string {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return `${days} days ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function groupConversations(convs: Conversation[]) {
  const groups: Record<string, Conversation[]> = { Today: [], Yesterday: [], Earlier: [] };
  convs.forEach((c) => {
    const label = timeAgo(c.updatedAt);
    if (label === 'Today') groups.Today.push(c);
    else if (label === 'Yesterday') groups.Yesterday.push(c);
    else groups.Earlier.push(c);
  });
  return groups;
}

export default function Sidebar({ conversations, activeId, onSelect, onNew, onDelete, onRename, collapsed, onToggle }: SidebarProps) {
  const [search, setSearch] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [contextMenu, setContextMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );
  const groups = groupConversations(filtered);

  function startRename(conv: Conversation) {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
    setContextMenu(null);
  }

  function commitRename(id: string) {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
  }

  function handleContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  }

  if (collapsed) {
    return (
      <aside className="flex flex-col items-center py-4 gap-3" style={{ width: 52, background: 'var(--card)', borderRight: '1px solid var(--border)' }}>
        <button onClick={onToggle} className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground" title="Expand sidebar">
          <IconPanelRight />
        </button>
        <button onClick={onNew} className="p-2 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground" title="New conversation">
          <IconPlus />
        </button>
      </aside>
    );
  }

  return (
    <>
      <aside
        className="flex flex-col h-full"
        style={{ width: 260, background: 'var(--card)', borderRight: '1px solid var(--border)', flexShrink: 0 }}
        onClick={() => contextMenu && setContextMenu(null)}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded flex items-center justify-center" style={{ background: 'var(--accent)' }}>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M7 1L9 5H13L10 8L11 13L7 10L3 13L4 8L1 5H5L7 1Z" fill="var(--accent-foreground)" />
              </svg>
            </div>
            <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>PrivateAI</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={onNew} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground" title="New conversation">
              <IconPlus />
            </button>
            <button onClick={onToggle} className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground" title="Collapse sidebar">
              <IconPanelLeft />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 py-2">
          <div className="flex items-center gap-2 px-2 py-1.5 rounded-md" style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}>
            <IconSearch />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              style={{ color: 'var(--foreground)' }}
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground">
                <IconX size={12} />
              </button>
            )}
          </div>
        </div>

        {/* Conversation list */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {Object.entries(groups).map(([group, convs]) => {
            if (convs.length === 0) return null;
            return (
              <div key={group}>
                <p className="px-2 py-1.5 text-xs font-medium uppercase tracking-widest" style={{ color: 'var(--muted-foreground)' }}>
                  {group}
                </p>
                {convs.map((conv) => (
                  <div key={conv.id} className="relative">
                    {renamingId === conv.id ? (
                      <input
                        autoFocus
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        onBlur={() => commitRename(conv.id)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitRename(conv.id);
                          if (e.key === 'Escape') setRenamingId(null);
                        }}
                        className="w-full px-2 py-1.5 text-sm rounded-md outline-none"
                        style={{ background: 'var(--secondary)', color: 'var(--foreground)', border: '1px solid var(--accent)' }}
                      />
                    ) : (
                      <button
                        onClick={() => onSelect(conv.id)}
                        onContextMenu={(e) => handleContextMenu(e, conv.id)}
                        className="w-full text-left px-2 py-2 rounded-md text-sm flex flex-col gap-0.5 group"
                        style={{
                          background: activeId === conv.id ? 'var(--secondary)' : 'transparent',
                          color: activeId === conv.id ? 'var(--foreground)' : 'var(--secondary-foreground)',
                        }}
                      >
                        <span className="truncate font-medium leading-snug">{conv.title}</span>
                        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                          {conv.model} · {timeAgo(conv.updatedAt)}
                        </span>
                      </button>
                    )}
                  </div>
                ))}
              </div>
            );
          })}

          {filtered.length === 0 && (
            <p className="text-xs text-center py-6" style={{ color: 'var(--muted-foreground)' }}>No conversations found</p>
          )}
        </div>

        {/* Footer */}
        <div style={{ borderTop: '1px solid var(--border)' }} className="p-3">
          <div className="flex items-center gap-2.5 px-2 py-1.5 rounded-md hover:bg-secondary cursor-pointer" style={{ color: 'var(--secondary-foreground)' }}>
            <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-semibold flex-shrink-0" style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}>
              JD
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>Jane Doe</p>
              <p className="text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>Power User · Acme Corp</p>
            </div>
            <IconChevronUp />
          </div>
        </div>
      </aside>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="fixed z-50 py-1 rounded-md shadow-xl text-sm"
          style={{
            left: contextMenu.x,
            top: contextMenu.y,
            background: 'var(--card)',
            border: '1px solid var(--border)',
            minWidth: 160,
          }}
        >
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2"
            style={{ color: 'var(--foreground)' }}
            onClick={() => {
              const conv = conversations.find((c) => c.id === contextMenu.id);
              if (conv) startRename(conv);
            }}
          >
            <IconEdit size={14} /> Rename
          </button>
          <button
            className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2"
            style={{ color: '#ef4444' }}
            onClick={() => { onDelete(contextMenu.id); setContextMenu(null); }}
          >
            <IconTrash size={14} /> Delete
          </button>
        </div>
      )}
    </>
  );
}

// Inline SVG icons
function IconPlus() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M8 3v10M3 8h10" /></svg>;
}
function IconSearch() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><circle cx="7" cy="7" r="4.5" /><path d="M10.5 10.5L14 14" /></svg>;
}
function IconX({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 4l8 8M12 4l-8 8" /></svg>;
}
function IconPanelLeft() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M6 2v12" /></svg>;
}
function IconPanelRight() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><rect x="2" y="2" width="12" height="12" rx="2" /><path d="M10 2v12" /></svg>;
}
function IconChevronUp() {
  return <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M4 10l4-4 4 4" /></svg>;
}
function IconEdit({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M11 2l3 3-9 9H2v-3L11 2z" /></svg>;
}
function IconTrash({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4h10M6 4V2h4v2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" /></svg>;
}
