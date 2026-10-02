/**
 * studio/views/RunDetailView.tsx — one automation run with its per-step
 * timeline.
 *
 * Loads GET /api/v1/studio/runs/:id and renders the style guide's
 * activity-timeline register. A 404 is the honest "not available yet"
 * state — no invented timeline.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Badge, Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import { getStudioRun, isStudioUnavailable } from '../api';
import type { StudioRunDetail } from '../types';
import RunTimeline from '../components/RunTimeline';
import StudioEmpty, { IconList, StudioEmptyIcon } from '../components/StudioEmpty';
import { IconAlert } from '../components/StudioIcons';

function statusTone(status: string): 'green' | 'red' | 'gray' {
  const s = status.toLowerCase();
  if (s === 'failed') return 'red';
  if (s === 'ok') return 'green';
  return 'gray';
}

function formatDuration(ms?: number | null): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunDetailView() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<StudioRunDetail | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setUnavailable(false);
    try {
      setRun(await getStudioRun(runId ?? ''));
    } catch (cause) {
      if (isStudioUnavailable(cause)) {
        setUnavailable(true);
        setRun(null);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not load the run.');
      }
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (unavailable) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconList />
          </StudioEmptyIcon>
        }
        title="Run detail isn't available yet"
        description="Per-run detail ships with the backend builder slice. Nothing here is simulated."
      />
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  if (!run) {
    return (
      <div className="space-y-2 max-w-2xl" aria-label="Loading run">
        <Skeleton height={64} />
        <Skeleton height={200} />
      </div>
    );
  }

  return (
    <div className="studio-scope max-w-2xl">
      <Link
        to="/studio/runs"
        className="font-mono text-[11px] uppercase"
        style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }}
      >
        ← Runs
      </Link>
      <div className="mt-2 flex items-center gap-3">
        <h1 className="font-semibold truncate" style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)', letterSpacing: '-0.02em' }}>
          {run.automationName}
        </h1>
        <Badge tone={statusTone(run.status)} title={`Status: ${run.status}`}>
          <span aria-hidden="true" className="studio-dot mr-1.5" style={{ background: 'currentColor' }} />
          {run.status}
        </Badge>
      </div>
      <p className="mt-1.5 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
        started {new Date(run.startedAt).toLocaleString()}
        {run.finishedAt ? ` · ended ${new Date(run.finishedAt).toLocaleString()}` : ''}
        {' · '}duration {formatDuration(run.durationMs)}
        {run.triggeredBy ? ` · by ${run.triggeredBy}` : ''}
      </p>

      {run.error && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg px-4 py-3" role="alert" style={{ background: '#d2827914', border: '1px solid #d2827940' }}>
          <span className="flex-shrink-0 mt-0.5" style={{ color: '#d28279' }}>
            <IconAlert size={14} />
          </span>
          <p className="text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.6 }}>{run.error}</p>
        </div>
      )}

      <div className="mt-6 rounded-lg px-5 py-5" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <p className="mb-4 text-[10px] font-bold uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}>
          Step timeline
        </p>
        <RunTimeline steps={run.steps} />
      </div>
    </div>
  );
}
