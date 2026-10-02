/**
 * agents/views/TasksLanding.tsx — the Agent Task Workspace landing (`/agents/tasks`).
 *
 * Sections mirror the task lifecycle: waiting for approval first (needs the
 * human), then running, queued, failed/blocked, completed. Every row is a
 * live link to the task workspace — no mock data, ever.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { ApiError } from '../../api';
import { DisabledState } from '../../components/ui/ErrorState';
import { PageHeader } from '../../components/ui/primitives';
import Spinner from '../../components/ui/Spinner';
import { usePolling } from '../../hooks/usePolling';
import { relativeTime } from '../../board/types';
import {
  getSytelineTask,
  listSytelineTasks,
  toolClassificationFor,
  type SytelineTaskListItem,
  type TaskStepLog,
} from '../api';
import { taskDisplayStatus, taskProgress } from '../types';
import { TaskStatusBadge } from '../components/StatusGlyph';

type SectionId = 'waiting_approval' | 'running' | 'queued' | 'failed' | 'completed';

const SECTIONS: { id: SectionId; title: string; hint: string }[] = [
  { id: 'waiting_approval', title: 'Waiting for your approval', hint: 'The agent did its checks — review and approve to continue.' },
  { id: 'running', title: 'Running', hint: 'The agent is working now.' },
  { id: 'queued', title: 'Queued', hint: 'Created — the runner picks these up.' },
  { id: 'failed', title: 'Failed & blocked', hint: 'Need attention. Open one to see what happened.' },
  { id: 'completed', title: 'Completed', hint: 'Finished runs with their reports and evidence.' },
];

function sectionOf(item: SytelineTaskListItem, detail: { blockedReason?: string } | null): SectionId {
  const display = taskDisplayStatus({ status: item.status, blockedReason: detail?.blockedReason });
  switch (display.status) {
    case 'waiting_approval':
      return 'waiting_approval';
    case 'running':
      return 'running';
    case 'queued':
      return 'queued';
    case 'completed':
      return 'completed';
    default:
      return 'failed';
  }
}

function TaskRow({
  item,
  detail,
}: {
  item: SytelineTaskListItem;
  detail: { blockedReason?: string; steps?: TaskStepLog[] } | null;
}) {
  const display = taskDisplayStatus({ status: item.status, blockedReason: detail?.blockedReason });
  const progress = detail?.steps ? taskProgress({ steps: detail.steps }) : null;
  return (
    <Link
      to={`/agents/tasks/${item._id}`}
      className="block rounded-lg p-4 hover:shadow-sm transition-shadow"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      aria-label={`${item.title} — ${display.label}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--foreground)' }}>
            {item.title}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            Updated {relativeTime(item.updatedAt)}
            {progress && progress.total > 0 ? ` · ${progress.done}/${progress.total} steps` : ''}
          </p>
        </div>
        <TaskStatusBadge status={display.status} label={display.label} />
      </div>
      {progress && progress.total > 0 && (
        <div
          className="mt-2.5 h-1.5 rounded-full overflow-hidden"
          role="progressbar"
          aria-valuenow={progress.done}
          aria-valuemin={0}
          aria-valuemax={progress.total}
          aria-label={`${progress.done} of ${progress.total} steps complete`}
          style={{ background: 'var(--secondary)' }}
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round((progress.done / progress.total) * 100)}%`,
              background: display.status === 'failed' ? '#a50a24' : 'var(--accent)',
            }}
          />
        </div>
      )}
    </Link>
  );
}

export default function TasksLanding() {
  const { user } = useAuth();
  const [items, setItems] = useState<SytelineTaskListItem[] | null>(null);
  const [details, setDetails] = useState<Record<string, { blockedReason?: string; steps?: TaskStepLog[] }>>({});
  const [error, setError] = useState<string | null>(null);
  const [uiDisabled, setUiDisabled] = useState(false);

  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  const refresh = useCallback(async () => {
    try {
      const tasks = await listSytelineTasks(classification);
      setItems(tasks);
      setError(null);
      // Detail per task is needed for approval-state and progress. Bounded:
      // the list endpoint caps at 100; fetch details lazily in the background.
      const missing = tasks.filter((t) => !(t._id in details));
      if (missing.length > 0) {
        const settled = await Promise.allSettled(
          missing.map(async (t) => {
            const d = await getSytelineTask(classification, t._id);
            return [t._id, { blockedReason: d.blockedReason, steps: d.steps }] as const;
          }),
        );
        const next: Record<string, { blockedReason?: string; steps?: TaskStepLog[] }> = {};
        for (const s of settled) {
          if (s.status === 'fulfilled') next[s.value[0]] = s.value[1];
        }
        if (Object.keys(next).length > 0) {
          setDetails((prev) => ({ ...prev, ...next }));
        }
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SYTELINE_UI_DISABLED') {
        setUiDisabled(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Could not load tasks.');
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classification]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, { intervalMs: 5000, active: !uiDisabled });

  if (uiDisabled) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <PageHeader title="Agent Tasks" description="Autonomous SyteLine work that runs as you." />
          <div className="mt-6">
            <DisabledState
              product="SyteLine task agents"
              hint="The backend kill-switch SYTELINE_UI_ENABLED is off, so the task system isn't available. Ask your admin to enable it."
            />
          </div>
        </div>
      </div>
    );
  }

  const grouped: Record<SectionId, SytelineTaskListItem[]> = {
    waiting_approval: [],
    running: [],
    queued: [],
    failed: [],
    completed: [],
  };
  for (const item of items ?? []) {
    grouped[sectionOf(item, details[item._id] ?? null)].push(item);
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-start justify-between gap-4">
          <PageHeader
            title="Agent Tasks"
            description="Give Enflite a real-world task. The agent plans it, does the work as you in SyteLine, verifies each step, and pauses for your approval before any change."
          />
          <Link
            to="/agents/tasks/new"
            className="flex-shrink-0 text-sm font-medium px-4 py-2 rounded-md mt-1"
            style={{ background: 'var(--accent)', color: '#fff' }}
          >
            + New Task
          </Link>
        </div>

        {error && (
          <p className="text-sm mt-4" style={{ color: '#a50a24' }} role="alert">
            {error}
          </p>
        )}
        {items === null && !error && (
          <p className="mt-8 inline-flex items-center gap-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
            <Spinner size={14} /> Loading tasks…
          </p>
        )}

        {items !== null && items.length === 0 && (
          <div
            className="mt-6 rounded-lg p-8 text-center"
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
          >
            <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
              No tasks yet
            </h2>
            <p className="text-sm mt-1 max-w-md mx-auto" style={{ color: 'var(--muted-foreground)' }}>
              Describe the work in plain language — for example, “Bring TRN up to the current
              eTRR build and run the validation checklist.” The agent turns it into a plan you
              can watch, approve, and audit.
            </p>
            <Link
              to="/agents/tasks/new"
              className="inline-block mt-4 text-sm font-medium px-4 py-2 rounded-md"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              Create your first task
            </Link>
          </div>
        )}

        {SECTIONS.map((section) => {
          const rows = grouped[section.id];
          if (rows.length === 0) return null;
          return (
            <section key={section.id} className="mt-8" aria-label={section.title}>
              <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                {section.title}
                <span className="ml-2 font-normal" style={{ color: 'var(--muted-foreground)' }}>
                  {rows.length}
                </span>
              </h2>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                {section.hint}
              </p>
              <div className="mt-3 space-y-2">
                {rows.map((item) => (
                  <TaskRow key={item._id} item={item} detail={details[item._id] ?? null} />
                ))}
              </div>
            </section>
          );
        })}

        <p className="text-xs mt-8" style={{ color: 'var(--muted-foreground)' }}>
          <Link to="/agents/workflows" className="underline">
            Workflows
          </Link>{' '}
          turn finished tasks into reusable templates.
        </p>
      </div>
    </div>
  );
}
