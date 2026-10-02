/**
 * components/Sidebar.tsx — the Chat view's contextual conversation panel.
 *
 * This is deliberately NOT a second global nav: it sits inside the Chat
 * view, carries no brand mark (branding lives in the AppShell rail), uses
 * the subtle surface background, and is labeled "Conversations" so the
 * hierarchy reads as one product: global nav → Chat → conversations.
 */
import { useState } from 'react';
import type { Conversation } from '../types';
import { IconButton, SectionLabel } from './ui/primitives';

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
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const filtered = conversations.filter((c) =>
    c.title.toLowerCase().includes(search.toLowerCase())
  );
  const groups = groupConversations(filtered);

  function startRename(conv: Conversation) {
    setRenamingId(conv.id);
    setRenameValue(conv.title);
    closeContextMenu();
  }

  function commitRename(id: string) {
    if (renameValue.trim()) onRename(id, renameValue.trim());
    setRenamingId(null);
  }

  function handleContextMenu(e: React.MouseEvent, id: string) {
    e.preventDefault();
    setConfirmDeleteId(null);
    setContextMenu({ id, x: e.clientX, y: e.clientY });
  }

  function closeContextMenu() {
    setContextMenu(null);
    setConfirmDeleteId(null);
  }

  if (collapsed) {
    return (
      <aside aria-label="Conversations" className="flex flex-col items-center py-4 gap-2" style={{ width: 52, background: 'var(--secondary)', borderRight: '1px solid var(--border)' }}>
        <IconButton label="Expand conversation panel" onClick={onToggle}>
          <IconPanelRight />
        </IconButton>
        <IconButton label="New conversation" onClick={onNew}>
          <IconPlus />
        </IconButton>
      </aside>
    );
  }

  return (
    <>
      <aside
        aria-label="Conversations"
        className="flex flex-col h-full"
        style={{ width: 264, background: 'var(--secondary)', borderRight: '1px solid var(--border)', flexShrink: 0 }}
        onClick={() => contextMenu && closeContextMenu()}
      >
        {/* Panel header — a section label, not a brand mark */}
        <div className="flex items-center justify-between pl-4 pr-2 py-3 flex-shrink-0">
          <SectionLabel>Conversations</SectionLabel>
          <div className="flex items-center gap-0.5">
            <IconButton label="New conversation" onClick={onNew}>
              <IconPlus />
            </IconButton>
            <IconButton label="Collapse conversation panel" onClick={onToggle}>
              <IconPanelLeft />
            </IconButton>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2 flex-shrink-0">
          <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <span style={{ color: 'var(--muted-foreground)' }} aria-hidden="true"><IconSearch /></span>
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              style={{ color: 'var(--foreground)' }}
            />
            {search && (
              <button onClick={() => setSearch('')} className="text-muted-foreground hover:text-foreground" aria-label="Clear search">
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
                <p className="px-2.5 py-1.5 text-[11px] font-semibold uppercase tracking-widest" style={{ color: 'var(--muted-foreground)' }}>
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
                        style={{ background: 'var(--card)', color: 'var(--foreground)', border: '1px solid var(--accent)' }}
                      />
                    ) : (
                      <button
                        onClick={() => onSelect(conv.id)}
                        onContextMenu={(e) => handleContextMenu(e, conv.id)}
                        className="w-full text-left px-2.5 py-2 rounded-md text-sm flex flex-col gap-0.5 group"
                        style={{
                          background: activeId === conv.id ? 'var(--card)' : 'transparent',
                          border: activeId === conv.id ? '1px solid var(--border)' : '1px solid transparent',
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
          {confirmDeleteId === contextMenu.id ? (
            <div className="px-3 py-1.5">
              <p className="text-xs mb-2" style={{ color: 'var(--muted-foreground)' }}>
                Delete this conversation? This cannot be undone.
              </p>
              <div className="flex gap-2">
                <button
                  className="flex-1 px-2 py-1 rounded text-xs font-medium"
                  style={{ background: '#cf0c2c', color: '#fff' }}
                  onClick={() => { onDelete(contextMenu.id); closeContextMenu(); }}
                >
                  Confirm
                </button>
                <button
                  className="flex-1 px-2 py-1 rounded text-xs"
                  style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                  onClick={() => setConfirmDeleteId(null)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <button
              className="w-full text-left px-3 py-1.5 hover:bg-secondary flex items-center gap-2"
              style={{ color: '#cf0c2c' }}
              onClick={() => setConfirmDeleteId(contextMenu.id)}
            >
              <IconTrash size={14} /> Delete
            </button>
          )}
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
function IconEdit({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M11 2l3 3-9 9H2v-3L11 2z" /></svg>;
}
function IconTrash({ size = 16 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"><path d="M3 4h10M6 4V2h4v2M5 4v9a1 1 0 001 1h4a1 1 0 001-1V4" /></svg>;
}
