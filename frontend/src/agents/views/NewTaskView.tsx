/**
 * agents/views/NewTaskView.tsx — create an agent task (`/agents/tasks/new`).
 *
 * Plain-language goal in, structured task out. The approval-mode choice maps
 * directly onto the backend's write-approval gate: "ask me first" (default)
 * means the agent runs read-only checks, then parks the task for approval
 * before any SyteLine change. Nothing here executes anything.
 */
import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../auth';
import { ApiError } from '../../api';
import { PageHeader } from '../../components/ui/primitives';
import { createSytelineTask, toolClassificationFor } from '../api';

export default function NewTaskView() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const linkedConversation = searchParams.get('conversation') ?? '';

  const [title, setTitle] = useState('');
  const [goal, setGoal] = useState('');
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const classification = toolClassificationFor(user?.clearance ?? 'PUBLIC');
  const canSubmit = title.trim().length > 0 && goal.trim().length > 0 && !busy;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const task = await createSytelineTask(
        classification,
        {
          title: title.trim(),
          goal: goal.trim(),
          autoApproveWrites: autoApprove,
          ...(linkedConversation ? { conversationId: linkedConversation } : {}),
        },
      );
      navigate(`/agents/tasks/${task._id}`);
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
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 py-8">
        <PageHeader
          title="New task"
          description="Describe the work in plain language. The agent drafts a plan, runs read-only checks first, and pauses for your approval before changing anything."
        />
        <form onSubmit={(event) => void submit(event)} className="mt-6 space-y-5">
          <div>
            <label htmlFor="task-title" className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
              Task title
            </label>
            <input
              id="task-title"
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Bring TRN up to the current eTRR build"
              maxLength={120}
              className="mt-1.5 w-full text-sm rounded-md px-3 py-2.5"
              style={{
                border: '1px solid var(--border)',
                background: 'var(--card)',
                color: 'var(--foreground)',
              }}
              autoFocus
            />
          </div>

          <div>
            <label htmlFor="task-goal" className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
              What should the agent accomplish?
            </label>
            <textarea
              id="task-goal"
              value={goal}
              onChange={(event) => setGoal(event.target.value)}
              placeholder="Update the eTRR form metadata on TRN to the current build: set Status length to 40, re-import the IDO properties, verify TrrNum autonumbering, then run the validation checklist."
              rows={6}
              maxLength={2000}
              className="mt-1.5 w-full text-sm rounded-md px-3 py-2.5"
              style={{
                border: '1px solid var(--border)',
                background: 'var(--card)',
                color: 'var(--foreground)',
              }}
            />
            <p className="text-xs mt-1 text-right" style={{ color: 'var(--muted-foreground)' }}>
              {goal.length}/2000
            </p>
          </div>

          <fieldset>
            <legend className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
              Changes in SyteLine
            </legend>
            <div className="mt-2 space-y-2">
              <label
                className="flex items-start gap-3 rounded-md p-3 cursor-pointer"
                style={{ border: '1px solid var(--border)', background: !autoApprove ? 'var(--secondary)' : 'transparent' }}
              >
                <input
                  type="radio"
                  name="approval-mode"
                  checked={!autoApprove}
                  onChange={() => setAutoApprove(false)}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    Ask me before any change <span style={{ color: 'var(--muted-foreground)' }}>(recommended)</span>
                  </span>
                  <span className="block text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                    The agent runs read-only checks, shows you the proposed changes, and waits for
                    your approval. Nothing in SyteLine changes without you.
                  </span>
                </span>
              </label>
              <label
                className="flex items-start gap-3 rounded-md p-3 cursor-pointer"
                style={{ border: '1px solid var(--border)', background: autoApprove ? 'var(--secondary)' : 'transparent' }}
              >
                <input
                  type="radio"
                  name="approval-mode"
                  checked={autoApprove}
                  onChange={() => setAutoApprove(true)}
                  className="mt-1"
                />
                <span>
                  <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                    Allow the agent to make the changes
                  </span>
                  <span className="block text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>
                    Your explicit confirmation for this task's write steps only — bounded to this
                    task, recorded, and auditable. The agent still verifies each step.
                  </span>
                </span>
              </label>
            </div>
          </fieldset>

          {linkedConversation && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Linked conversation: <span className="font-mono">{linkedConversation}</span> — the
              completion report will be posted there.
            </p>
          )}

          {error && (
            <p className="text-sm" style={{ color: '#a50a24' }} role="alert">
              {error}
            </p>
          )}

          <div className="flex items-center gap-3">
            <button
              type="submit"
              disabled={!canSubmit}
              className="text-sm font-medium px-5 py-2.5 rounded-md disabled:opacity-50"
              style={{ background: 'var(--accent)', color: '#fff' }}
            >
              {busy ? 'Creating…' : 'Create task'}
            </button>
            <Link to="/agents/tasks" className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  );
}
