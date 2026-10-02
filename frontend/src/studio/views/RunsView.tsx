/**
 * studio/views/RunsView.tsx — run history for studio automations.
 *
 * Lists runs from GET /api/v1/studio/runs (backend builder slice). A 404
 * renders the honest "not available yet" slot — no invented run history.
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import { isStudioUnavailable, listStudioRuns } from '../api';
import type { StudioRunSummary } from '../types';
import StudioEmpty, { IconList, StudioEmptyIcon } from '../components/StudioEmpty';

function runDotColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'failed') return '#d28279';
  if (s === 'running') return '#d997ff';
  if (s === 'cancelled' || s === 'skipped') return '#7d857f';
  return '#6ee7a1';
}

function formatDuration(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export default function RunsView() {
  const [runs, setRuns] = useState<StudioRunSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    setUnavailable(false);
    try {
      setRuns(await listStudioRuns());
    } catch (cause) {
      if (isStudioUnavailable(cause)) {
        setUnavailable(true);
        setRuns(null);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not load runs.');
      }
    }
  }, []);

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
        title="Run history isn't available yet"
        description="The backend builder slice records every run — what ran, which actions fired, and the evidence — and it will show up here once it lands."
      />
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  if (runs === null) {
    return (
      <div className="space-y-2" aria-label="Loading runs">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={58} />
        ))}
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconList />
          </StudioEmptyIcon>
        }
        title="No runs yet"
        description="Every automation run — what ran, which actions fired, what changed, and the evidence — will show up here with a full audit trail. Runs appear once your first automation executes."
      />
    );
  }

  return (
    <ul aria-label="Automation runs">
      {runs.map((run) => (
        <li key={run.id}>
          <Link
            to={`/studio/runs/${run.id}`}
            className="flex items-center gap-3 rounded-lg px-4 py-3 mt-1.5"
            style={{ border: '1px solid transparent', transition: 'background 160ms ease, border-color 160ms ease' }}
            onMouseEnter={(e) => {
              e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
              e.currentTarget.style.borderColor = 'var(--border)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.background = 'transparent';
              e.currentTarget.style.borderColor = 'transparent';
            }}
          >
            <span aria-hidden="true" className="studio-dot" style={{ background: runDotColor(run.status) }} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                {run.automationName}
              </span>
              <span className="block text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                {run.status}
                {run.triggeredBy ? ` · by ${run.triggeredBy}` : ''} · {formatDuration(run.durationMs)}
              </span>
            </span>
            <span className="font-mono text-[10px] flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
              {new Date(run.startedAt).toLocaleString()}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
