/**
 * board/TaskDetailPage.tsx — detail view for one SyteLine task-agent run
 * (`/board/task/:id`).
 *
 * Shows the request metadata, the model's plan, the per-step audit log
 * (with evidence references — screenshot PNGs have no serving endpoint, so
 * evidence IDs are shown as references), the outcome, and a cancel action
 * for non-terminal runs. Polls while the task is non-terminal.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { cancelSytelineTask, getSytelineTask, type SytelineTaskDetail, type TaskStepLog } from '../api/tasks';
import { defaultToolClassification } from '../api/tools';
import { usePolling } from '../hooks/usePolling';
import ErrorState, { DisabledState, NotAuthorizedState } from '../components/ui/ErrorState';
import StatusBadge from '../components/ui/StatusBadge';
import Spinner from '../components/ui/Spinner';
import { KIND_META, classifySourceError, fullTime, relativeTime, type SourceHealth } from './types';

const TASK_STATUS_META: Record<SytelineTaskDetail['status'], { label: string; color: string; bg: string }> = {
  assigned: { label: 'Assigned', color: '#4a4a4a', bg: '#f0f0f0' },
  in_progress: { label: 'In progress', color: '#1d4ed8', bg: '#dbeafe' },
  completed: { label: 'Completed', color: '#15803d', bg: '#dcfce7' },
  blocked: { label: 'Blocked', color: 'var(--danger)', bg: 'var(--danger-bg)' },
  cancelled: { label: 'Cancelled', color: '#6b7280', bg: '#f3f4f6' },
};

const STEP_STATUS_META: Record<TaskStepLog['status'], { label: string; color: string }> = {
  pending: { label: 'Pending', color: '#6b7280' },
  running: { label: 'Running', color: '#1d4ed8' },
  ok: { label: 'Done', color: '#15803d' },
  failed: { label: 'Failed', color: 'var(--danger)' },
  skipped: { label: 'Skipped', color: '#9a3412' },
};

/** Friendly one-line rendering of a runTaskPlan DSL step (unknown shape → raw action name). */
function describePlanStep(step: unknown): string {
  if (!step || typeof step !== 'object') return 'Unknown step';
  const s = step as Record<string, unknown>;
  const str = (value: unknown): string => (typeof value === 'string' ? value : '');
  switch (s.action) {
    case 'gotoForm': return `Go to form "${str(s.form)}"`;
    case 'fillField': return `Fill "${str(s.label)}" with "${str(s.value)}"`;
    case 'clickButton': return `Click "${str(s.label)}"`;
    case 'readScreen': return 'Read the screen';
    case 'assertText': return `Check the screen shows "${str(s.text)}"`;
    default: return String(s.action ?? 'Unknown step');
  }
}

function StepStatusIcon({ status }: { status: TaskStepLog['status'] }) {
  const color = STEP_STATUS_META[status].color;
  if (status === 'running') return <Spinner size={14} />;
  const path =
    status === 'ok'
      ? 'M3 8.5l3.5 3.5L13 4.5'
      : status === 'failed'
        ? 'M4 4l8 8M12 4l-8 8'
        : status === 'skipped'
          ? 'M3 8h10M8 3l5 5-5 5'
          : 'M8 4v4l3 2';
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-label={STEP_STATUS_META[status].label}>
      {status === 'pending' ? <circle cx="8" cy="8" r="6" /> : <path d={path} />}
    </svg>
  );
}

function StepLogItem({ step, index }: { step: TaskStepLog; index: number }) {
  const meta = STEP_STATUS_META[step.status];
  const observation = step.observation && step.observation.length > 200
    ? `${step.observation.slice(0, 200)}…`
    : step.observation;
  return (
    <li
      className="rounded-lg p-3"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-center gap-2">
        <StepStatusIcon status={step.status} />
        <span className="text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>Step {index + 1}</span>
        <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>{step.action}</span>
        <span className="text-xs" style={{ color: meta.color }}>{meta.label}</span>
      </div>
      {step.detail && (
        <p className="text-sm mt-1.5" style={{ color: 'var(--foreground)' }}>{step.detail}</p>
      )}
      {observation && (
        <p className="text-xs mt-1.5 font-mono whitespace-pre-wrap break-words" style={{ color: 'var(--muted-foreground)' }}>
          {observation}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        {step.errorCode && (
          <span className="text-xs font-mono px-2 py-0.5 rounded" style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}>
            {step.errorCode}
          </span>
        )}
        {step.evidenceIds.map((evidenceId) => (
          <span
            key={evidenceId}
            title="Screenshot evidence reference (no preview available)"
            className="text-xs font-mono px-2 py-0.5 rounded"
            style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}
          >
            📷 {evidenceId}
          </span>
        ))}
      </div>
    </li>
  );
}

export default function TaskDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const classification = defaultToolClassification(user?.clearance ?? 'PUBLIC');

  const [task, setTask] = useState<SytelineTaskDetail | null>(null);
  const [health, setHealth] = useState<SourceHealth>('loading');
  const [message, setMessage] = useState('');
  const [planOpen, setPlanOpen] = useState(true);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState('');

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const detail = await getSytelineTask(classification, id);
      setTask(detail);
      setHealth('ok');
      setMessage('');
    } catch (error) {
      setHealth(classifySourceError(error));
      setMessage(error instanceof Error ? error.message : 'Could not load the task.');
    }
  }, [id, classification]);

  useEffect(() => { void load(); }, [load]);

  const terminal = task ? ['completed', 'blocked', 'cancelled'].includes(task.status) : true;
  usePolling(load, { active: health === 'ok' && !terminal, intervalMs: 5000 });

  const cancel = async () => {
    if (!id || cancelling) return;
    const ok = window.confirm(
      'Cancel this task? The runner stops after its current step and the task is marked cancelled.',
    );
    if (!ok) return;
    setCancelling(true);
    setCancelError('');
    try {
      await cancelSytelineTask(classification, id, true);
      await load();
    } catch (error) {
      setCancelError(error instanceof ApiError ? error.message : 'Could not cancel the task.');
    } finally {
      setCancelling(false);
    }
  };

  if (health === 'loading') {
    return (
      <div className="flex-1 grid place-items-center" style={{ color: 'var(--muted-foreground)' }}>
        <Spinner size={24} />
      </div>
    );
  }
  if (health === 'disabled') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <DisabledState
          product="SyteLine task automation"
          hint="Task detail needs the SyteLine UI automation enabled server-side (SYTELINE_UI_ENABLED)."
        />
      </div>
    );
  }
  if (health === 'forbidden') {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <NotAuthorizedState product="SyteLine task automation" />
      </div>
    );
  }
  if (health === 'error' || !task) {
    return (
      <div className="flex-1 overflow-y-auto p-6">
        <ErrorState message={message || 'Could not load the task.'} onRetry={() => void load()} />
      </div>
    );
  }

  const statusMeta = TASK_STATUS_META[task.status];
  const kindMeta = KIND_META.task;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto p-6">
      <div className="max-w-3xl mx-auto space-y-4">
        <Link to="/board" className="text-sm hover:underline" style={{ color: 'var(--muted-foreground)' }}>
          ← Back to board
        </Link>

        <header className="rounded-lg p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <div className="flex flex-wrap items-center gap-2">
            <StatusBadge label={kindMeta.label} color={kindMeta.color} bg={kindMeta.bg} />
            <StatusBadge label={statusMeta.label} color={statusMeta.color} bg={statusMeta.bg} />
            {!terminal && (
              <span className="text-xs flex items-center gap-1.5" style={{ color: 'var(--muted-foreground)' }}>
                <Spinner size={12} /> live
              </span>
            )}
          </div>
          <h1 className="text-lg font-semibold mt-2" style={{ color: 'var(--foreground)' }}>{task.title}</h1>
          <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
            Updated {relativeTime(task.updatedAt)} · {fullTime(task.updatedAt)}
          </p>
        </header>

        <section className="rounded-lg p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--foreground)' }}>Request</h2>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <div>
              <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Requested by</dt>
              <dd className="font-mono text-xs mt-0.5" style={{ color: 'var(--foreground)' }}>{task.requesterUserId ?? '—'}</dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Writes</dt>
              <dd className="mt-0.5">
                <StatusBadge
                  label={task.autoApproveWrites ? 'Pre-approved' : 'Read-only until approved'}
                  color={task.autoApproveWrites ? '#b45309' : '#15803d'}
                  bg={task.autoApproveWrites ? '#fef3c7' : '#dcfce7'}
                />
              </dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Created</dt>
              <dd className="mt-0.5" style={{ color: 'var(--foreground)' }}>{fullTime(task.createdAt)}</dd>
            </div>
            <div>
              <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Started</dt>
              <dd className="mt-0.5" style={{ color: 'var(--foreground)' }}>{fullTime(task.startedAt)}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Goal</dt>
              <dd className="mt-0.5 whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>{task.goal}</dd>
            </div>
          </dl>
        </section>

        <section className="rounded-lg p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
          <button
            onClick={() => setPlanOpen((open) => !open)}
            aria-expanded={planOpen}
            className="flex items-center justify-between w-full text-sm font-semibold"
            style={{ color: 'var(--foreground)' }}
          >
            Model plan ({task.plan.length} steps)
            <span aria-hidden="true">{planOpen ? '▾' : '▸'}</span>
          </button>
          {planOpen && (
            <ol className="mt-2 space-y-1.5 list-decimal list-inside text-sm" style={{ color: 'var(--foreground)' }}>
              {task.plan.length === 0 && (
                <li className="text-xs list-none" style={{ color: 'var(--muted-foreground)' }}>
                  No plan yet — the runner plans the steps when it picks up the task.
                </li>
              )}
              {task.plan.map((step, index) => (
                <li key={index} className="text-sm">{describePlanStep(step)}</li>
              ))}
            </ol>
          )}
        </section>

        <section aria-label="Step audit log">
          <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
            Audit log ({task.steps.length})
          </h2>
          {task.steps.length === 0 ? (
            <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              No steps recorded yet.
            </p>
          ) : (
            <ul className="space-y-2">
              {task.steps.map((step, index) => <StepLogItem key={index} step={step} index={index} />)}
            </ul>
          )}
        </section>

        {(task.resultSummary || task.blockedReason) && (
          <section className="rounded-lg p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            <h2 className="text-sm font-semibold mb-2" style={{ color: 'var(--foreground)' }}>
              {task.status === 'blocked' ? 'Blocked' : 'Result'}
            </h2>
            <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
              {task.status === 'blocked' ? task.blockedReason : task.resultSummary}
            </p>
          </section>
        )}

        {!terminal && (
          <section className="rounded-lg p-4" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
            {cancelError && (
              <p role="alert" className="text-sm mb-2" style={{ color: 'var(--danger)' }}>{cancelError}</p>
            )}
            <button
              onClick={() => void cancel()}
              disabled={cancelling}
              className="text-sm font-medium px-4 py-2 rounded-md disabled:opacity-50"
              style={{ border: '1px solid var(--danger)', color: 'var(--danger)' }}
            >
              {cancelling ? 'Cancelling…' : 'Cancel task'}
            </button>
            <p className="text-xs mt-2" style={{ color: 'var(--muted-foreground)' }}>
              You are asked to confirm before anything is cancelled.
            </p>
          </section>
        )}

        <button
          onClick={() => navigate('/board')}
          className="text-sm hover:underline"
          style={{ color: 'var(--muted-foreground)' }}
        >
          ← Back to board
        </button>
      </div>
    </div>
  );
}
