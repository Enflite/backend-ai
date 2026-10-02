/**
 * views/HomeView.tsx — the command-center home (index `/`).
 *
 * Organized around the agent loop: create → watch → review → approve/ship.
 * A "Tell the AI what to do" hero feeds generateSytelineTasks (same
 * contract as the board's box); the sections below show needs-approval,
 * running, needs-attention, and completed-today rows from live
 * listSytelineTasks data — list first, then bounded detail fetches via
 * Promise.allSettled, same pattern as agents/views/TasksLanding.tsx.
 * A compact strip links the 3 most recent conversations. Chat lives at
 * /chat — this view never chats.
 *
 * Permission gating: without `syteline:ui` the hero is disabled with an
 * honest locked note and the task sections are replaced by a single
 * NotAuthorizedState panel; the conversation strip still shows. Nothing
 * here is mocked — every row is real API data.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError, api } from '../api';
import ErrorState, { DisabledState, NotAuthorizedState } from '../components/ui/ErrorState';
import { Button, LiveDot, PageHeader, SectionLabel, Skeleton } from '../components/ui/primitives';
import { usePolling } from '../hooks/usePolling';
import { relativeTime } from '../board/types';
import { hasAnyPermission } from '../shell/navRegistry';
import {
  cancelSytelineTask,
  generateSytelineTasks,
  generationConfirmation,
  getSytelineTask,
  listSytelineTasks,
  type SytelineTaskListItem,
} from '../api/tasks';
import { approveSytelineTask, toolClassificationFor } from '../agents/api';
import { taskDisplayStatus, taskProgress } from '../agents/types';
import { TaskStatusBadge } from '../agents/components/StatusGlyph';
import { groupTasksForHome, type HomeTaskDetail } from './homeGrouping';

type Confirming = 'none' | 'approve' | 'reject';

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Request failed';
}

/**
 * "Tell the AI what to do" — natural-language goal in, task runs out.
 * Same contract as the board's generate box: busy state, plain error,
 * success confirmation with count; the confirmation links to the board.
 */
function GenerateHero({
  onGenerated,
  disabled,
  lockedNote,
}: {
  onGenerated: () => void;
  disabled: boolean;
  lockedNote?: string;
}) {
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
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Tell the AI what to do" className="animate-fade-up">
      <form
        onSubmit={submit}
        className="rounded-lg p-5 flex-shrink-0"
        style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      >
        <label className="block text-sm">
          <span className="text-lg font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>
            Tell the AI what to do
          </span>
          <span className="block text-xs mt-0.5 mb-3" style={{ color: 'var(--muted-foreground)' }}>
            Describe the outcome in plain language — the AI breaks it into tasks, does the work, and pauses for your approval before anything changes.
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
        {disabled && lockedNote && (
          <p className="text-xs mt-2" style={{ color: 'var(--muted-foreground)' }}>
            {lockedNote}
          </p>
        )}
        {error && <p role="alert" className="text-sm mt-2" style={{ color: 'var(--danger)' }}>{error}</p>}
        {confirmation && (
          <p role="status" className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
            {confirmation}{' '}
            <Link to="/board" className="underline font-medium" style={{ color: 'var(--accent)' }}>
              View on the board →
            </Link>
          </p>
        )}
      </form>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Needs your approval: inline two-step approve / reject               */
/* ------------------------------------------------------------------ */

function ApprovalRow({
  item,
  detail,
  classification,
  onChanged,
}: {
  item: SytelineTaskListItem;
  detail: HomeTaskDetail | null;
  classification: Parameters<typeof approveSytelineTask>[0];
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<Confirming>('none');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const act = async (kind: 'approve' | 'reject') => {
    setBusy(true);
    setError('');
    try {
      if (kind === 'approve') {
        await approveSytelineTask(classification, item._id);
      } else {
        await cancelSytelineTask(classification, item._id, true);
      }
      onChanged();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
      setConfirming('none');
    }
  };

  return (
    <div
      className="rounded-lg p-4"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--foreground)' }}>
            {item.title}
          </h3>
          <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
            Waiting {relativeTime(item.updatedAt)}
            {detail?.blockedReason && detail.blockedReason !== 'awaiting-write-approval'
              ? ` · ${detail.blockedReason}`
              : ''}
          </p>
        </div>
        <Link
          to={`/tasks/${item._id}?tab=approvals`}
          className="flex-shrink-0 text-xs font-medium whitespace-nowrap"
          style={{ color: 'var(--accent)' }}
        >
          Review →
        </Link>
      </div>
      <div className="mt-3">
        {confirming === 'none' ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" size="sm" onClick={() => setConfirming('approve')}>
              Approve
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirming('reject')}>
              Reject
            </Button>
          </div>
        ) : (
          <span className="inline-flex items-center gap-2 flex-wrap" role="group" aria-label={`Confirm ${confirming}`}>
            <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              {confirming === 'approve'
                ? 'Approve this write plan and hand it back to the runner?'
                : 'Reject and cancel this task?'}
            </span>
            <Button
              variant={confirming === 'approve' ? 'primary' : 'danger'}
              size="sm"
              disabled={busy}
              onClick={() => void act(confirming)}
            >
              {busy ? 'Working…' : confirming === 'approve' ? 'Yes, approve' : 'Yes, reject'}
            </Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming('none')}>
              Keep
            </Button>
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="text-xs mt-2" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Running row: badge + progress + live dot                             */
/* ------------------------------------------------------------------ */

function RunningRow({ item, detail }: { item: SytelineTaskListItem; detail: HomeTaskDetail | null }) {
  const display = taskDisplayStatus({ status: item.status, blockedReason: detail?.blockedReason });
  const progress = detail?.steps ? taskProgress({ steps: detail.steps }) : null;
  return (
    <Link
      to={`/tasks/${item._id}`}
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
        <span className="flex-shrink-0 inline-flex items-center gap-2">
          {display.status === 'running' && <LiveDot label="live" />}
          <TaskStatusBadge status={display.status} label={display.label} />
        </span>
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
              background: 'var(--accent)',
            }}
          />
        </div>
      )}
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Attention row: title + blocked-reason snippet, links to review       */
/* ------------------------------------------------------------------ */

function AttentionRow({ item, detail }: { item: SytelineTaskListItem; detail: HomeTaskDetail | null }) {
  const display = taskDisplayStatus({ status: item.status, blockedReason: detail?.blockedReason });
  const reason = detail?.blockedReason ?? display.reason;
  return (
    <Link
      to={`/tasks/${item._id}?tab=review`}
      className="block rounded-lg p-4 hover:shadow-sm transition-shadow"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      aria-label={`${item.title} — ${display.label}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold truncate" style={{ color: 'var(--foreground)' }}>
            {item.title}
          </h3>
          {reason && (
            <p className="text-xs mt-0.5 truncate" style={{ color: 'var(--muted-foreground)' }}>
              {reason}
            </p>
          )}
        </div>
        <TaskStatusBadge status={display.status} label={display.label} />
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Completed row: title + when, links to review                        */
/* ------------------------------------------------------------------ */

function CompletedRow({ item }: { item: SytelineTaskListItem }) {
  return (
    <Link
      to={`/tasks/${item._id}?tab=review`}
      className="block rounded-lg px-4 py-3 hover:shadow-sm transition-shadow"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
      aria-label={`${item.title} — completed`}
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>
          {item.title}
        </h3>
        <span className="flex-shrink-0 text-xs whitespace-nowrap" style={{ color: 'var(--muted-foreground)' }}>
          {relativeTime(item.completedAt ?? item.updatedAt)}
        </span>
      </div>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Conversation strip                                                  */
/* ------------------------------------------------------------------ */

interface RecentConversation {
  id: string;
  title: string;
  updatedAt: string;
}

function JumpBackIn({ conversations }: { conversations: RecentConversation[] }) {
  return (
    <section aria-label="Jump back in" className="mt-8 animate-fade-up">
      <SectionLabel>Jump back in</SectionLabel>
      <div className="mt-3 grid gap-2 sm:grid-cols-3">
        {conversations.length === 0 ? (
          <div
            className="rounded-lg p-4 sm:col-span-3 text-center"
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
          >
            <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              No conversations yet —{' '}
              <Link to="/chat" className="underline font-medium" style={{ color: 'var(--accent)' }}>
                start one in Chat
              </Link>
              .
            </p>
          </div>
        ) : (
          conversations.map((conversation) => (
            <Link
              key={conversation.id}
              to={`/chat?conversation=${encodeURIComponent(conversation.id)}`}
              className="block rounded-lg p-4 hover:shadow-sm transition-shadow"
              style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
              aria-label={`Open conversation: ${conversation.title}`}
            >
              <h3 className="text-sm font-medium truncate" style={{ color: 'var(--foreground)' }}>
                {conversation.title || 'Untitled conversation'}
              </h3>
              <p className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                {relativeTime(conversation.updatedAt)}
              </p>
            </Link>
          ))
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* View                                                                */
/* ------------------------------------------------------------------ */

export default function HomeView() {
  const { user } = useAuth();
  const [items, setItems] = useState<SytelineTaskListItem[] | null>(null);
  const [details, setDetails] = useState<Record<string, HomeTaskDetail>>({});
  const [conversations, setConversations] = useState<RecentConversation[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uiDisabled, setUiDisabled] = useState(false);

  const canUseTasks = hasAnyPermission(user?.permissions ?? [], ['syteline:ui']);
  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  const refresh = useCallback(async () => {
    try {
      const [tasks, conversationResponse] = await Promise.all([
        canUseTasks ? listSytelineTasks(classification) : Promise.resolve([]),
        api.request<{ conversations: Array<{ id: string; title: string; updated_at: string }> }>(
          '/conversations',
        ),
      ]);
      setItems(tasks);
      setError(null);
      setConversations(
        (conversationResponse.conversations ?? [])
          .slice()
          .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
          .slice(0, 3)
          .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updated_at })),
      );
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
        const next: Record<string, HomeTaskDetail> = {};
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
        setError(errorMessage(err));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classification, canUseTasks]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  usePolling(refresh, { intervalMs: 15000, active: !uiDisabled });

  const tasksAvailable = canUseTasks && !uiDisabled;
  const sections = groupTasksForHome(items ?? [], details);
  const completedShown = sections.completedToday.slice(0, 8);
  const loading = items === null && !error && !uiDisabled;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <PageHeader
          title="Command center"
          description="The agent loop at a glance: tell Enflite what to do, watch it work, review the results, approve the moments that matter."
        />

        <div className="mt-6">
          <GenerateHero
            onGenerated={() => void refresh()}
            disabled={!tasksAvailable}
            lockedNote={
              !canUseTasks
                ? 'Task creation is locked — it needs the syteline:ui permission.'
                : uiDisabled
                  ? 'Task creation is unavailable — the SyteLine task system is switched off on the backend.'
                  : undefined
            }
          />
        </div>

        {error && (
          <div className="mt-6">
            <ErrorState message={error} onRetry={() => void refresh()} />
          </div>
        )}

        {!canUseTasks && !loading && (
          <div className="mt-6">
            <NotAuthorizedState product="SyteLine task agents" />
          </div>
        )}

        {uiDisabled && (
          <div className="mt-6">
            <DisabledState
              product="SyteLine task agents"
              hint="The backend kill-switch SYTELINE_UI_ENABLED is off, so the task system isn't available. Ask your admin to enable it."
            />
          </div>
        )}

        {loading && (
          <div className="mt-8 space-y-2" aria-label="Loading tasks">
            <Skeleton height="4.5rem" />
            <Skeleton height="4.5rem" />
            <Skeleton height="4.5rem" />
          </div>
        )}

        {tasksAvailable && items !== null && (
          <>
            <section aria-label="Needs your approval" className="mt-8 animate-fade-up">
              <SectionLabel>
                Needs your approval
                {sections.approvals.length > 0 && (
                  <span className="ml-2 font-normal" style={{ color: 'var(--muted-foreground)' }}>
                    {sections.approvals.length}
                  </span>
                )}
              </SectionLabel>
              {sections.approvals.length === 0 ? (
                <p className="text-sm mt-2" style={{ color: 'var(--muted-foreground)' }}>
                  Nothing waiting — approvals land here when an agent pauses for a decision.
                </p>
              ) : (
                <div className="mt-3 space-y-2">
                  {sections.approvals
                    .slice()
                    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
                    .map((item) => (
                      <ApprovalRow
                        key={item._id}
                        item={item}
                        detail={details[item._id] ?? null}
                        classification={classification}
                        onChanged={() => void refresh()}
                      />
                    ))}
                </div>
              )}
            </section>

            {sections.running.length > 0 && (
              <section aria-label="Running now" className="mt-8 animate-fade-up">
                <SectionLabel>
                  Running now
                  <span className="ml-2 font-normal" style={{ color: 'var(--muted-foreground)' }}>
                    {sections.running.length}
                  </span>
                </SectionLabel>
                <div className="mt-3 space-y-2">
                  {sections.running.map((item) => (
                    <RunningRow key={item._id} item={item} detail={details[item._id] ?? null} />
                  ))}
                </div>
              </section>
            )}

            {sections.attention.length > 0 && (
              <section aria-label="Needs attention" className="mt-8 animate-fade-up">
                <SectionLabel>
                  Needs attention
                  <span className="ml-2 font-normal" style={{ color: 'var(--muted-foreground)' }}>
                    {sections.attention.length}
                  </span>
                </SectionLabel>
                <div className="mt-3 space-y-2">
                  {sections.attention.map((item) => (
                    <AttentionRow key={item._id} item={item} detail={details[item._id] ?? null} />
                  ))}
                </div>
              </section>
            )}

            {completedShown.length > 0 && (
              <section aria-label="Completed today" className="mt-8 animate-fade-up">
                <SectionLabel>Completed today</SectionLabel>
                <div className="mt-3 space-y-2">
                  {completedShown.map((item) => (
                    <CompletedRow key={item._id} item={item} />
                  ))}
                </div>
                <Link
                  to="/board"
                  className="inline-block mt-3 text-sm font-medium"
                  style={{ color: 'var(--accent)' }}
                >
                  View all on the board →
                </Link>
              </section>
            )}
          </>
        )}

        <JumpBackIn conversations={conversations} />
      </div>
    </div>
  );
}
