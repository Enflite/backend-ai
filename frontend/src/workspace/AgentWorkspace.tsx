/**
 * workspace/AgentWorkspace.tsx — the agent execution workspace
 * (`/tasks`, `/tasks/:id`).
 *
 * Relay's three-column feel inside our shell: the global icon rail stays
 * global; this view owns the contextual task list (`ContextSidebar`, 272px,
 * slide-over ≤720px) plus the main execution panel — the existing
 * `TaskWorkspace` bound to the selected task. No task selected yet:
 * "Select a task to watch it work."
 *
 * The list is live: `listSytelineTasks` plus bounded per-task details (the
 * same pattern the old landing used — the list endpoint caps at 100, and
 * details fetch lazily), refreshed every 15s. Every row traces to API data:
 * status dot (via taskDisplayStatus), title, and relative updated time.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { usePolling } from '../hooks/usePolling';
import { relativeTime } from '../board/types';
import ContextSidebar from '../shell/ContextSidebar';
import { Icon } from '../components/icons';
import { Button, Skeleton } from '../components/ui/primitives';
import { DisabledState } from '../components/ui/ErrorState';
import TaskWorkspace from '../tasks/TaskWorkspace';
import {
  getSytelineTask,
  listSytelineTasks,
  toolClassificationFor,
  type SytelineTaskListItem,
} from '../agents/api';
import { taskDisplayStatus, type TaskDisplayStatus } from '../agents/types';
import { TASK_DOT_COLORS, sortTasksForSidebar } from './statusCopy';

function TaskDot({ status, label }: { status: TaskDisplayStatus; label: string }) {
  return (
    <span
      role="img"
      aria-label={label}
      className={status === 'running' ? 'animate-pulse-dot' : undefined}
      style={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        background: TASK_DOT_COLORS[status],
      }}
    />
  );
}

function TaskList({
  items,
  selectedId,
  blockedReasons,
  onSelect,
}: {
  items: SytelineTaskListItem[];
  selectedId: string | undefined;
  blockedReasons: Record<string, string | undefined>;
  onSelect: () => void;
}) {
  const sorted = sortTasksForSidebar(items, blockedReasons);
  return (
    <ul className="ctx-list" aria-label="Agent tasks">
      {sorted.map((item) => {
        const display = taskDisplayStatus({ status: item.status, blockedReason: blockedReasons[item._id] });
        const selected = item._id === selectedId;
        return (
          <li key={item._id}>
            <NavLink
              to={`/tasks/${item._id}`}
              onClick={onSelect}
              aria-current={selected ? 'page' : undefined}
              aria-label={`${item.title} — ${display.label}`}
              className={`ctx-row${selected ? ' ctx-row--selected' : ''}`}
              style={{ textDecoration: 'none' }}
            >
              <span className="flex items-center gap-2 min-w-0">
                <TaskDot status={display.status} label={display.label} />
                <span className="ctx-row__title flex-1">{item.title}</span>
              </span>
              <span className="ctx-row__meta" style={{ paddingLeft: 16 }}>
                {display.label} · Updated {relativeTime(item.updatedAt)}
              </span>
              {selected && <span className="ctx-row__edge" aria-hidden="true" />}
            </NavLink>
          </li>
        );
      })}
    </ul>
  );
}

function NoSelection({ onNew }: { onNew: () => void }) {
  return (
    <div className="flex-1 overflow-y-auto">
      <div className="h-full min-h-[40vh] grid place-items-center px-6 py-12">
        <div className="text-center max-w-sm animate-fade-up">
          <span
            aria-hidden="true"
            className="mx-auto w-11 h-11 grid place-items-center rounded-full"
            style={{
              border: '1px solid var(--border)',
              background: 'var(--secondary)',
              color: 'var(--muted-foreground)',
            }}
          >
            <Icon name="activity" size={20} />
          </span>
          <h2 className="text-base font-semibold mt-4" style={{ color: 'var(--foreground)' }}>
            Select a task to watch it work
          </h2>
          <p className="text-sm mt-1.5" style={{ color: 'var(--muted-foreground)' }}>
            Pick a run from the list to follow its plan, step activity, and
            evidence as it happens — or start something new.
          </p>
          <Button variant="primary" size="sm" className="mt-4" onClick={onNew}>
            New task
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function AgentWorkspace() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [items, setItems] = useState<SytelineTaskListItem[] | null>(null);
  const [blockedReasons, setBlockedReasons] = useState<Record<string, string | undefined>>({});
  // Read inside the memoized poll callback via ref so details fetch once per
  // task instead of re-fetching the whole list on every poll.
  const blockedReasonsRef = useRef(blockedReasons);
  blockedReasonsRef.current = blockedReasons;
  const [error, setError] = useState<string | null>(null);
  const [uiDisabled, setUiDisabled] = useState(false);

  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  const refresh = useCallback(async () => {
    try {
      const tasks = await listSytelineTasks(classification);
      setItems(tasks);
      setError(null);
      // Approval-state needs the detail record. Bounded: the list endpoint
      // caps at 100; fetch details lazily in the background, once per task.
      const missing = tasks.filter((t) => !(t._id in blockedReasonsRef.current));
      if (missing.length > 0) {
        const settled = await Promise.allSettled(
          missing.map(async (t) => {
            const d = await getSytelineTask(classification, t._id);
            return [t._id, d.blockedReason] as const;
          }),
        );
        const next: Record<string, string | undefined> = {};
        for (const s of settled) {
          if (s.status === 'fulfilled') next[s.value[0]] = s.value[1];
        }
        if (Object.keys(next).length > 0) {
          setBlockedReasons((prev) => ({ ...prev, ...next }));
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SYTELINE_UI_DISABLED') {
        setUiDisabled(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load tasks.');
      }
    }
  }, [classification]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, { intervalMs: 15000, active: !uiDisabled });

  function goNewTask(): void {
    setMobileOpen(false);
    navigate('/agents/tasks/new');
  }

  const count = items?.length ?? 0;

  return (
    <div className="flex flex-1 min-h-0 overflow-hidden">
      <ContextSidebar
        label="Agent tasks"
        mobileOpen={mobileOpen}
        onMobileToggle={() => setMobileOpen((value) => !value)}
        header={
          <div>
            <p className="ctx-group-label" style={{ paddingLeft: 2, paddingRight: 2 }}>
              Tasks
              {items !== null && (
                <span className="font-normal normal-case tracking-normal"> · {count}</span>
              )}
            </p>
            <button type="button" className="ctx-new" style={{ margin: '2px 0 6px', width: '100%' }} onClick={goNewTask}>
              <span className="ctx-new__icon" aria-hidden="true">
                <Icon name="plus" size={15} />
              </span>
              New task
            </button>
          </div>
        }
      >
        {error && (
          <p className="text-xs px-4 py-2" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </p>
        )}
        {items === null && !error && !uiDisabled && (
          <div className="px-3 py-2 space-y-2" aria-label="Loading tasks">
            <Skeleton width="100%" height="3.25rem" />
            <Skeleton width="100%" height="3.25rem" />
            <Skeleton width="85%" height="3.25rem" />
            <Skeleton width="100%" height="3.25rem" />
          </div>
        )}
        {items !== null && items.length === 0 && (
          <div className="px-4 py-10 text-center animate-fade-up">
            <p className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
              No tasks yet
            </p>
            <p className="text-xs mt-1.5 leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              Describe work and the agent gets going.
            </p>
            <Button variant="primary" size="sm" className="mt-4" onClick={goNewTask}>
              Create your first task
            </Button>
          </div>
        )}
        {items !== null && items.length > 0 && (
          <div className="px-2 pb-4">
            <TaskList
              items={items}
              selectedId={id}
              blockedReasons={blockedReasons}
              onSelect={() => setMobileOpen(false)}
            />
          </div>
        )}
      </ContextSidebar>

      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {uiDisabled ? (
          <div className="flex-1 overflow-y-auto">
            <div className="max-w-3xl mx-auto px-6 py-8">
              <DisabledState
                product="SyteLine task agents"
                hint="The backend kill-switch SYTELINE_UI_ENABLED is off, so the task system isn't available. Ask your admin to enable it."
              />
            </div>
          </div>
        ) : id ? (
          <TaskWorkspace key={id} taskId={id} />
        ) : (
          <NoSelection onNew={goNewTask} />
        )}
      </div>
    </div>
  );
}
