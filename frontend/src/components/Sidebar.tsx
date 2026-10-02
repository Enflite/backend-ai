/**
 * components/Sidebar.tsx — the Chat view's contextual conversation panel.
 *
 * This is deliberately NOT a second global nav: it renders inside the
 * shell/ContextSidebar (which owns the 272px shell, header/content/footer
 * slots, and the ≤720px slide-over), carries no brand mark (branding lives
 * in the IconRail), and is labeled "Conversations" so the hierarchy reads
 * as one product: global nav → Chat → conversations.
 *
 * Composed by views/ChatView.tsx:
 *   <ContextSidebar header={<ConversationSidebarHeader …/>}
 *                   collapsedContent={<ConversationSidebarCollapsed …/>}>
 *     <ConversationSidebarBody … />
 *   </ContextSidebar>
 *
 * Behavior is unchanged: select, search, new, delete (with confirm),
 * rename (inline), right-click context menu. Styling follows the Relay
 * reference's contextual look: section label, full-width new-chat button,
 * list rows with hover/selected states and an accent edge on the active
 * row (see the .ctx-* classes in index.css).
 */
import { useState } from 'react';
import type { Conversation } from '../types';
import { Icon } from './icons';
import { IconButton, SectionLabel } from './ui/primitives';

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

/** Panel header: section label + collapse toggle. */
export function ConversationSidebarHeader({ onToggle }: { onToggle: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <SectionLabel>Conversations</SectionLabel>
      <IconButton label="Collapse conversation panel" onClick={onToggle}>
        <Icon name="panel-left" size={16} />
      </IconButton>
    </div>
  );
}

/** Collapsed-strip content: expand + new conversation. */
export function ConversationSidebarCollapsed({ onNew, onToggle }: { onNew: () => void; onToggle: () => void }) {
  return (
    <>
      <IconButton label="Expand conversation panel" onClick={onToggle}>
        <Icon name="panel-right" size={16} />
      </IconButton>
      <IconButton label="New conversation" onClick={onNew}>
        <Icon name="plus" size={16} />
      </IconButton>
    </>
  );
}

interface ConversationSidebarBodyProps {
  conversations: Conversation[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, title: string) => void;
}

/** Panel content: new-chat button, search, and the grouped conversation list. */
export function ConversationSidebarBody({ conversations, activeId, onSelect, onNew, onDelete, onRename }: ConversationSidebarBodyProps) {
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

  return (
    <div onClick={() => contextMenu && closeContextMenu()}>
      {/* New conversation — the prominent Relay-style action button */}
      <button type="button" className="ctx-new" onClick={onNew}>
        <span className="ctx-new__icon" aria-hidden="true">
          <Icon name="plus" size={15} />
        </span>
        New conversation
      </button>

      {/* Search */}
      <div className="px-3 pb-2">
        <div className="flex items-center gap-2 px-2.5 py-1.5 rounded-md" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <span style={{ color: 'var(--muted-foreground)' }} aria-hidden="true"><Icon name="search" size={14} /></span>
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
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      </div>

      {/* Conversation list */}
      <div className="px-2 pb-2">
        {Object.entries(groups).map(([group, convs]) => {
          if (convs.length === 0) return null;
          return (
            <div key={group}>
              <p className="ctx-group-label">{group}</p>
              <div className="ctx-list">
                {convs.map((conv) => {
                  const selected = activeId === conv.id;
                  return (
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
                          aria-current={selected ? 'true' : undefined}
                          className={`ctx-row${selected ? ' ctx-row--selected' : ''}`}
                        >
                          <span className="ctx-row__title">{conv.title}</span>
                          <span className="ctx-row__meta">
                            {conv.model} · {timeAgo(conv.updatedAt)}
                          </span>
                          {selected && <span className="ctx-row__edge" aria-hidden="true" />}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {filtered.length === 0 && (
          <p className="text-xs text-center py-6" style={{ color: 'var(--muted-foreground)' }}>No conversations found</p>
        )}
      </div>

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
            <Icon name="edit" size={14} /> Rename
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
              <Icon name="trash" size={14} /> Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}
