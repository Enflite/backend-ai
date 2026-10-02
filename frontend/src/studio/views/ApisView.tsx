/**
 * studio/views/ApisView.tsx — the action catalog browser.
 *
 * Drives GET /api/v1/studio/actions and groups actions by substrate. Each
 * action carries a supported/unsupported badge with the backend's own
 * reason — never invented. If the backend slice hasn't landed yet (404),
 * we say the catalog is unavailable rather than rendering an error.
 */
import { useEffect, useState } from 'react';
import ErrorState, { DisabledState } from '../../components/ui/ErrorState';
import Spinner from '../../components/ui/Spinner';
import { Badge, Card, PageHeader, SectionLabel } from '../../components/ui/primitives';
import { isStudioUnavailable, listStudioActions } from '../api';
import { groupActionsBySubstrate, substrateLabel } from '../catalog';
import type { StudioAction } from '../types';
import StudioEmpty, { IconPlug, StudioEmptyIcon } from '../components/StudioEmpty';

type LoadState = 'loading' | 'ready' | 'unavailable' | 'error';

function ActionCard({ action }: { action: StudioAction }) {
  return (
    <Card className="p-4" style={{ transition: 'border-color 160ms ease' }}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[13px] font-semibold" style={{ color: 'var(--foreground)' }}>
            {action.title}
          </h3>
          <p className="mt-1 font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
            {action.id}
          </p>
        </div>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {action.destructive && <Badge tone="red" title="This action changes data in SyteLine">destructive</Badge>}
          {action.supported ? (
            <Badge tone="green">supported</Badge>
          ) : (
            <Badge tone="gray" title={action.supportReason ?? 'No reason given'}>unsupported</Badge>
          )}
        </div>
      </div>
      <p className="mt-2" style={{ fontSize: 'var(--text-secondary)', color: 'var(--muted-foreground)', lineHeight: 'var(--leading-relaxed)' }}>
        {action.description}
      </p>
      {!action.supported && action.supportReason && (
        <p className="mt-2 text-[12px]" style={{ color: 'var(--muted-foreground)' }}>
          <span className="font-semibold" style={{ color: 'var(--muted-bright)' }}>Why not: </span>
          {action.supportReason}
        </p>
      )}
    </Card>
  );
}

export default function ApisView() {
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [actions, setActions] = useState<StudioAction[]>([]);
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoadState('loading');
      setLoadError('');
      try {
        const list = await listStudioActions();
        if (cancelled) return;
        setActions(list);
        setLoadState('ready');
      } catch (cause) {
        if (cancelled) return;
        if (isStudioUnavailable(cause)) {
          setLoadState('unavailable');
        } else {
          setLoadState('error');
          setLoadError(cause instanceof Error ? cause.message : 'Unable to load the action catalog');
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, []);

  if (loadState === 'loading') {
    return (
      <div className="py-16 flex justify-center" role="status" aria-label="Loading action catalog">
        <Spinner />
      </div>
    );
  }

  if (loadState === 'unavailable') {
    return (
      <DisabledState
        product="Action catalog"
        hint="The studio backend hasn't been deployed yet, so there's no catalog to browse. It lands with the studio backend slice."
      />
    );
  }

  if (loadState === 'error') {
    return <ErrorState message={loadError} onRetry={() => window.location.reload()} />;
  }

  if (actions.length === 0) {
    return (
      <StudioEmpty
        icon={
          <StudioEmptyIcon>
            <IconPlug />
          </StudioEmptyIcon>
        }
        title="The catalog is empty"
        description="The studio backend is reachable but hasn't registered any actions yet. Actions appear here once the backend's action catalog is populated."
      />
    );
  }

  const groups = groupActionsBySubstrate(actions);
  const supportedCount = actions.filter((a) => a.supported).length;

  return (
    <div>
      <PageHeader
        title="Action catalog"
        description={`${actions.length} actions · ${supportedCount} supported — grouped by system`}
      />
      <div className="mt-6 space-y-8">
        {groups.map((group) => (
          <section key={group.substrate} aria-label={`${substrateLabel(group.substrate)} actions`}>
            <SectionLabel>{substrateLabel(group.substrate)}</SectionLabel>
            <div className="mt-3 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {group.actions.map((action) => (
                <ActionCard key={action.id} action={action} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
