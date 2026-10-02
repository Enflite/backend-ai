/**
 * agents/components/PlanSteps.tsx — the task plan as a step timeline.
 *
 * Each row: status glyph, friendly description, timing, observation excerpt,
 * error code, and screenshot evidence. This doubles as the live activity
 * view: the parent polls the task and this list updates as steps run.
 */
import type { TaskStepLog } from '../api';
import {
  describePlanStep,
  planActionOf,
  stepDisplayStatus,
} from '../types';
import { STEP_LABEL, StepStatusGlyph } from './StatusGlyph';
import { fullTime } from '../../board/types';
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
  return (
    <ol className="space-y-2">
      {steps.map((step, index) => {
        const action = planActionOf(plan, index);
        const display = stepDisplayStatus(step, action);
        const observation =
          step.observation && step.observation.length > 280
            ? `${step.observation.slice(0, 280)}…`
            : step.observation;
        return (
          <li
            key={index}
            className="rounded-lg p-3"
            style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
            aria-label={`Step ${index + 1}: ${STEP_LABEL[display]}`}
          >
            <div className="flex items-center gap-2 flex-wrap">
              <StepStatusGlyph status={display} label={STEP_LABEL[display]} />
              <span className="text-xs font-semibold" style={{ color: 'var(--muted-foreground)' }}>
                Step {index + 1}
              </span>
              <span className="text-sm" style={{ color: 'var(--foreground)' }}>
                {describePlanStep(plan[index])}
              </span>
            </div>
            {step.detail && (
              <p className="text-xs mt-1 font-mono" style={{ color: 'var(--muted-foreground)' }}>
                {step.detail}
              </p>
            )}
            <StepTiming step={step} />
            {observation && (
              <p
                className="text-xs mt-1.5 font-mono whitespace-pre-wrap break-words rounded p-2"
                style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}
              >
                {observation}
              </p>
            )}
            {(step.errorCode || step.evidenceIds.length > 0) && (
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {step.errorCode && (
                  <span
                    className="text-xs font-mono px-2 py-0.5 rounded"
                    style={{ background: '#fee2e2', color: '#a50a24' }}
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
          </li>
        );
      })}
    </ol>
  );
}
