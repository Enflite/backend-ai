/**
 * components/CommandPalette.tsx — global ⌘K command palette.
 *
 * Groups, in order: "Go to" (nav destinations + deep sub-destinations from
 * the shared nav registry), "Actions" (real commands), "Tasks" (recent
 * SyteLine agent tasks), "Conversations", "Forms" (form customizations).
 *
 * Data is lazy-loaded on first open (never on app mount) and cached for the
 * session. Every group loads independently: a failed group shows a retry,
 * never a raw error. Destinations and actions are permission-aware — a
 * locked destination is omitted, never shown as available.
 *
 * Keyboard: ↑/↓ (or Ctrl+N/P) navigate, Enter opens, Esc closes. The input
 * is focused on open and focus returns to the trigger on close.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { api } from '../api';
import { hasAnyPermission, NAV_ITEMS } from '../shell/navRegistry';
import { useNewTaskDialog } from '../shell/newTaskDialogContext';
import { Icon, type IconName } from './icons';
import { listFormCustomizations } from '../api/formAgent';
import { listSytelineTasks, toolClassificationFor } from '../agents/api';
import { useTheme } from '../hooks/useTheme';
import { Button, Kbd, SectionLabel, Skeleton } from './ui/primitives';
import { rankFuzzy } from './fuzzy';

/* ------------------------------------------------------------------ */
/* Item model                                                          */
/* ------------------------------------------------------------------ */

type GroupName = 'Go to' | 'Actions' | 'Tasks' | 'Conversations' | 'Forms';
const GROUP_ORDER: GroupName[] = ['Go to', 'Actions', 'Tasks', 'Conversations', 'Forms'];

/** Max results shown per group (the search corpus keeps more). */
const MAX_PER_GROUP = 8;

interface PaletteItem {
  key: string;
  group: GroupName;
  title: string;
  keywords: string;
  subtitle?: string;
  /** Nav-destination icon; falls back to the group glyph. */
  icon?: IconName;
  run: () => void;
}

interface SubDestination {
  to: string;
  label: string;
  keywords: string;
  icon: IconName;
  permissions?: string[];
}

/** Palette-only deep destinations (real routes, permission-gated). */
const SUB_DESTINATIONS: SubDestination[] = [
  { to: '/tasks', label: 'Agent tasks', keywords: 'agent tasks syteline workspace runs', icon: 'activity', permissions: ['syteline:ui'] },
  { to: '/agents/workflows', label: 'Workflows', keywords: 'workflows flows automation runs', icon: 'activity', permissions: ['syteline:ui'] },
  { to: '/board?today=1', label: 'Today board', keywords: 'today what did the ai complete completed', icon: 'layout', permissions: ['syteline:ui', 'syteline:forms'] },
  { to: '/forms/new', label: 'New form customization', keywords: 'new form customization create', icon: 'file', permissions: ['syteline:forms'] },
];

interface TaskLite {
  id: string;
  title: string;
  status: string;
  updatedAt: number;
}

interface ConversationLite {
  id: string;
  title: string;
  updatedAt: number;
}

interface FormLite {
  id: string;
  title: string;
  formName: string;
  status: string;
  updatedAt: number;
}

type DataGroup = 'tasks' | 'conversations' | 'forms';
type GroupStatus = 'idle' | 'loading' | 'ready' | 'error';

function timeAgo(timestamp: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function parseTimestamp(value: unknown, fallback: number): number {
  const time = typeof value === 'string' || typeof value === 'number' ? new Date(value).getTime() : NaN;
  return Number.isNaN(time) ? fallback : time;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

export default function CommandPalette({
  open,
  onClose,
  triggerRef,
}: {
  open: boolean;
  onClose: () => void;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { openNewTask } = useNewTaskDialog();
  const [, toggleTheme] = useTheme();
  const permissions = user?.permissions ?? [];

  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const [tasks, setTasks] = useState<TaskLite[]>([]);
  const [conversations, setConversations] = useState<ConversationLite[]>([]);
  const [forms, setForms] = useState<FormLite[]>([]);
  const [status, setStatus] = useState<Record<DataGroup, GroupStatus>>({
    tasks: 'idle',
    conversations: 'idle',
    forms: 'idle',
  });
  // Per-session cache: once a group loads (or is known-unneeded), it is
  // never fetched again until the page reloads.
  const fetchedRef = useRef<Record<DataGroup, boolean>>({ tasks: false, conversations: false, forms: false });

  const canSeeTasks = hasAnyPermission(permissions, ['syteline:ui']);
  const canSeeForms = hasAnyPermission(permissions, ['syteline:forms']);
  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  const loadGroup = useCallback(
    async (group: DataGroup) => {
      if (fetchedRef.current[group]) return;
      setStatus((current) => ({ ...current, [group]: 'loading' }));
      try {
        if (group === 'tasks') {
          const items = await listSytelineTasks(classification);
          setTasks(
            items
              .map((item) => ({
                id: item._id,
                title: item.title || 'Untitled task',
                status: item.status,
                updatedAt: parseTimestamp(item.updatedAt, Date.parse(item.createdAt)),
              }))
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 30),
          );
        } else if (group === 'conversations') {
          const body = await api.request<{ conversations: Array<Record<string, unknown>> }>('/conversations');
          setConversations(
            (body.conversations ?? [])
              .map((raw, index) => {
                const id = String(raw.id ?? `conversation-${index}`);
                const title = typeof raw.title === 'string' && raw.title.trim() ? raw.title : 'Untitled conversation';
                const updatedAt = parseTimestamp(raw.updated_at ?? raw.created_at, Date.now());
                return { id, title, updatedAt };
              })
              .sort((a, b) => b.updatedAt - a.updatedAt)
              .slice(0, 30),
          );
        } else {
          const items = await listFormCustomizations(undefined, 30);
          setForms(
            items
              .map((item) => ({
                id: item.id,
                title: item.title || item.formName || 'Untitled customization',
                formName: item.formName,
                status: item.status,
                updatedAt: parseTimestamp(item.updatedAt, Date.parse(item.createdAt)),
              }))
              .sort((a, b) => b.updatedAt - a.updatedAt),
          );
        }
        fetchedRef.current[group] = true;
        setStatus((current) => ({ ...current, [group]: 'ready' }));
      } catch {
        // Group-scoped failure: the group shows a retry, never a raw dump.
        fetchedRef.current[group] = false;
        setStatus((current) => ({ ...current, [group]: 'error' }));
      }
    },
    [classification],
  );

  // Focus the input on open.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActiveIndex(0);
    // Lazy-load on first open only — never on app mount.
    if (!fetchedRef.current.tasks && canSeeTasks) void loadGroup('tasks');
    if (!fetchedRef.current.conversations) void loadGroup('conversations');
    if (!fetchedRef.current.forms && canSeeForms) void loadGroup('forms');
    inputRef.current?.focus();
    // Permissions are intentionally read on each open: a permission change
    // mid-session (e.g. admin grant) refreshes what's shown next time.
  }, [open, canSeeTasks, canSeeForms, loadGroup]);

  /** Close and return focus to the shell trigger (spec'd behavior). */
  const handleClose = useCallback(() => {
    onClose();
    triggerRef.current?.focus();
  }, [onClose, triggerRef]);

  // Escape closes (AppShell owns the global Cmd/Ctrl+K toggle).
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        handleClose();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, handleClose]);

  // Lock background scroll while open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open ]);

  /* ---------------- item assembly ---------------- */

  const items = useMemo<PaletteItem[]>(() => {
    const list: PaletteItem[] = [];

    for (const nav of NAV_ITEMS) {
      if (!hasAnyPermission(permissions, nav.permissions)) continue;
      list.push({
        key: `goto:${nav.to}`,
        group: 'Go to',
        title: nav.label,
        keywords: `go to ${nav.label} ${nav.section ?? ''}`,
        subtitle: nav.section ? `Section · ${nav.section}` : 'Main navigation',
        icon: nav.icon,
        run: () => navigate(nav.to),
      });
    }
    for (const sub of SUB_DESTINATIONS) {
      if (!hasAnyPermission(permissions, sub.permissions)) continue;
      list.push({
        key: `goto:${sub.to}`,
        group: 'Go to',
        title: sub.label,
        keywords: sub.keywords,
        subtitle: 'Deep link',
        icon: sub.icon,
        run: () => navigate(sub.to),
      });
    }

    const actions: Array<{ label: string; keywords: string; permissions?: string[]; run: () => void }> = [
      {
        label: 'New agent task',
        keywords: 'new agent task create syteline form run',
        permissions: ['syteline:ui', 'syteline:forms'],
        run: () => openNewTask(),
      },
      {
        label: 'New chat',
        keywords: 'new chat conversation start',
        run: () => navigate('/chat'),
      },
      {
        label: 'Toggle theme',
        keywords: 'toggle theme dark light appearance mode',
        run: () => toggleTheme(),
      },
      {
        label: 'Go to board Today view',
        keywords: 'today board what did the ai complete',
        permissions: ['syteline:ui', 'syteline:forms'],
        run: () => navigate('/board?today=1'),
      },
    ];
    for (const action of actions) {
      if (!hasAnyPermission(permissions, action.permissions)) continue;
      list.push({
        key: `action:${action.label}`,
        group: 'Actions',
        title: action.label,
        keywords: action.keywords,
        subtitle: 'Action',
        run: action.run,
      });
    }

    for (const task of tasks) {
      list.push({
        key: `task:${task.id}`,
        group: 'Tasks',
        title: task.title,
        keywords: `${task.title} ${task.status}`,
        subtitle: `Task · ${task.status} · ${timeAgo(task.updatedAt)}`,
        run: () => navigate(`/tasks/${task.id}`),
      });
    }
    for (const conversation of conversations) {
      list.push({
        key: `conversation:${conversation.id}`,
        group: 'Conversations',
        title: conversation.title,
        keywords: conversation.title,
        subtitle: timeAgo(conversation.updatedAt),
        run: () => navigate(`/chat?conversation=${encodeURIComponent(conversation.id)}`),
      });
    }
    for (const form of forms) {
      list.push({
        key: `form:${form.id}`,
        group: 'Forms',
        title: form.title,
        keywords: `${form.title} ${form.formName} ${form.status}`,
        subtitle: `Form · ${form.status} · ${timeAgo(form.updatedAt)}`,
        run: () => navigate(`/forms/${form.id}`),
      });
    }
    return list;
  }, [permissions, navigate, toggleTheme, tasks, conversations, forms]);

  const grouped = useMemo(() => {
    return GROUP_ORDER.map((group) => {
      const groupItems = items.filter((item) => item.group === group);
      const ranked = rankFuzzy(query, groupItems, (item) => [item.title, item.keywords]).slice(0, MAX_PER_GROUP);
      return { group, items: ranked };
    }).filter(({ items: groupItems }) => groupItems.length > 0);
  }, [items, query]);

  const flat = useMemo(() => grouped.flatMap(({ items: groupItems }) => groupItems), [grouped]);
  const safeIndex = flat.length === 0 ? -1 : Math.min(activeIndex, flat.length - 1);
  const activeItem = safeIndex >= 0 ? flat[safeIndex] : null;

  const dataGroupOf: Record<GroupName, DataGroup | null> = {
    'Go to': null,
    Actions: null,
    Tasks: 'tasks',
    Conversations: 'conversations',
    Forms: 'forms',
  };
  const dataVisible: Record<DataGroup, boolean> = {
    tasks: canSeeTasks,
    conversations: true,
    forms: canSeeForms,
  };
  const groupLabel: Record<DataGroup, string> = { tasks: 'tasks', conversations: 'conversations', forms: 'forms' };

  function select(item: PaletteItem | null) {
    if (!item) return;
    item.run();
    handleClose();
  }

  function onInputKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    const ctrl = event.ctrlKey;
    const key = event.key;
    if (key === 'ArrowDown' || (ctrl && key.toLowerCase() === 'n')) {
      event.preventDefault();
      setActiveIndex((index) => (flat.length === 0 ? 0 : (index + 1) % flat.length));
    } else if (key === 'ArrowUp' || (ctrl && key.toLowerCase() === 'p')) {
      event.preventDefault();
      setActiveIndex((index) => (flat.length === 0 ? 0 : (index - 1 + flat.length) % flat.length));
    } else if (key === 'Enter') {
      event.preventDefault();
      select(activeItem);
    }
  }

  if (!open) return null;

  const loadingAny =
    (canSeeTasks && status.tasks === 'loading') ||
    status.conversations === 'loading' ||
    (canSeeForms && status.forms === 'loading');

  return (
    <div className="fixed inset-0 z-50" onClick={handleClose}>
      <div className="absolute inset-0" style={{ background: 'rgba(24,24,27,0.45)' }} aria-hidden="true" />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="absolute left-1/2 -translate-x-1/2 w-full animate-scale-in"
        style={{ top: '12vh', maxWidth: '36rem' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          className="rounded-xl overflow-hidden"
          style={{ background: 'var(--card)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-lg)' }}
        >
          <div className="flex items-center gap-3 px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
            <span aria-hidden="true" style={{ color: 'var(--muted-foreground)' }} className="inline-flex flex-shrink-0">
              <Icon name="search" size={16} />
            </span>
            <input
              ref={inputRef}
              role="combobox"
              aria-expanded="true"
              aria-controls="command-palette-list"
              aria-autocomplete="list"
              aria-activedescendant={activeItem ? `palette-option-${activeItem.key}` : undefined}
              aria-label="Search commands, destinations, and recent work"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActiveIndex(0);
              }}
              onKeyDown={onInputKeyDown}
              placeholder="Type a command or search…"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 bg-transparent outline-none text-sm"
              style={{ color: 'var(--foreground)' }}
            />
            <Kbd>esc</Kbd>
          </div>

          <div id="command-palette-list" role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto px-2 py-2">
            {grouped.map(({ group, items: groupItems }) => (
              <div key={group} className="pb-1">
                <div className="px-3 pt-2 pb-1">
                  <SectionLabel>{group}</SectionLabel>
                </div>
                {groupItems.map((item) => {
                  const flatIndex = flat.indexOf(item);
                  const isActive = flatIndex === safeIndex;
                  return (
                    <div
                      key={item.key}
                      id={`palette-option-${item.key}`}
                      role="option"
                      aria-selected={isActive}
                      onMouseEnter={() => setActiveIndex(flatIndex)}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => select(item)}
                      className="flex items-center gap-3 px-3 py-2 rounded-md cursor-pointer"
                      style={{ background: isActive ? 'var(--secondary)' : 'transparent' }}
                    >
                      <span aria-hidden="true" className="flex-shrink-0 inline-flex" style={{ color: 'var(--muted-foreground)' }}>
                        {item.icon ? <Icon name={item.icon} size={14} /> : <GroupIcon group={item.group} />}
                      </span>
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm truncate" style={{ color: 'var(--foreground)' }}>
                          {item.title}
                        </span>
                        {item.subtitle && (
                          <span className="block text-xs truncate" style={{ color: 'var(--muted-foreground)' }}>
                            {item.subtitle}
                          </span>
                        )}
                      </span>
                    </div>
                  );
                })}
              </div>
            ))}

            {(Object.keys(dataGroupOf) as GroupName[])
              .filter((group) => dataGroupOf[group] && dataVisible[dataGroupOf[group]!] && grouped.every((g) => g.group !== group))
              .map((group) => {
                const dataGroup = dataGroupOf[group]!;
                const groupStatus = status[dataGroup];
                if (groupStatus === 'loading') {
                  return (
                    <div key={group} className="pb-1">
                      <div className="px-3 pt-2 pb-1">
                        <SectionLabel>{group}</SectionLabel>
                      </div>
                      <div className="px-3 py-1 space-y-2" role="status" aria-label={`Loading ${groupLabel[dataGroup]}`}>
                        <Skeleton height="2.5rem" />
                        <Skeleton height="2.5rem" />
                        <Skeleton height="2.5rem" />
                      </div>
                    </div>
                  );
                }
                if (groupStatus === 'error') {
                  return (
                    <div key={group} className="pb-1">
                      <div className="px-3 pt-2 pb-1">
                        <SectionLabel>{group}</SectionLabel>
                      </div>
                      <div className="flex items-center justify-between gap-3 px-3 py-2">
                        <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                          Couldn't load {groupLabel[dataGroup]}.
                        </span>
                        <Button size="sm" variant="outline" onClick={() => void loadGroup(dataGroup)}>
                          Retry
                        </Button>
                      </div>
                    </div>
                  );
                }
                return null;
              })}

            {grouped.length === 0 && !loadingAny && (
              <p className="px-4 py-8 text-sm text-center" style={{ color: 'var(--muted-foreground)' }}>
                {query.trim() ? `No results for "${query.trim()}"` : 'Nothing here yet.'}
              </p>
            )}
          </div>

          <div
            className="flex items-center gap-4 px-4 py-2.5"
            style={{ borderTop: '1px solid var(--border)', color: 'var(--muted-foreground)' }}
          >
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> navigate
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Kbd>↵</Kbd> open
            </span>
            <span className="inline-flex items-center gap-1.5 text-xs">
              <Kbd>esc</Kbd> close
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function GroupIcon({ group }: { group: GroupName }) {
  const common = 'none';
  if (group === 'Go to') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill={common} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 8h9M8 4.5L11.5 8 8 11.5" />
      </svg>
    );
  }
  if (group === 'Actions') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill={common} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9 1.5L3.5 9H7l-1 5.5L11.5 7H8l1-5.5z" />
      </svg>
    );
  }
  if (group === 'Tasks') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill={common} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="4.5" width="10" height="7.5" rx="2.5" />
        <circle cx="6.4" cy="8.2" r="0.7" fill="currentColor" stroke="none" />
        <circle cx="9.6" cy="8.2" r="0.7" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (group === 'Conversations') {
    return (
      <svg width="14" height="14" viewBox="0 0 16 16" fill={common} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 3a1 1 0 011-1h10a1 1 0 011 1v7a1 1 0 01-1 1H6l-3 3v-3H3a1 1 0 01-1-1V3z" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={common} stroke="currentColor" strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 2h6l3 3v7a1 1 0 01-1 1H4a1 1 0 01-1-1V3a1 1 0 011-1z" />
      <path d="M10 2v3h3M6 8h4M6 11h4" />
    </svg>
  );
}
