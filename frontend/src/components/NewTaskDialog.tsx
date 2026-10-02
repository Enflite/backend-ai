/**
 * components/NewTaskDialog.tsx — the global "New agent task" dialog.
 *
 * Relay's "What should we build?" dialog, rewritten for our data: the
 * reference dialog's repo picker was static, ours binds to the two real
 * pipelines — SyteLine task agents and the Form customization pipeline.
 * No fake targets, no AI-sounding copy the product can't back up; the
 * suggestion chips are plain shortcuts that fill the textarea.
 *
 * Mounted once by shell/AppShell (via the NewTaskDialogContext), opened
 * from the workspace sidebar, the board, the command palette, chat, and
 * the task workspace. Replaces agents/views/NewTaskView.tsx.
 */
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth';
import { ApiError } from '../api';
import { createSytelineTask, toolClassificationFor } from '../agents/api';
import { Icon, type IconName } from './icons';
import { IconButton } from './ui/primitives';

export type NewTaskTargetId = 'syteline' | 'forms';

export interface NewTaskTarget {
  id: NewTaskTargetId;
  label: string;
  description: string;
  icon: IconName;
  /** Permission that unlocks this pipeline. */
  permission: string;
}

/** The only two creation pipelines — nothing here is a mock or a stub. */
export const TASK_TARGETS: NewTaskTarget[] = [
  {
    id: 'syteline',
    label: 'SyteLine task',
    description: 'The agent drives SyteLine as you — investigate, update, validate.',
    icon: 'activity',
    permission: 'syteline:ui',
  },
  {
    id: 'forms',
    label: 'Form customization',
    description: 'Draft a form change through the governed pipeline — review the PR on GitHub.',
    icon: 'file',
    permission: 'syteline:forms',
  },
];

/**
 * Static starter prompts. Honest SyteLine-flavored shortcuts — they fill the
 * textarea, they are not fake AI suggestions.
 */
export const SUGGESTED_PROMPTS: string[] = [
  'Check why a sales order is late',
  'Bring TRN purchase orders up to date',
  'Validate the vendor master list',
  "Summarize today's blocked tasks",
];

/** First target the user is allowed to use, falling back to SyteLine. */
export function defaultTargetId(permissions: string[]): NewTaskTargetId {
  const allowed = TASK_TARGETS.find((target) => permissions.includes(target.permission));
  return allowed?.id ?? 'syteline';
}

/** Whether the Start-task button may fire for the SyteLine pipeline. */
export function canStartSytelineTask(args: {
  title: string;
  goal: string;
  busy: boolean;
  hasPermission: boolean;
}): boolean {
  return (
    args.title.trim().length > 0 &&
    args.goal.trim().length > 0 &&
    !args.busy &&
    args.hasPermission
  );
}

export interface NewTaskDialogOptions {
  /** Conversation whose completion report links back to it. */
  conversationId?: string;
}

export default function NewTaskDialog({
  open,
  onClose,
  linkedConversationId,
}: {
  open: boolean;
  onClose: () => void;
  linkedConversationId?: string;
}) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const goalRef = useRef<HTMLTextAreaElement>(null);

  const [target, setTarget] = useState<NewTaskTargetId>('syteline');
  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [autoApproveWrites, setAutoApproveWrites] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const permissions = user?.permissions ?? [];
  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');

  // Fresh state on every open; default to the first pipeline the user can use.
  useEffect(() => {
    if (open) {
      setTarget(defaultTargetId(permissions));
      setTitle('');
      setGoal('');
      setAutoApproveWrites(false);
      setBusy(false);
      setError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open ]);

  // Esc closes. Backdrop mousedown closes (handled on the backdrop node).
  useEffect(() => {
    if (!open) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    goalRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const sytelineTarget = TASK_TARGETS[0];
  const formsTarget = TASK_TARGETS[1];
  const canUseSyteline = permissions.includes(sytelineTarget.permission);
  const canUseForms = permissions.includes(formsTarget.permission);
  const canSubmit = canStartSytelineTask({ title, goal, busy, hasPermission: canUseSyteline });

  function submitSyteline(event: FormEvent) {
    event.preventDefault();
    void (async () => {
      if (!canSubmit) return;
      setBusy(true);
      setError(null);
      try {
        const task = await createSytelineTask(classification, {
          title: title.trim(),
          goal: goal.trim(),
          autoApproveWrites,
          ...(linkedConversationId ? { conversationId: linkedConversationId } : {}),
        });
        onClose();
        navigate(`/tasks/${task._id}`);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? err.code === 'SYTELINE_UI_DISABLED'
              ? 'Task agents are disabled on this backend (SYTELINE_UI_ENABLED=false).'
              : err.message
            : 'Could not create the task. Try again.',
        );
        setBusy(false);
      }
    })();
  }

  function continueToForms() {
    if (!canUseForms) return;
    onClose();
    navigate('/forms/new');
  }

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center p-5 overflow-y-auto"
      style={{ background: 'rgba(4,6,5,0.72)', backdropFilter: 'blur(10px)' }}
      onMouseDown={onClose}
    >
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-task-dialog-title"
        onSubmit={submitSyteline}
        onMouseDown={(event) => event.stopPropagation()}
        className="w-full my-auto animate-scale-in"
        style={{
          maxWidth: '600px',
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: '16px',
          boxShadow: 'var(--shadow-lg)',
          padding: '24px',
        }}
      >
        <div className="flex items-start justify-between gap-3" style={{ marginBottom: '20px' }}>
          <div>
            <span
              className="inline-flex items-center gap-1.5 uppercase font-bold"
              style={{ color: 'var(--accent)', letterSpacing: '0.1em', fontSize: '11px' }}
            >
              <Icon name="spark" size={13} />
              New agent task
            </span>
            <h2
              id="new-task-dialog-title"
              className="font-medium"
              style={{ marginTop: '8px', fontSize: '22px', letterSpacing: '-0.02em', color: 'var(--foreground)' }}
            >
              What should the agent do?
            </h2>
          </div>
          <IconButton label="Close new task dialog" onClick={onClose}>
            <Icon name="x" size={14} />
          </IconButton>
        </div>

        <label
          htmlFor="new-task-goal"
          className="block text-sm font-medium"
          style={{ color: 'var(--foreground)' }}
        >
          {target === 'syteline' ? 'What should the agent accomplish?' : 'What should change on the form?'}
        </label>
        <textarea
          id="new-task-goal"
          ref={goalRef}
          value={goal}
          onChange={(event) => setGoal(event.target.value)}
          placeholder="Describe an outcome, not a list of steps…"
          rows={4}
          maxLength={2000}
          className="mt-1.5 w-full text-sm rounded-md px-3 py-2.5 resize-none"
          style={{
            border: '1px solid var(--border)',
            background: 'var(--background)',
            color: 'var(--foreground)',
          }}
        />

        <div className="flex flex-wrap gap-1.5" style={{ margin: '10px 0 20px' }} aria-label="Suggested prompts">
          {SUGGESTED_PROMPTS.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              onClick={() => {
                setGoal(suggestion);
                goalRef.current?.focus();
              }}
              className="text-xs rounded-full px-2.5 py-1.5"
              style={{
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--muted-foreground)',
              }}
            >
              {suggestion}
            </button>
          ))}
        </div>

        <div className="grid gap-2 sm:grid-cols-2" role="group" aria-label="Task target" style={{ marginBottom: '20px' }}>
          {[sytelineTarget, formsTarget].map((candidate) => {
            const locked = !permissions.includes(candidate.permission);
            const selected = target === candidate.id;
            return (
              <button
                key={candidate.id}
                type="button"
                disabled={locked}
                onClick={() => setTarget(candidate.id)}
                aria-pressed={selected}
                className="text-left rounded-lg p-3.5 disabled:cursor-not-allowed"
                style={{
                  border: `1px solid ${selected && !locked ? 'var(--accent)' : 'var(--border)'}`,
                  background: selected && !locked ? 'var(--secondary)' : 'transparent',
                  opacity: locked ? 0.6 : 1,
                }}
              >
                <span className="flex items-center gap-2">
                  <span style={{ color: locked ? 'var(--muted-foreground)' : 'var(--accent)' }}>
                    <Icon name={locked ? 'lock' : candidate.icon} size={15} />
                  </span>
                  <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
                    {candidate.label}
                  </span>
                </span>
                <span className="block text-xs mt-1 leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
                  {locked
                    ? `Requires the ${candidate.permission} permission.`
                    : candidate.description}
                </span>
              </button>
            );
          })}
        </div>

        {target === 'syteline' && (
          <div className="space-y-3" style={{ marginBottom: '20px' }}>
            <label className="block">
              <span className="block text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                Task title
              </span>
              <input
                type="text"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="e.g. Check why order 12345 is late"
                maxLength={120}
                className="mt-1.5 w-full text-sm rounded-md px-3 py-2.5"
                style={{
                  border: '1px solid var(--border)',
                  background: 'var(--background)',
                  color: 'var(--foreground)',
                }}
              />
            </label>
            <label
              className="flex items-start gap-2.5 rounded-md p-3 cursor-pointer"
              style={{ border: '1px solid var(--border)' }}
            >
              <input
                type="checkbox"
                checked={autoApproveWrites}
                onChange={(event) => setAutoApproveWrites(event.target.checked)}
                className="mt-1"
              />
              <span>
                <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                  Allow the AI to make changes
                </span>
                <span className="block text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                  Your explicit confirmation for this task's write steps only — bounded to this
                  task, recorded, and auditable. When off, the agent only investigates and waits
                  for your approval before anything is written.
                </span>
              </span>
            </label>
            {linkedConversationId && (
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Linked conversation:{' '}
                <span className="font-mono">{linkedConversationId}</span> — the completion
                report will be posted there.
              </p>
            )}
          </div>
        )}

        {target === 'forms' && (
          <p className="text-sm leading-relaxed" style={{ color: 'var(--muted-foreground)', marginBottom: '20px' }}>
            The form pipeline drafts the customization from your description and opens a GitHub
            pull request for human review — nothing merges without approval.
          </p>
        )}

        {error && (
          <p className="text-sm" style={{ color: 'var(--danger)', marginBottom: '12px' }} role="alert">
            {error}
          </p>
        )}

        <div className="flex items-center justify-end">
          {target === 'syteline' ? (
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
            >
              {busy ? 'Starting…' : 'Start task'}
              <span aria-hidden="true">→</span>
            </button>
          ) : (
            <button
              type="button"
              disabled={!canUseForms}
              onClick={continueToForms}
              className="inline-flex items-center gap-2 text-sm font-semibold px-4 py-2.5 rounded-lg disabled:opacity-40 disabled:cursor-not-allowed"
              style={{ background: 'var(--accent)', color: 'var(--accent-foreground)' }}
            >
              Continue
              <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
