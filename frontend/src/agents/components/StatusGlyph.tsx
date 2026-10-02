/**
 * agents/components/StatusGlyph.tsx — icon + text status indicators.
 *
 * Accessibility rule: state is communicated through icon shape AND text
 * label. Color is decorative reinforcement only.
 */
import type { ReactNode } from 'react';
import Spinner from '../../components/ui/Spinner';
import type { StepDisplayStatus, TaskDisplayStatus } from '../types';

function Icon({ d, label }: { d: string; label: string }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label={label}
    >
      <path d={d} />
    </svg>
  );
}

const CHECK = 'M3 8.5l3.5 3.5L13 4.5';
const CROSS = 'M4 4l8 8M12 4l-8 8';
const DOT_CIRCLE = 'M8 8h.01';
const PAUSE = 'M6 4v8M10 4v8';
const SKIP = 'M3 8h10M8 3l5 5-5 5';
const ALERT = 'M8 2v8M8 13.5h.01';
const CLOCK = 'M8 4v4l3 2';

const TASK_TONE: Record<TaskDisplayStatus, { color: string; bg: string; glyph: ReactNode }> = {
  queued: {
    color: '#6b7280',
    bg: '#6b728014',
    glyph: <Icon d={CLOCK} label="Queued" />,
  },
  running: {
    color: '#1d4ed8',
    bg: '#2563eb14',
    glyph: <Spinner size={13} />,
  },
  waiting_approval: {
    color: '#b45309',
    bg: '#b4530914',
    glyph: <Icon d={ALERT} label="Waiting for approval" />,
  },
  blocked: {
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
    glyph: <Icon d={PAUSE} label="Blocked" />,
  },
  failed: {
    color: 'var(--danger)',
    bg: 'var(--danger-bg)',
    glyph: <Icon d={CROSS} label="Failed" />,
  },
  completed: {
    color: '#15803d',
    bg: '#15803d14',
    glyph: <Icon d={CHECK} label="Completed" />,
  },
  cancelled: {
    color: '#6b7280',
    bg: '#6b728014',
    glyph: <Icon d={SKIP} label="Cancelled" />,
  },
};

const STEP_TONE: Record<StepDisplayStatus, { color: string; glyph: ReactNode }> = {
  pending: { color: 'var(--muted-foreground)', glyph: <Icon d={DOT_CIRCLE} label="Pending" /> },
  running: { color: '#1d4ed8', glyph: <Spinner size={13} /> },
  done: { color: '#15803d', glyph: <Icon d={CHECK} label="Done" /> },
  verified: { color: '#15803d', glyph: <Icon d={CHECK} label="Verified" /> },
  failed: { color: 'var(--danger)', glyph: <Icon d={CROSS} label="Failed" /> },
  skipped: { color: '#9a3412', glyph: <Icon d={SKIP} label="Skipped" /> },
};

export function TaskStatusBadge({ status, label }: { status: TaskDisplayStatus; label: string }) {
  const tone = TASK_TONE[status];
  return (
    <span
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap"
      style={{ color: tone.color, background: tone.bg }}
    >
      {tone.glyph}
      {label}
    </span>
  );
}

export function StepStatusGlyph({ status, label }: { status: StepDisplayStatus; label: string }) {
  const tone = STEP_TONE[status];
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium" style={{ color: tone.color }}>
      {tone.glyph}
      {label}
    </span>
  );
}

export const STEP_LABEL: Record<StepDisplayStatus, string> = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  verified: 'Verified',
  failed: 'Failed',
  skipped: 'Skipped',
};
