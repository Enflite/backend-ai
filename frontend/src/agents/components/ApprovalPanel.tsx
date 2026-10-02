/**
 * agents/components/ApprovalPanel.tsx — human approval for write steps.
 *
 * Shown when a task parks as blocked/awaiting-write-approval: the agent ran
 * its read-only checks and proposed a write plan. The human reviews what was
 * verified and what is proposed, then approves (resumes the run) or rejects
 * (cancels the task).
 *
 * When the backend does not provide `syteline.task.approve` yet, the panel
 * says so honestly instead of faking an approval.
 */
import { useState } from 'react';
import type { SytelineTaskDetail } from '../api';
import { approveSytelineTask, cancelSytelineTask, isNotWiredError, toolClassificationFor } from '../api';
import { parseProposedPlan, splitReconVsProposed } from '../types';
import { ApiError } from '../../api';
import type { DataClassification } from '../../types';

export default function ApprovalPanel({
  task,
  clearance,
  onChanged,
}: {
  task: SytelineTaskDetail;
  clearance: DataClassification;
  onChanged: () => void;
}) {
  const [confirming, setConfirming] = useState<'approve' | 'reject' | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notWired, setNotWired] = useState(false);

  const { completed, proposed } = splitReconVsProposed(task);
  const proposedLines = parseProposedPlan(task.resultSummary);
  const classification = toolClassificationFor(clearance);

  async function doApprove() {
    setBusy(true);
    setError(null);
    try {
      const result = await approveSytelineTask(classification, task._id, true);
      if (!result.approved) {
        setError(
          result.reason === 'not-awaiting-approval'
            ? 'This task is no longer waiting for approval — its state changed.'
            : 'Approval did not go through. The task state may have changed.',
        );
      } else {
        onChanged();
      }
    } catch (err) {
      if (isNotWiredError(err)) {
        setNotWired(true);
      } else {
        setError(err instanceof ApiError ? err.message : 'Approval failed. Try again.');
      }
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  async function doReject() {
    setBusy(true);
    setError(null);
    try {
      await cancelSytelineTask(classification, task._id, true);
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not cancel the task. Try again.');
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  }

  return (
    <section
      className="rounded-lg p-4"
      style={{ background: '#fffbeb', border: '1px solid #fcd34d' }}
      aria-label="Approval required"
    >
      <h2 className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>
        ⚠ Approval required
      </h2>
      <p className="text-sm mt-1" style={{ color: 'var(--muted-foreground)' }}>
        The agent finished its read-only checks. Nothing has been changed in SyteLine yet —
        the steps below need your approval before the agent continues.
      </p>

      {completed.length > 0 && (
        <div className="mt-3">
          <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
            Verified by read-only checks ({completed.length})
          </h3>
          <ul className="mt-1.5 space-y-1">
            {completed.map((step, i) => (
              <li key={i} className="text-sm" style={{ color: 'var(--foreground)' }}>
                <span aria-hidden="true">✓ </span>
                {step.action}
                {step.detail ? <span style={{ color: 'var(--muted-foreground)' }}> — {step.detail}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="mt-3">
        <h3 className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--muted-foreground)' }}>
          Proposed changes ({proposed.length})
        </h3>
        {proposedLines ? (
          <ol className="mt-1.5 space-y-1">
            {proposedLines.map((line, i) => (
              <li key={i} className="text-sm font-mono" style={{ color: 'var(--foreground)' }}>
                {line}
              </li>
            ))}
          </ol>
        ) : (
          <ul className="mt-1.5 space-y-1">
            {proposed.map((step) => (
              <li key={step.index} className="text-sm" style={{ color: 'var(--foreground)' }}>
                <span aria-hidden="true">○ </span>
                Step {step.index + 1}: {step.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      {notWired ? (
        <p className="text-sm mt-3 rounded p-2" style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }} role="status">
          Awaiting tool integration — this backend doesn't provide task approval yet
          (<span className="font-mono">syteline.task.approve</span>), so the proposed changes
          can't be approved from here. The proposal above is exactly what the agent recorded.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {confirming === null && (
            <>
              <button
                type="button"
                onClick={() => setConfirming('approve')}
                disabled={busy}
                className="text-sm font-medium px-4 py-2 rounded-md"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                Approve &amp; continue
              </button>
              <button
                type="button"
                onClick={() => setConfirming('reject')}
                disabled={busy}
                className="text-sm px-4 py-2 rounded-md"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
              >
                Reject
              </button>
            </>
          )}
          {confirming === 'approve' && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm approval">
              <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                Approve these {proposed.length} change{proposed.length === 1 ? '' : 's'}? The agent will
                run them as you in SyteLine.
              </span>
              <button
                type="button"
                onClick={() => void doApprove()}
                disabled={busy}
                className="text-sm font-medium px-4 py-2 rounded-md"
                style={{ background: 'var(--accent)', color: '#fff' }}
              >
                {busy ? 'Approving…' : 'Yes, approve'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="text-sm px-3 py-2 rounded-md"
                style={{ border: '1px solid var(--border)' }}
              >
                Back
              </button>
            </div>
          )}
          {confirming === 'reject' && (
            <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Confirm rejection">
              <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>
                Reject the proposed changes and cancel this task?
              </span>
              <button
                type="button"
                onClick={() => void doReject()}
                disabled={busy}
                className="text-sm font-medium px-4 py-2 rounded-md"
                style={{ background: '#a50a24', color: '#fff' }}
              >
                {busy ? 'Cancelling…' : 'Yes, reject & cancel'}
              </button>
              <button
                type="button"
                onClick={() => setConfirming(null)}
                disabled={busy}
                className="text-sm px-3 py-2 rounded-md"
                style={{ border: '1px solid var(--border)' }}
              >
                Back
              </button>
            </div>
          )}
        </div>
      )}
      {error && (
        <p className="text-sm mt-2" style={{ color: '#a50a24' }} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
