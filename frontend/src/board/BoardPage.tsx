/**
 * board/BoardPage.tsx — the kanban board (the centerpiece view).
 *
 * Six columns (Assigned → Cancelled). Two data sources feed cards
 * independently — SyteLine task-agent runs and form customizations — each
 * with its own health (ok / disabled / forbidden / error) rendered as a
 * source-status panel instead of a raw error. New tasks open the global
 * new-task dialog (shell/AppShell) and land on their own detail page. The
 * Today view answers "what did the AI complete today" with a date picker, kind filter, and a chronological
 * per-kind list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { generateSytelineTasks, generationConfirmation, listSytelineTasks } from '../api/tasks';
import { defaultToolClassification } from '../api/tools';
import { listFormCustomizations } from '../api/formAgent';
import { usePolling } from '../hooks/usePolling';
import ErrorState, { DisabledState, NotAuthorizedState } from '../components/ui/ErrorState';
import { useNewTaskDialog } from '../shell/newTaskDialogContext';
import StatusBadge from '../components/ui/StatusBadge';
import Spinner from '../components/ui/Spinner';
import {
  BOARD_COLUMNS,
  COLUMN_META,
  KIND_META,
  classifySourceError,
  completedDay,
  formToCard,
  localDay,
  relativeTime,
  taskToCard,
  type BoardCard,
  type BoardCardKind,
  type BoardColumnId,
  type SourceHealth,
} from './types';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Request failed';
}

function useSource<T>(
  fetcher: () => Promise<T[]>,
): { items: T[]; health: SourceHealth; message: string; reload: () => void } {
  const [items, setItems] = useState<T[]>([]);
  const [health, setHealth] = useState<SourceHealth>('loading');
  const [message, setMessage] = useState('');
  const cancelledRef = useRef(false);
  // The callers pass inline arrow functions as `fetcher`, so its identity
  // changes every render. Hold it in a ref so `reload` below keeps a stable
  // identity and the mount effect below runs once — otherwise each render
  // produces a new `reload`, the effect refires, the fetch sets state, and the
  // board loops as fast as responses return.
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    cancelledRef.current = false;
    return () => { cancelledRef.current = true; };
  }, []);

  const reload = useCallback(() => {
    void (async () => {
      try {
        const next = await fetcherRef.current();
        if (cancelledRef.current) return;
        setItems(next);
        setHealth('ok');
        setMessage('');
      } catch (error) {
        if (cancelledRef.current) return;
        setHealth(classifySourceError(error));
        setMessage(errorMessage(error));
      }
    })();
  }, []);

  useEffect(() => { reload(); }, [reload]);
  // Keep polling healthy sources; a disabled/forbidden/errored source is
  // retried manually via its panel so we don't hammer a closed gate.
  usePolling(reload, { active: health === 'loading' || health === 'ok', intervalMs: 15000 });

  return { items, health, message, reload };
}

function cardLink(card: BoardCard): string {
  return card.kind === 'form' ? `/forms/${encodeURIComponent(card.id)}` : `/tasks/${encodeURIComponent(card.id)}`;
}

function CardView({ card }: { card: BoardCard }) {
  const meta = KIND_META[card.kind];
  return (
    <Link
      to={cardLink(card)}
      className="block rounded-lg p-3 hover:shadow-sm transition-shadow"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <StatusBadge label={meta.label} color={meta.color} bg={meta.bg} />
        {!meta.available && (
          <span className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>coming soon</span>
        )}
      </div>
      <p className="text-sm font-medium mt-1.5 leading-snug" style={{ color: 'var(--foreground)' }}>{card.title}</p>
      {card.subtitle && (
        <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>{card.subtitle}</p>
      )}
      <p className="text-xs mt-2" style={{ color: 'var(--muted-foreground)' }}>{relativeTime(card.updatedAt)}</p>
    </Link>
  );
}

function ColumnView({ column, cards }: { column: BoardColumnId; cards: BoardCard[] }) {
  return (
    <section aria-label={COLUMN_META[column].label} className="flex flex-col min-h-0 w-64 flex-shrink-0">
      <header className="flex items-center justify-between px-1 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
          {COLUMN_META[column].label}
        </h2>
        <span className="text-xs rounded-full px-2 py-0.5" style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}>
          {cards.length}
        </span>
      </header>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-2 rounded-lg p-1.5" style={{ background: 'var(--muted)' }}>
        {cards.map((card) => <CardView key={`${card.kind}:${card.id}`} card={card} />)}
        {cards.length === 0 && (
          <p className="text-xs text-center py-4" style={{ color: 'var(--muted-foreground)' }}>No cards</p>
        )}
      </div>
    </section>
  );
}

/**
 * "Tell the AI what to do" — natural-language goal in, board tasks out.
 * The server breaks the goal into tasks via the model and creates each
 * through the real task path; the board refreshes to show them. Same
 * primitives/styling as the rest of the board.
 */
function GenerateTasksBox({ onGenerated, disabled }: { onGenerated: () => void; disabled: boolean }) {
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!goal.trim() || busy) return;
    setBusy(true);
    setError('');
    setConfirmation('');
    try {
      const { tasks } = await generateSytelineTasks({ goal: goal.trim() });
      setConfirmation(generationConfirmation(tasks.length));
      setGoal('');
      onGenerated();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Could not generate tasks');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      onSubmit={submit}
      className="rounded-lg p-4 mb-4 flex-shrink-0"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <label className="block text-sm">
        <span className="font-medium" style={{ color: 'var(--foreground)' }}>Tell the AI what to do</span>
        <span className="block text-xs mt-0.5 mb-2" style={{ color: 'var(--muted-foreground)' }}>
          Describe the outcome in plain language — the AI breaks it into board tasks and starts on them.
        </span>
        <div className="flex gap-2">
          <input
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            disabled={busy || disabled}
            maxLength={2000}
            placeholder="e.g. Bring TRN purchase orders up to date and verify the vendor list"
            aria-label="Describe what you want the AI to do"
            className="flex-1 rounded-md px-3 py-2 bg-transparent text-sm disabled:opacity-50"
            style={{ border: '1px solid var(--border)' }}
          />
          <button
            type="submit"
            disabled={busy || disabled || !goal.trim()}
            className="text-sm font-medium px-4 py-2 rounded-md disabled:opacity-50 flex-shrink-0"
            style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
          >
            {busy ? 'Breaking this into tasks…' : 'Generate'}
          </button>
        </div>
      </label>
      {error && <p role="alert" className="text-sm mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}
      {confirmation && <p role="status" className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>{confirmation}</p>}
    </form>
  );
}

/** "What did the AI complete today" — flat chronological list per kind. */
function TodayView({ cards }: { cards: BoardCard[] }) {
  const [day, setDay] = useState(() => localDay(new Date()));
  const [kindFilter, setKindFilter] = useState<'all' | BoardCardKind>('all');

  const completed = cards
    .filter((card) => {
      if (completedDay(card) !== day) return false;
      return kindFilter === 'all' || card.kind === kindFilter;
    })
    .sort((a, b) => (b.completedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.updatedAt));

  const byKind = new Map<BoardCardKind, BoardCard[]>();
  for (const card of completed) {
    const group = byKind.get(card.kind) ?? [];
    group.push(card);
    byKind.set(card.kind, group);
  }

  const kinds: BoardCardKind[] = ['task', 'form', 'flow', 'schedule', 'batch'];
  const prettyDay = new Date(`${day}T12:00:00`).toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <input
          type="date"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className="text-sm rounded-md px-3 py-1.5 bg-transparent"
          style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
          aria-label="Pick a day"
        />
        <select
          value={kindFilter}
          onChange={(event) => setKindFilter(event.target.value as 'all' | BoardCardKind)}
          className="text-sm rounded-md px-3 py-1.5 bg-transparent"
          style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
          aria-label="Filter by kind"
        >
          <option value="all">All kinds</option>
          {kinds.filter((kind) => KIND_META[kind].available).map((kind) => (
            <option key={kind} value={kind}>{KIND_META[kind].label}s</option>
          ))}
        </select>
      </div>

      <p className="text-sm mb-4" style={{ color: 'var(--muted-foreground)' }}>
        {prettyDay} — <strong style={{ color: 'var(--foreground)' }}>{completed.length}</strong> completed
      </p>

      {completed.length === 0 ? (
        <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
          Nothing completed on this day.
        </p>
      ) : (
        <div className="space-y-5 max-w-3xl">
          {kinds.filter((kind) => byKind.has(kind)).map((kind) => {
            const group = byKind.get(kind)!;
            const meta = KIND_META[kind];
            return (
              <section key={kind} aria-label={`${meta.label} completions`}>
                <h3 className="flex items-center gap-2 text-sm font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
                  <StatusBadge label={meta.label} color={meta.color} bg={meta.bg} />
                  <span style={{ color: 'var(--muted-foreground)' }}>{group.length}</span>
                </h3>
                <ul className="space-y-2">
                  {group.map((card) => (
                    <li
                      key={`${card.kind}:${card.id}`}
                      className="rounded-lg px-3 py-2.5 flex items-baseline justify-between gap-3"
                      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
                    >
                      <Link
                        to={cardLink(card)}
                        className="text-sm font-medium hover:underline min-w-0"
                        style={{ color: 'var(--foreground)' }}
                      >
                        {card.title}
                        {card.subtitle && (
                          <span className="font-normal" style={{ color: 'var(--muted-foreground)' }}> — {card.subtitle}</span>
                        )}
                      </Link>
                      <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                        {relativeTime(card.completedAt ?? card.updatedAt)}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Source-status panel for an unhealthy source — never a raw error dump. */
function SourcePanel({ source, health, message, onRetry }: {
  source: 'tasks' | 'forms';
  health: SourceHealth;
  message: string;
  onRetry: () => void;
}) {
  if (health === 'ok' || health === 'loading') return null;
  const product = source === 'tasks' ? 'SyteLine task automation' : 'Form AI Agent';
  if (health === 'disabled') {
    return (
      <DisabledState
        product={product}
        hint={source === 'tasks'
          ? 'Task tracking needs the SyteLine UI automation enabled server-side (SYTELINE_UI_ENABLED). An administrator can switch it on.'
          : 'The Form AI Agent feature is switched off server-side. An administrator can enable it.'}
      />
    );
  }
  if (health === 'forbidden') return <NotAuthorizedState product={product} />;
  return <ErrorState message={message || 'Could not load this source.'} onRetry={onRetry} />;
}

export default function BoardPage() {
  const { user } = useAuth();
  const classification = defaultToolClassification(user?.clearance ?? 'PUBLIC');

  const tasksSource = useSource(() => listSytelineTasks(classification).then((items) => items.map(taskToCard)));
  const formsSource = useSource(() => listFormCustomizations().then((items) => items.map(formToCard)));

  const [searchParams] = useSearchParams();
  // Deep link: /board?today=1 (e.g. from the command palette) opens the
  // "what did the AI complete today" view directly.
  const [todayMode, setTodayMode] = useState(() => searchParams.get('today') === '1');
  const { openNewTask } = useNewTaskDialog();

  useEffect(() => {
    if (searchParams.get('today') === '1') setTodayMode(true);
  }, [searchParams]);

  const cards = [...tasksSource.items, ...formsSource.items];
  const loading = tasksSource.health === 'loading' || formsSource.health === 'loading';
  const byColumn = new Map<BoardColumnId, BoardCard[]>();
  for (const card of cards) {
    const group = byColumn.get(card.status) ?? [];
    group.push(card);
    byColumn.set(card.status, group);
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col p-6 overflow-hidden">
      <header className="flex items-center justify-between mb-4 flex-shrink-0">
        <h1 className="text-lg font-semibold" style={{ color: 'var(--foreground)' }}>Board</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setTodayMode((value) => !value)}
            aria-pressed={todayMode}
            className="text-sm px-3 py-1.5 rounded-md"
            style={{
              border: '1px solid var(--border)',
              background: todayMode ? 'var(--secondary)' : 'transparent',
              color: 'var(--foreground)',
            }}
          >
            {todayMode ? 'Show board' : 'Today'}
          </button>
          <button
            onClick={() => openNewTask()}
            disabled={tasksSource.health === 'disabled' || tasksSource.health === 'forbidden'}
            className="text-sm font-medium px-3 py-1.5 rounded-md disabled:opacity-50"
            style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
          >
            New task
          </button>
        </div>
      </header>

      {loading && cards.length === 0 ? (
        <div className="flex-1 grid place-items-center" style={{ color: 'var(--muted-foreground)' }}>
          <Spinner size={24} />
        </div>
      ) : (
        <>
          <GenerateTasksBox
            onGenerated={() => tasksSource.reload()}
            disabled={tasksSource.health === 'disabled' || tasksSource.health === 'forbidden'}
          />
          <div className="space-y-4 mb-4 flex-shrink-0">
            <SourcePanel
              source="tasks"
              health={tasksSource.health}
              message={tasksSource.message}
              onRetry={() => tasksSource.reload()}
            />
            <SourcePanel
              source="forms"
              health={formsSource.health}
              message={formsSource.message}
              onRetry={() => formsSource.reload()}
            />
          </div>

          {todayMode ? (
            <TodayView cards={cards} />
          ) : (
            <div className="flex-1 min-h-0 flex gap-3 overflow-x-auto pb-2 animate-fade-up">
              {BOARD_COLUMNS.map((column) => (
                <ColumnView key={column} column={column} cards={byColumn.get(column) ?? []} />
              ))}
            </div>
          )}

          {!loading && cards.length === 0 && !todayMode && (
            <p className="text-sm text-center mt-4" style={{ color: 'var(--muted-foreground)' }}>
              No work items yet. Create a task to put the AI to work.
            </p>
          )}
        </>
      )}
    </div>
  );
}
