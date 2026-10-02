/**
 * agents/components/PlanSteps.tsx — the task plan as a step timeline.
 *
 * Relay-style activity rows: an icon per step action, the friendly
 * description, status in words, timestamps, the runner's output in a
 * terminal card (from real `TaskStepLog.observation`), the error code when
 * the backend reported one, and screenshot evidence. This doubles as the
 * live activity view: the parent polls the task and this list updates as
 * steps run. The latest row is highlighted.
 */
import type { TaskStepLog } from '../api';
import {
  describePlanStep,
  planActionOf,
  stepDisplayStatus,
} from '../types';
import { STEP_LABEL, StepStatusGlyph } from './StatusGlyph';
import { fullTime, relativeTime } from '../../board/types';
import { Icon, type IconName } from '../../components/icons';
import EvidenceImage from './EvidenceImage';

function StepTiming({ step }: { step: TaskStepLog }) {
  if (!step.startedAt && !step.completedAt) return null;
  const parts: string[] = [];
  if (step.startedAt) parts.push(`started ${fullTime(step.startedAt)}`);
  if (step.completedAt) parts.push(`finished ${fullTime(step.completedAt)}`);
  return (
    <p className="text-xs mt-1" style={{ color: 'var(--muted-foreground)' }}>
      {parts.join(' · ')}
    </p>
  );
}

/** Icon per step action — shape reinforces the status text, never color alone. */
function actionIcon(action: string | undefined): IconName {
  switch (action) {
    case 'readScreen':
      return 'search';
    case 'assertText':
      return 'check';
    case 'fillField':
    case 'clickButton':
      return 'edit';
    case 'gotoForm':
      return 'layout';
    default:
      return 'activity';
  }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Terminal-style card for a step's real output (`TaskStepLog.observation`).
 * The header names the step it came from; the body is the runner's own
 * words, monospaced, truncated so one chatty step can't blow out the page.
 */
function StepTerminalCard({ command, output }: { command: string; output: string }) {
  return (
    <div
      className="mt-2.5 rounded-lg overflow-hidden"
      style={{ border: '1px solid var(--border)', borderRadius: 10 }}
      aria-label={`Step output: ${command}`}
    >
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ background: 'var(--secondary)', borderBottom: '1px solid var(--border)' }}
      >
        <span aria-hidden="true" className="inline-flex gap-1.5">
          <i className="w-2 h-2 rounded-full inline-block" style={{ background: '#f87171' }} />
          <i className="w-2 h-2 rounded-full inline-block" style={{ background: '#fbbf24' }} />
          <i className="w-2 h-2 rounded-full inline-block" style={{ background: '#34d399' }} />
        </span>
        <span aria-hidden="true" className="inline-flex" style={{ color: 'var(--muted-foreground)' }}>
          <Icon name="terminal" size={13} />
        </span>
        <span
          className="text-xs truncate"
          style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
        >
          {command}
        </span>
      </div>
      <pre
        className="px-3 py-2.5 text-xs whitespace-pre-wrap break-words overflow-y-auto"
        style={{
          color: 'var(--foreground)',
          fontFamily: 'var(--font-mono)',
          background: 'var(--card)',
          maxHeight: '12rem',
          margin: 0,
        }}
      >
        {truncate(output, 1200)}
      </pre>
    </div>
  );
}

export default function PlanSteps({
  taskId,
  plan,
  steps,
}: {
  taskId: string;
  plan: unknown[];
  steps: TaskStepLog[];
}) {
  if (steps.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
        No plan yet — the agent drafts its plan when the run starts.
      </p>
    );
  }
  // Highlight the freshest row: the latest step that actually ran. Pending
  // steps the agent hasn't reached yet stay quiet — if nothing has run,
  // nothing is highlighted.
  let latestIndex = -1;
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    if (steps[i].status !== 'pending') {
      latestIndex = i;
      break;
    }
  }
  return (
    <ol className="flex flex-col gap-1">
      {steps.map((step, index) => {
        const action = planActionOf(plan, index);
        const display = stepDisplayStatus(step, action);
        const latest = index === latestIndex;
        const description = describePlanStep(plan[index]);
        const when = step.completedAt ?? step.startedAt;
        return (
          <li
            key={index}
            className={latest ? 'animate-fade-up' : undefined}
            aria-label={`Step ${index + 1}: ${description} — ${STEP_LABEL[display]}`}
            style={{
              borderRadius: 10,
              padding: '10px 12px',
              background: latest ? 'var(--card)' : 'transparent',
              border: '1px solid',
              borderColor: latest ? 'var(--border)' : 'transparent',
            }}
          >
            <div className="flex gap-3">
              <span
                aria-hidden="true"
                className="flex-shrink-0 w-7 h-7 grid place-items-center rounded-full"
                style={{
                  border: '1px solid var(--border)',
                  background: 'var(--secondary)',
                  color: 'var(--muted-foreground)',
                }}
              >
                <Icon name={actionIcon(action)} size={14} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <strong className="text-sm" style={{ color: 'var(--foreground)' }}>
                    {description}
                  </strong>
                  <StepStatusGlyph status={display} label={STEP_LABEL[display]} />
                  {when && (
                    <time className="text-xs ml-auto" style={{ color: 'var(--muted-foreground)' }} dateTime={when}>
                      {relativeTime(when)}
                    </time>
                  )}
                </div>
                {step.detail && (
                  <p
                    className="text-xs mt-1 break-words"
                    style={{ color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)' }}
                  >
                    {step.detail}
                  </p>
                )}
                <StepTiming step={step} />
                {step.observation && (
                  <StepTerminalCard command={description} output={step.observation} />
                )}
                {(step.errorCode || step.evidenceIds.length > 0) && (
                  <div className="flex flex-wrap items-center gap-2 mt-2">
                    {step.errorCode && (
                      <span
                        className="text-xs font-mono px-2 py-0.5 rounded"
                        style={{ background: 'var(--danger-bg)', color: 'var(--danger)' }}
                      >
                        {step.errorCode}
                      </span>
                    )}
                    {step.evidenceIds.map((evidenceId) => (
                      <EvidenceImage
                        key={evidenceId}
                        taskId={taskId}
                        evidenceId={evidenceId}
                        label={`Screenshot evidence for step ${index + 1}`}
                      />
                    ))}
                  </div>
                )}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
