/**
 * studio/views/ConnectionsView.tsx — SyteLine tenant connections.
 *
 * Drives GET /api/v1/studio/connections. Each tenant renders as a card
 * with its capability flags; when nothing is connected the "not
 * connected" state is the headline, not a side note. If the backend slice
 * hasn't landed (404), we say so rather than faking an error.
 */
import { useEffect, useState } from 'react';
import ErrorState, { DisabledState } from '../../components/ui/ErrorState';
import Spinner from '../../components/ui/Spinner';
import { Badge, Card, PageHeader } from '../../components/ui/primitives';
import { isStudioUnavailable, listStudioConnections } from '../api';
import { STUDIO_CAPABILITY_LABELS, type StudioConnection } from '../types';
import StudioEmpty, { IconPlug, StudioEmptyIcon } from '../components/StudioEmpty';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

function formatUpdatedAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

function ConnectionCard({ connection }: { connection: StudioConnection }) {
  const entries = Object.entries(connection.capabilities);
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold" style={{ color: 'var(--foreground)' }}>
            {connection.name}
          </h3>
          <p className="mt-0.5 font-mono text-[11px] truncate" style={{ color: 'var(--muted-foreground)' }} title={connection.baseUrl}>
            {connection.baseUrl}
          </p>
        </div>
        <Badge tone="green">connected</Badge>
      </div>
      <div className="mt-3 flex items-center gap-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
        <span>Environment</span>
        <span className="font-mono" style={{ color: 'var(--muted-bright)' }}>{connection.environment}</span>
      </div>
      <div className="mt-3" style={{ borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
        <p className="text-[10px] font-bold uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}>
          Capabilities
        </p>
        {entries.length === 0 ? (
          <p className="mt-1.5 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
            No capability metadata reported for this connection.
          </p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {entries.map(([key, enabled]) => (
              <li key={key} className="flex items-center gap-2 text-[12px]">
                <span
                  aria-hidden="true"
                  className="inline-block rounded-full"
                  style={{
                    width: 6,
                    height: 6,
                    background: enabled ? 'var(--green, #6ee7a1)' : 'var(--muted-foreground)',
                  }}
                />
                <span style={{ color: 'var(--foreground)' }}>{STUDIO_CAPABILITY_LABELS[key] ?? key}</span>
                <span className="font-mono" style={{ color: 'var(--muted-foreground)' }}>
                  {enabled ? 'available' : 'unavailable'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <p className="mt-3 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
        Updated {formatUpdatedAt(connection.updatedAt)}
      </p>
    </Card>
  );
}

export default function ConnectionsView() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [connections, setConnections] = useState<StudioConnection[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadState('loading');
      setLoadError('');
      try {
        const list = await listStudioConnections();
        if (cancelled) return;
        setConnections(list);
        setLoadState('ready');
      } catch (cause) {
        if (cancelled) return;
        if (isStudioUnavailable(cause)) {
          setLoadState('unavailable');
        } else {
          setLoadState('error');
          setLoadError(cause instanceof Error ? cause.message : 'Unable to load connections');
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loadState === 'loading') {
    return (
      <div className="py-16 flex justify-center" role="status" aria-label="Loading connections">
        <Spinner />
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <DisabledState
        product="Connections"
        hint="The studio backend hasn't been deployed yet, so there are no connections to show. It lands with the studio backend slice."
      />
    );
  }

  if (loadState === 'error') {
    return <ErrorState message={loadError} onRetry={() => window.location.reload()} />;
  }

  if (connections.length === 0) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconPlug />
          </StudioEmptyIcon>
        }
        title="Not connected"
        description="No SyteLine tenants are connected to the studio yet. Automations need at least one tenant to run against — ask your administrator to connect one."
      />
    );
  }

  return (
    <div>
      <PageHeader
        title="Connections"
        description={`${connections.length} tenant${connections.length === 1 ? '' : 's'} connected`}
      />
      <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {connections.map((connection) => (
          <ConnectionCard key={connection.id} connection={connection} />
        ))}
      </div>
    </div>
  );
}
