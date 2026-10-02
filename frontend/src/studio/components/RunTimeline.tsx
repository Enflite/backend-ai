/**
 * studio/components/RunTimeline.tsx — per-step run timeline.
 *
 * The style guide's activity-timeline register: 29px icon cells on a 1px
 * vertical connector, hairline icon borders, 10.5px/600 labels + mono
 * timestamps + 10px muted detail rows. Used by the run detail view.
 */
import type { StudioRunStepResult } from '../types';
import { stepKindLabel } from '../builder';
import { IconAlert, IconCheck, IconClock } from './StudioIcons';

function statusDot(status: string): { color: string; glow: boolean } {
  const s = status.toLowerCase();
  if (s === 'ok') return { color: '#6ee7a1', glow: false };
  if (s === 'running') return { color: '#d997ff', glow: true };
  if (s === 'skipped') return { color: '#d9aa68', glow: false };
  return { color: '#d28279', glow: false };
}

function formatTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function RunTimeline({ steps }: { steps: StudioRunStepResult[] }) {
  if (steps.length === 0) {
    return (
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        This run recorded no step results.
      </p>
    );
  }
  return (
    <ol className="relative" aria-label="Run steps">
      {steps.map((step, i) => {
        const { color, glow } = statusDot(step.status);
        const isLast = i === steps.length - 1;
        return (
          <li key={step.stepId} className="relative flex gap-3 pb-5" style={{ paddingBottom: isLast ? 0 : 20 }}>
            {/* Icon cell + vertical connector */}
            <div className="relative flex flex-col items-center flex-shrink-0" aria-hidden="true">
              <span
                className="inline-flex items-center justify-center"
                style={{
                  width: 29,
                  height: 29,
                  borderRadius: 8,
                  border: `1px solid ${isLast ? 'color-mix(in srgb, var(--accent) 45%, transparent)' : 'var(--border)'}`,
                  background: isLast ? '#cf0c2c14' : 'var(--card)',
                  color: isLast ? 'var(--accent)' : color,
                }}
              >
                {step.status.toLowerCase() === 'ok' ? (
                  <IconCheck size={14} />
                ) : step.status.toLowerCase() === 'failed' ? (
                  <IconAlert size={14} />
                ) : (
                  <IconClock size={14} />
                )}
              </span>
              {!isLast && (
                <span
                  className="absolute top-[29px] bottom-[-20px]"
                  style={{ width: 1, background: 'var(--border)' }}
                />
              )}
            </div>
            <div className="min-w-0 flex-1 pt-1">
              <div className="flex items-baseline justify-between gap-3">
                <p className="font-semibold truncate" style={{ fontSize: '10.5px', color: 'var(--foreground)', fontWeight: 600 }}>
                  {step.name ?? `Step ${i + 1}`}
                  {step.kind && (
                    <span className="ml-2 font-mono font-bold uppercase" style={{ fontSize: 9, color: 'var(--muted-foreground)', letterSpacing: '0.08em' }}>
                      {stepKindLabel(step.kind)}
                    </span>
                  )}
                </p>
                <span className="font-mono flex-shrink-0" style={{ fontSize: '10px', color: 'var(--muted-foreground)' }}>
                  {formatTime(step.startedAt)}
                </span>
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <span aria-hidden="true" className={`studio-dot ${glow ? 'studio-dot-running' : ''}`} style={{ background: color }} />
                <span className="text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                  {step.status}
                  {typeof step.durationMs === 'number' && (
                    <span className="font-mono"> · {step.durationMs}ms</span>
                  )}
                  {step.finishedAt && (
                    <span className="font-mono"> · ended {formatTime(step.finishedAt)}</span>
                  )}
                </span>
              </div>
              {step.error && (
                <p className="mt-1 text-[10px]" style={{ color: '#d28279', lineHeight: 1.5 }}>
                  {step.error}
                </p>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
