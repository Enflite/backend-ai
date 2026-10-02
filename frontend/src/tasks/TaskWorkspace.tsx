/**
 * tasks/TaskWorkspace.tsx — the canonical task workspace (`/tasks/:id`).
 *
 * One screen for a SyteLine agent task, embedded in the AgentWorkspace
 * (`workspace/AgentWorkspace.tsx`) next to the live task list:
 *   Activity  — run header with the live status line, request card, and the
 *               step-activity timeline (Relay execution shape)
 *   Evidence  — final report, full step log, screenshot evidence gallery
 *   Approvals — write-approval gate, requeue/resume, cancel
 *
 * Replaces the two superseded detail screens (`/agents/tasks/:id` and
 * `/board/task/:id`). Every capability they had — approve, reject, requeue,
 * cancel, evidence, report, discuss-in-chat, progress, polling — lives here.
 * Polls every 3s while the task is non-terminal (pauses when the tab is
 * hidden, backs off on failures — see usePolling).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { usePolling } from '../hooks/usePolling';
import {
  Badge,
  Button,
  Card,
  LiveDot,
  SectionLabel,
  Skeleton,
} from '../components/ui/primitives';
import ErrorState, { DisabledState, NotAuthorizedState } from '../components/ui/ErrorState';
import { TaskStatusBadge } from '../agents/components/StatusGlyph';
import PlanSteps from '../agents/components/PlanSteps';
import ApprovalPanel from '../agents/components/ApprovalPanel';
import EvidenceImage from '../agents/components/EvidenceImage';
import {
  cancelSytelineTask,
  getSytelineTask,
  requeueSytelineTask,
  toolClassificationFor,
  type SytelineTaskDetail,
} from '../agents/api';
import { taskDisplayStatus, taskProgress } from '../agents/types';
import {
  classifySourceError,
  fullTime,
  relativeTime,
  type SourceHealth,
} from '../board/types';
import type { DataClassification } from '../types';
import {
  DEFAULT_TASK_TAB,
  TASK_TAB_LABELS,
  TASK_TABS,
  parseTaskTab,
  type TaskTab,
} from './tab';
import { runSummary } from '../workspace/statusCopy';

const TERMINAL = new Set(['completed', 'blocked', 'cancelled']);

/* ------------------------------------------------------------------ */
/* Tab bar                                                             */
/* ------------------------------------------------------------------ */

function TabBar({ tab, onChange }: { tab: TaskTab; onChange: (next: TaskTab) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);

  function focusAndSelect(index: number): void {
    onChange(TASK_TABS[index]);
    refs.current[index]?.focus();
  }

  function onKeyDown(event: React.KeyboardEvent, index: number): void {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      focusAndSelect((index + 1) % TASK_TABS.length);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      focusAndSelect((index - 1 + TASK_TABS.length) % TASK_TABS.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusAndSelect(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusAndSelect(TASK_TABS.length - 1);
    }
  }

  return (
    <div
      role="tablist"
      aria-label="Task views"
      className="flex gap-1"
      style={{ borderBottom: '1px solid var(--border)' }}
    >
      {TASK_TABS.map((value, index) => {
        const selected = value === tab;
        return (
          <button
            key={value}
            ref={(el) => {
              refs.current[index] = el;
            }}
            role="tab"
            id={`task-tab-${value}`}
            aria-selected={selected}
            aria-controls={`task-tabpanel-${value}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(value)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className="px-3 py-2 text-sm font-medium"
            style={{
              color: selected ? 'var(--foreground)' : 'var(--muted-foreground)',
              borderBottom: selected ? '2px solid var(--accent)' : '2px solid transparent',
              marginBottom: '-1px',
            }}
          >
            {TASK_TAB_LABELS[value]}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Cancel (two-step confirm, shared by the header and Approvals tab)    */
/* ------------------------------------------------------------------ */

function CancelControl({
  classification,
  taskId,
  onCancelled,
  onError,
  size = 'sm',
}: {
  classification: DataClassification;
  taskId: string;
  onCancelled: () => void;
  onError: (message: string) => void;
  size?: 'sm' | 'md';
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function doCancel(): Promise<void> {
    setBusy(true);
    try {
      await cancelSytelineTask(classification, taskId, true);
      onCancelled();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not cancel the task.');
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  if (!confirming) {
    return (
      <Button variant="outline" size={size} onClick={() => setConfirming(true)}>
        Cancel task
      </Button>
    );
  }
  return (
    <span className="inline-flex items-center gap-2 flex-wrap" role="group" aria-label="Confirm cancel">
      <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        Cancel this run?
      </span>
      <Button variant="danger" size={size} disabled={busy} onClick={() => void doCancel()}>
        {busy ? 'Cancelling…' : 'Yes, cancel'}
      </Button>
      <Button variant="ghost" size={size} disabled={busy} onClick={() => setConfirming(false)}>
        Keep
      </Button>
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Review tab: final report                                            */
/* ------------------------------------------------------------------ */

function ReportStats({ task }: { task: SytelineTaskDetail }) {
  const { done, total } = taskProgress(task);
  const verified = task.steps.filter(
    (s) => s.status === 'ok' && (s.action === 'assertText' || s.action === 'readScreen'),
  ).length;
  const evidenceCount = task.steps.reduce((n, s) => n + s.evidenceIds.length, 0);
  const stats: Array<[string, string]> = [
    ['Steps completed', `${done}/${total}`],
    ['Verification checks', String(verified)],
    ['Screenshots', String(evidenceCount)],
    ['Finished', task.completedAt ? relativeTime(task.completedAt) : '—'],
  ];
  return (
    <Card className="p-4">
      <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
        {stats.map(([label, value]) => (
          <div key={label}>
            <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {label}
            </dt>
            <dd className="font-semibold" style={{ color: 'var(--foreground)' }}>
              {value}
            </dd>
          </div>
        ))}
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
    </Card>
  );
}

function EvidenceGallery({ task }: { task: SytelineTaskDetail }) {
  const items: Array<{ stepIndex: number; evidenceId: string }> = [];
  task.steps.forEach((step, stepIndex) => {
    step.evidenceIds.forEach((evidenceId) => items.push({ stepIndex, evidenceId }));
  });
  if (items.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
        No screenshots captured for this task.
      </p>
    );
  }
  return (
    <ul className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {items.map(({ stepIndex, evidenceId }) => (
        <li key={`${stepIndex}-${evidenceId}`}>
          <EvidenceImage
            taskId={task._id}
            evidenceId={evidenceId}
            label={`Screenshot evidence for step ${stepIndex + 1}`}
          />
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

/**
 * Rendered inside `workspace/AgentWorkspace.tsx`, which owns the task list.
 * Accepts an explicit taskId; falls back to the `:id` route param so the
 * component also works as a standalone route.
 */
export default function TaskWorkspace({ taskId }: { taskId?: string } = {}) {
  const { id: routeId } = useParams<{ id: string }>();
  const id = taskId ?? routeId;
  const { user } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = parseTaskTab(searchParams.get('tab'));

  const [task, setTask] = useState<SytelineTaskDetail | null>(null);
  const [health, setHealth] = useState<SourceHealth>('loading');
  const [message, setMessage] = useState('');
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [resuming, setResuming] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const hasTaskRef = useRef(false);

  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  function setTab(next: TaskTab): void {
    const params = new URLSearchParams(searchParams);
    if (next === DEFAULT_TASK_TAB) {
      params.delete('tab');
    } else {
      params.set('tab', next);
    }
    setSearchParams(params, { replace: true });
  }

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const detail = await getSytelineTask(classification, id);
      setTask(detail);
      hasTaskRef.current = true;
      setHealth('ok');
      setRefreshError(null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not load the task.';
      // Only the first load classifies into a full-page state; later
      // refresh failures surface as an inline alert so the workspace
      // (and its live view) stays up.
      if (!hasTaskRef.current) {
        setHealth(classifySourceError(err));
        setMessage(msg);
      }
      setRefreshError(msg);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, classification]);

  useEffect(() => {
    setHealth('loading');
    setMessage('');
    setRefreshError(null);
    hasTaskRef.current = false;
    void refresh();
  }, [refresh]);

  function retry(): void {
    setHealth('loading');
    setMessage('');
    setRefreshError(null);
    void refresh();
  }

  const live = task !== null && !TERMINAL.has(task.status);
  usePolling(refresh, { intervalMs: 3000, active: live && refreshError === null });

  // The parent workspace renders its own "select a task" state — this guard
  // only fires if the component is mounted without a task id at all.
  if (!id) return null;

  async function doRequeue(): Promise<void> {
    if (!id) return;
    setResuming(true);
    setActionError(null);
    try {
      await requeueSytelineTask(classification, id);
      await refresh();
    } catch (err) {
      setActionError(err instanceof ApiError ? err.message : 'Could not requeue the task.');
    } finally {
      setResuming(false);
    }
  }

  /* ---- full-page states ---- */

  if (health === 'loading' || (health === 'ok' && !task)) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8 space-y-4" aria-label="Loading task">
          <Skeleton width="12rem" height="1.5rem" />
          <Skeleton width="100%" height="3rem" />
          <Skeleton width="100%" height="8rem" />
          <Skeleton width="60%" height="2rem" />
        </div>
      </div>
    );
  }
  if (health === 'disabled') {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <DisabledState
            product="SyteLine task automation"
            hint="Task detail needs the SyteLine UI automation enabled server-side (SYTELINE_UI_ENABLED)."
          />
          <Link to="/tasks" className="text-sm underline mt-4 inline-block" style={{ color: 'var(--accent)' }}>
            ← Back to tasks
          </Link>
        </div>
      </div>
    );
  }
  if (health === 'forbidden') {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <NotAuthorizedState product="SyteLine task agents" />
        </div>
      </div>
    );
  }
  if (!task) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-6 py-8">
          <ErrorState message={message || 'Could not load the task.'} onRetry={retry} />
          <Link to="/tasks" className="text-sm underline mt-4 inline-block" style={{ color: 'var(--accent)' }}>
            ← Back to tasks
          </Link>
        </div>
      </div>
    );
  }

  /* ---- workspace ---- */

  const display = taskDisplayStatus(task);
  const progress = taskProgress(task);
  const summary = runSummary(task);
  const nonTerminal = !TERMINAL.has(task.status);
  const terminal = !nonTerminal;
  const waitingApproval = display.status === 'waiting_approval';
  const blocked = task.status === 'blocked' && !waitingApproval;
  const hasActivity = task.steps.length > 0;
  const planning = !hasActivity && nonTerminal;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <nav aria-label="Breadcrumb" className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          <Link to="/tasks" className="hover:underline">
            Tasks
          </Link>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">SyteLine task</span>
        </nav>

        <div className="mt-2 flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="font-semibold" style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)' }}>
                {task.title}
              </h1>
              <TaskStatusBadge status={display.status} label={display.label} />
              {nonTerminal && <LiveDot label="live" />}
            </div>
            <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
              Created {fullTime(task.createdAt)}
              {task.startedAt ? ` · started ${relativeTime(task.startedAt)}` : ''}
              {` · updated ${relativeTime(task.updatedAt)}`}
              {display.reason && display.status !== 'waiting_approval' ? ` · ${display.reason}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0 flex-wrap">
            {task.conversationId && (
              <Link
                to={`/chat?conversation=${encodeURIComponent(task.conversationId)}`}
                className="inline-flex items-center justify-center gap-1.5 font-medium rounded-md whitespace-nowrap text-xs px-2.5 py-1.5"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                Discuss in chat
              </Link>
            )}
            {nonTerminal && (
              <CancelControl
                classification={classification}
                taskId={task._id}
                onCancelled={() => void refresh()}
                onError={setActionError}
              />
            )}
          </div>
        </div>

        <Card className="mt-4 p-4 animate-fade-up" key={summary.statusText}>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold" style={{ color: 'var(--accent)' }}>
              {summary.statusText}
            </span>
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {summary.elapsed}
            </span>
          </div>
          <p className="text-sm font-medium mt-1.5" style={{ color: 'var(--foreground)' }}>
            {summary.title}
          </p>
          <p className="text-sm mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            {summary.detail}
          </p>
        </Card>

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

        {refreshError && (
          <p className="text-sm mt-3" style={{ color: 'var(--danger)' }} role="alert">
            {refreshError}{' '}
            <button type="button" onClick={retry} className="underline" style={{ color: 'var(--accent)' }}>
              Retry
            </button>
          </p>
        )}
        {actionError && (
          <p className="text-sm mt-3" style={{ color: 'var(--danger)' }} role="alert">
            {actionError}
          </p>
        )}

        <div className="mt-6">
          <TabBar tab={tab} onChange={setTab} />
        </div>

        <div key={tab} className="animate-fade-up">
          {tab === 'activity' && (
            <section role="tabpanel" id="task-tabpanel-activity" aria-labelledby="task-tab-activity" className="pt-6 space-y-8">
              <div>
                <SectionLabel>Request</SectionLabel>
                <Card className="mt-2 p-4">
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Requested by</dt>
                      <dd className="font-mono text-xs mt-0.5" style={{ color: 'var(--foreground)' }}>
                        {task.requesterUserId ?? '—'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Writes</dt>
                      <dd className="mt-0.5">
                        <Badge tone={task.autoApproveWrites ? 'amber' : 'green'}>
                          {task.autoApproveWrites ? 'Pre-approved' : 'Read-only until approved'}
                        </Badge>
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
                </Card>
              </div>

              <div>
                <SectionLabel>Plan &amp; activity</SectionLabel>
                <div className="mt-3">
                  {planning ? (
                    <div>
                      <p className="text-sm mb-3" style={{ color: 'var(--muted-foreground)' }} role="status">
                        The agent is planning…
                      </p>
                      <div className="space-y-2" aria-hidden="true">
                        <Skeleton width="100%" height="4.5rem" />
                        <Skeleton width="100%" height="4.5rem" />
                        <Skeleton width="70%" height="4.5rem" />
                      </div>
                    </div>
                  ) : (
                    <PlanSteps taskId={task._id} plan={task.plan} steps={task.steps} />
                  )}
                </div>
              </div>
            </section>
          )}

          {tab === 'evidence' && (
            <section role="tabpanel" id="task-tabpanel-evidence" aria-labelledby="task-tab-evidence" className="pt-6 space-y-8">
              <div>
                <SectionLabel>Report</SectionLabel>
                <div className="mt-2">
                  {terminal ? (
                    <ReportStats task={task} />
                  ) : (
                    <Card className="p-4">
                      <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                        The final report appears here when the run finishes — the step log and
                        screenshots below are live.
                      </p>
                      {task.resultSummary && (
                        <p className="text-sm mt-3 whitespace-pre-wrap" style={{ color: 'var(--foreground)' }}>
                          {task.resultSummary}
                        </p>
                      )}
                    </Card>
                  )}
                </div>
              </div>

              <div>
                <SectionLabel>Step log ({task.steps.length})</SectionLabel>
                <div className="mt-3">
                  <PlanSteps taskId={task._id} plan={task.plan} steps={task.steps} />
                </div>
              </div>

              <div>
                <SectionLabel>Evidence</SectionLabel>
                <div className="mt-3">
                  <EvidenceGallery task={task} />
                </div>
              </div>
            </section>
          )}

          {tab === 'approvals' && (
            <section role="tabpanel" id="task-tabpanel-approvals" aria-labelledby="task-tab-approvals" className="pt-6 space-y-6">
              {waitingApproval ? (
                <ApprovalPanel
                  task={task}
                  clearance={user?.clearance ?? 'PUBLIC'}
                  onChanged={() => void refresh()}
                />
              ) : blocked ? (
                <Card className="p-4">
                  <SectionLabel>Resume this task</SectionLabel>
                  <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
                    This task is blocked
                    {task.blockedReason ? (
                      <>
                        : <span className="font-mono text-xs">{task.blockedReason}</span>
                      </>
                    ) : (
                      '.'
                    )}{' '}
                    Requeue it to hand it back to the runner.
                  </p>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <Button variant="primary" size="sm" disabled={resuming} onClick={() => void doRequeue()}>
                      {resuming ? 'Requeueing…' : 'Requeue task'}
                    </Button>
                    <CancelControl
                      classification={classification}
                      taskId={task._id}
                      onCancelled={() => void refresh()}
                      onError={setActionError}
                    />
                  </div>
                </Card>
              ) : (
                <Card className="p-6 text-center">
                  <p className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    No pending approvals
                  </p>
                  <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
                    Approvals appear here when the agent pauses for a decision.
                  </p>
                </Card>
              )}
            </section>
          )}
        </div>

        <div className="mt-8 flex items-center gap-4">
          <Link to="/agents/tasks/new" className="text-sm" style={{ color: 'var(--accent)' }}>
            + New task
          </Link>
          <Link to="/agents/workflows" className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            Workflows
          </Link>
        </div>
      </div>
    </div>
  );
}
