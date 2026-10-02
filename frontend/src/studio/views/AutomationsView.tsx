/**
 * studio/views/AutomationsView.tsx — the automation library.
 *
 * Status filter tabs (All / Active / Drafts / Failed / Scheduled, per the
 * spec) with mono counts; rows show a status dot + title + trigger kind +
 * last run. The list endpoint lands with the backend builder slice — a 404
 * renders the honest "backend slice in flight" slot, never invented rows.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../auth';
import { hasAnyPermission } from '../../shell/navRegistry';
import { Button, Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import { isStudioUnavailable, listStudioAutomations } from '../api';
import { automationStatusBucket } from '../builder';
import type { StudioAutomationSummary, StudioTriggerKind } from '../types';
import { STUDIO_MANAGE_PERMISSIONS } from '../types';
import StudioEmpty, { IconBolt, StudioEmptyIcon } from '../components/StudioEmpty';

type Filter = 'all' | 'active' | 'draft' | 'failed' | 'scheduled';

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft', label: 'Drafts' },
  { id: 'failed', label: 'Failed' },
  { id: 'scheduled', label: 'Scheduled' },
];

const TRIGGER_KIND_LABEL: Record<StudioTriggerKind, string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  webhook: 'Webhook',
  event: 'Event',
};

function statusDotColor(status: string): string {
  const s = status.toLowerCase();
  if (s === 'failed') return '#d28279';
  if (s === 'draft') return '#7d857f';
  if (s === 'scheduled') return '#d9aa68';
  return '#6ee7a1';
}

function formatRelative(iso?: string | null): string {
  if (!iso) return 'never run';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const minutes = Math.round((Date.now() - d.getTime()) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}

export default function AutomationsView() {
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  const canCreate = hasAnyPermission(permissions, STUDIO_MANAGE_PERMISSIONS);

  const [automations, setAutomations] = useState<StudioAutomationSummary[] | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = useCallback(async () => {
    setError(null);
    setUnavailable(false);
    try {
      setAutomations(await listStudioAutomations());
    } catch (cause) {
      if (isStudioUnavailable(cause)) {
        setUnavailable(true);
        setAutomations(null);
      } else {
        setError(cause instanceof Error ? cause.message : 'Could not load automations.');
      }
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: 0, active: 0, draft: 0, failed: 0, scheduled: 0 };
    for (const a of automations ?? []) {
      c.all += 1;
      const bucket = automationStatusBucket(a.status);
      if (bucket !== 'other') c[bucket] += 1;
    }
    return c;
  }, [automations]);

  const visible = useMemo(() => {
    if (filter === 'all') return automations ?? [];
    return (automations ?? []).filter((a) => automationStatusBucket(a.status) === filter);
  }, [automations, filter]);

  if (unavailable) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconBolt />
          </StudioEmptyIcon>
        }
        title="The automations API isn't available yet"
        description="The backend builder slice is still in flight. Once it lands, your automations will appear here — triggered on a schedule, a webhook, or on demand."
      />
    );
  }

  if (error) return <ErrorState message={error} onRetry={() => void load()} />;

  if (automations === null) {
    return (
      <div className="space-y-2" aria-label="Loading automations">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} height={58} />
        ))}
      </div>
    );
  }

  if (automations.length === 0) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconBolt />
          </StudioEmptyIcon>
        }
        title="No automations yet"
        description="Automations are repeatable workflows you build from the API action catalog — triggered on a schedule, a webhook, or on demand. Create your first one to get started."
        action={
          canCreate ? (
            <Link to="/studio/automations/new">
              <Button variant="primary">New Automation</Button>
            </Link>
          ) : undefined
        }
      />
    );
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        {/* View tabs: text tabs with accent underline + mono counts. */}
        <div role="tablist" aria-label="Filter automations by status" className="flex items-center gap-1">
          {FILTERS.map((f) => {
            const active = filter === f.id;
            return (
              <button
                key={f.id}
                role="tab"
                aria-selected={active}
                onClick={() => setFilter(f.id)}
                className="relative px-3 py-2 text-[13px] font-medium whitespace-nowrap"
                style={{ color: active ? 'var(--foreground)' : 'var(--muted-foreground)' }}
              >
                <span className="hover:text-[var(--foreground)]" style={{ transition: 'color 160ms ease' }}>
                  {f.label}
                </span>
                <span className="ml-1.5 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                  {counts[f.id]}
                </span>
                {active && (
                  <span
                    aria-hidden="true"
                    className="absolute inset-x-2 bottom-0"
                    style={{ height: '2px', background: 'var(--accent)' }}
                  />
                )}
              </button>
            );
          })}
        </div>
        {canCreate && (
          <Link to="/studio/automations/new">
            <Button variant="primary" size="sm">New Automation</Button>
          </Link>
        )}
      </div>

      {visible.length === 0 ? (
        <div className="mt-4">
          <StudioEmpty
            title={`No ${FILTERS.find((f) => f.id === filter)?.label.toLowerCase()} automations`}
            description="Nothing matches this filter yet."
          />
        </div>
      ) : (
        <ul className="mt-2" aria-label="Automations">
          {visible.map((a) => (
            <li key={a.id}>
              <Link
                to={`/studio/automations/${a.id}`}
                className="flex items-center gap-3 rounded-lg px-4 py-3 mt-1.5"
                style={{
                  background: 'transparent',
                  border: '1px solid transparent',
                  transition: 'background 160ms ease, border-color 160ms ease',
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = 'rgba(255,255,255,0.025)';
                  e.currentTarget.style.borderColor = 'var(--border)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                  e.currentTarget.style.borderColor = 'transparent';
                }}
              >
                <span aria-hidden="true" className="studio-dot" style={{ background: statusDotColor(a.status) }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                    {a.title || a.name}
                  </span>
                  <span className="block text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                    {a.status} · {TRIGGER_KIND_LABEL[a.triggerKind] ?? a.triggerKind} · last run {formatRelative(a.lastRunAt)}
                  </span>
                </span>
                <span className="font-mono text-[10px] flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
                  {a.updatedAt ? new Date(a.updatedAt).toLocaleDateString() : ''}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
