/**
 * agents/views/TaskDetailView.tsx — the task workspace (`/agents/tasks/:id`).
 *
 * One screen answering: what the agent intends to do (plan), what it is
 * doing (live step activity), what it actually did (step log), and what was
 * verified (assertions, evidence, final report). Approvals pause the run
 * inline; evidence screenshots render from the real serving endpoint.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import { ApiError } from '../../api';
import Spinner from '../../components/ui/Spinner';
import { usePolling } from '../../hooks/usePolling';
import { fullTime, relativeTime } from '../../board/types';
import {
  cancelSytelineTask,
  getSytelineTask,
  toolClassificationFor,
  type SytelineTaskDetail,
} from '../api';
import { taskDisplayStatus, taskProgress } from '../types';
import { TaskStatusBadge } from '../components/StatusGlyph';
import PlanSteps from '../components/PlanSteps';
import ApprovalPanel from '../components/ApprovalPanel';

const TERMINAL = new Set(['completed', 'blocked', 'cancelled']);

function FinalReport({ task }: { task: SytelineTaskDetail }) {
  const { done, total } = taskProgress(task);
  const verified = task.steps.filter(
    (s) => s.status === 'ok' && (s.action === 'assertText' || s.action === 'readScreen'),
  ).length;
  const evidenceCount = task.steps.reduce((n, s) => n + s.evidenceIds.length, 0);
  return (
    <section aria-label="Final report" className="mt-8">
      <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        Report
      </h2>
      <div
        className="mt-2 rounded-lg p-4"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div>
            <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Steps completed</dt>
            <dd className="font-semibold" style={{ color: 'var(--foreground)' }}>
              {done}/{total}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Verification checks</dt>
            <dd className="font-semibold" style={{ color: 'var(--foreground)' }}>
              {verified}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Screenshots</dt>
            <dd className="font-semibold" style={{ color: 'var(--foreground)' }}>
              {evidenceCount}
            </dd>
          </div>
          <div>
            <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Finished</dt>
            <dd className="font-semibold" style={{ color: 'var(--foreground)' }}>
              {task.completedAt ? relativeTime(task.completedAt) : '—'}
            </dd>
          </div>
        </dl>
        {task.resultSummary && (
          <p className="text-sm mt-3 whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
            {task.resultSummary}
          </p>
        )}
        {task.status === 'blocked' && task.blockedReason && (
          <p className="text-sm mt-3" style={{ color: 'var(--danger)' }}>
            Blocked: <span className="font-mono text-xs">{task.blockedReason}</span>
          </p>
        )}
        <p className="text-xs mt-3" style={{ color: 'var(--muted-foreground)' }}>
          Every claim above is backed by the step log and screenshots below — the audit trail
          is the report.
        </p>
      </div>
    </section>
  );
}

export default function TaskDetailView() {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const [task, setTask] = useState<SytelineTaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const detail = await getSytelineTask(classification, id);
      setTask(detail);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not load the task.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, classification]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const live = task !== null && !TERMINAL.has(task.status);
  usePolling(refresh, { intervalMs: 3000, active: live && error === null });

  async function doCancel() {
    if (!id) return;
    setCancelling(true);
    try {
      await cancelSytelineTask(classification, id, true);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the task.');
    } finally {
      setCancelling(false);
      setConfirmCancel(false);
    }
  }

  if (error && !task) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <p className="text-sm" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </p>
          <Link to="/agents/tasks" className="text-sm underline mt-2 inline-block" style={{ color: 'var(--accent)' }}>
            ← Back to tasks
          </Link>
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <p className="inline-flex items-center gap-2 text-sm" style={{ color: 'var(--muted-foreground)' }}>
            <Spinner size={14} /> Loading task…
          </p>
        </div>
      </div>
    );
  }

  const display = taskDisplayStatus(task);
  const progress = taskProgress(task);
  const nonTerminal = !TERMINAL.has(task.status);
  const waitingApproval = display.status === 'waiting_approval';

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <Link
          to="/agents/tasks"
          className="text-xs"
          style={{ color: 'var(--muted-foreground)' }}
        >
          ← Agent tasks
        </Link>

        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-semibold" style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)' }}>
                {task.title}
              </h1>
              <TaskStatusBadge status={display.status} label={display.label} />
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
              Created {fullTime(task.createdAt)}
              {task.startedAt ? ` · started ${relativeTime(task.startedAt)}` : ''}
              {display.reason && display.status !== 'waiting_approval' ? ` · ${display.reason}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            {task.conversationId && (
              <Link
                to={`/?conversation=${encodeURIComponent(task.conversationId)}`}
                className="text-xs px-3 py-1.5 rounded-md"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                Discuss in chat
              </Link>
            )}
            {nonTerminal && !confirmCancel && (
              <button
                type="button"
                onClick={() => setConfirmCancel(true)}
                className="text-xs px-3 py-1.5 rounded-md"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                Cancel task
              </button>
            )}
            {nonTerminal && confirmCancel && (
              <span className="inline-flex items-center gap-2" role="group" aria-label="Confirm cancel">
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Cancel this run?
                </span>
                <button
                  type="button"
                  onClick={() => void doCancel()}
                  disabled={cancelling}
                  className="text-xs font-medium px-3 py-1.5 rounded-md"
                  style={{ background: 'var(--danger)', color: '#fff' }}
                >
                  {cancelling ? 'Cancelling…' : 'Yes, cancel'}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmCancel(false)}
                  disabled={cancelling}
                  className="text-xs px-2 py-1.5"
                  style={{ color: 'var(--muted-foreground)' }}
                >
                  Keep
                </button>
              </span>
            )}
          </div>
        </div>

        {progress.total > 0 && (
          <div
            className="mt-3 h-1.5 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuenow={progress.done}
            aria-valuemin={0}
            aria-valuemax={progress.total}
            aria-label={`${progress.done} of ${progress.total} steps complete`}
            style={{ background: 'var(--secondary)' }}
          >
            <div
              className="h-full rounded-full transition-all"
              style={{
                width: `${Math.round((progress.done / progress.total) * 100)}%`,
                background: display.status === 'failed' ? 'var(--danger)' : 'var(--accent)',
              }}
            />
          </div>
        )}

        {error && (
          <p className="text-sm mt-3" style={{ color: 'var(--danger)' }} role="alert">
            {error}
          </p>
        )}

        {waitingApproval && (
          <div className="mt-6">
            <ApprovalPanel
              task={task}
              clearance={user?.clearance ?? 'PUBLIC'}
              onChanged={() => void refresh()}
            />
          </div>
        )}

        <section className="mt-6" aria-label="Goal">
          <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
            Goal
          </h2>
          <p className="text-sm mt-1 whitespace-pre-wrap" style={{ color: 'var(--muted-foreground)' }}>
            {task.goal}
          </p>
        </section>

        <section className="mt-6" aria-label="Plan and activity">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
              Plan &amp; activity
            </h2>
            {live && (
              <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <Spinner size={12} /> live
              </span>
            )}
          </div>
          <div className="mt-3">
            <PlanSteps taskId={task._id} plan={task.plan} steps={task.steps} />
          </div>
        </section>

        {TERMINAL.has(task.status) && <FinalReport task={task} />}

        <div className="mt-8 flex items-center gap-4">
          <button
            type="button"
            onClick={() => navigate('/agents/tasks/new')}
            className="text-sm"
            style={{ color: 'var(--accent)' }}
          >
            + New task
          </button>
          <Link to="/agents/workflows" className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Workflows
          </Link>
        </div>
      </div>
    </div>
  );
}
