/**
 * studio/components/AddStepMenu.tsx — the insert affordance menu.
 *
 * Anchored under the "+" between canvas cards. Quick-pick rows for
 * condition / verify / log, then the real action catalog grouped by
 * substrate (area). Unsupported actions render disabled with their
 * honest reason. No invented actions.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Badge, Skeleton } from '../../components/ui/primitives';
import type { StudioAction, StudioAiSuggestion, StudioStep, StudioStepKind } from '../types';
import { groupActionsBySubstrate, substrateLabel } from '../catalog';
import { stepKindLabel } from '../builder';

export interface AiSuggestionState {
  suggestions: StudioAiSuggestion[] | null;
  loading: boolean;
  error: string | null;
}

export default function AddStepMenu({
  catalog,
  anchor,
  onAdd,
  onClose,
  ai,
  onPickSuggestion,
}: {
  catalog: StudioAction[];
  /** Bounding rect of the "+" button; the menu anchors under it. */
  anchor: DOMRect;
  onAdd: (kind: StudioStepKind, actionId?: string) => void;
  onClose: () => void;
  /** AI suggestions state; omitted when suggestions aren't available. */
  ai?: AiSuggestionState;
  /** Insert a suggested step (the suggestion is returned only — this applies it). */
  onPickSuggestion?: (step: StudioStep) => void;
}) {
  const [query, setQuery] = useState('');
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onPointerDown(e: PointerEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onPointerDown);
    };
  }, [onClose]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? catalog.filter(
          (a) =>
            a.title.toLowerCase().includes(q) ||
            a.id.toLowerCase().includes(q) ||
            a.description.toLowerCase().includes(q),
        )
      : catalog;
    return groupActionsBySubstrate(filtered);
  }, [catalog, query]);

  const quickKinds: { kind: StudioStepKind; label: string; hint: string }[] = [
    { kind: 'condition', label: 'Condition', hint: 'branch on an expression' },
    { kind: 'verify', label: 'Verify', hint: 'assert an expected outcome' },
    { kind: 'log', label: 'Log', hint: 'write to the run log' },
  ];

  // Clamp the panel inside the viewport.
  const style: React.CSSProperties = {
    position: 'fixed',
    top: Math.min(anchor.bottom + 6, window.innerHeight - 420),
    left: Math.max(8, Math.min(anchor.left - 140, window.innerWidth - 320)),
    width: 300,
    maxHeight: 400,
    zIndex: 60,
    background: 'var(--card)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    boxShadow: 'var(--shadow-lg)',
  };

  return (
    <div ref={panelRef} className="studio-popover flex flex-col overflow-hidden" style={style} role="menu" aria-label="Add step">
      <div className="px-3 pt-3 pb-2" style={{ borderBottom: '1px solid var(--border)' }}>
        <input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search actions…"
          aria-label="Search actions"
          className="w-full rounded-md px-2.5 py-1.5 text-xs bg-transparent"
          style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
        />
      </div>
      <div className="overflow-y-auto py-1.5">
        {ai && onPickSuggestion && (
          <>
            <p
              className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase"
              style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
            >
              AI suggestions
            </p>
            {ai.loading && (
              <div className="px-3 py-1 space-y-1.5" aria-label="Loading suggestions">
                <Skeleton height={44} />
                <Skeleton height={44} />
              </div>
            )}
            {!ai.loading && ai.error && (
              <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                Couldn't load suggestions: {ai.error}
              </p>
            )}
            {!ai.loading && !ai.error && (ai.suggestions ?? []).length === 0 && (
              <p className="px-3 py-2 text-[11px]" style={{ color: 'var(--muted-foreground)' }}>
                No suggestions for this draft yet.
              </p>
            )}
            {!ai.loading &&
              !ai.error &&
              (ai.suggestions ?? []).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitem"
                  title={s.reason}
                  className="w-full text-left px-3 py-2 hover:bg-secondary flex items-start justify-between gap-2"
                  onClick={() => onPickSuggestion(s.step)}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium" style={{ color: 'var(--foreground)' }}>
                      {s.title}
                    </span>
                    <span
                      className="block text-[10px]"
                      style={{
                        color: 'var(--muted-foreground)',
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {s.reason}
                    </span>
                  </span>
                  <span className="flex-shrink-0 pt-0.5">
                    <Badge tone="gray">{stepKindLabel(s.kind)}</Badge>
                  </span>
                </button>
              ))}
            <div className="mx-3 my-1.5" style={{ borderTop: '1px solid var(--border)' }} aria-hidden="true" />
          </>
        )}

        {quickKinds.map((q) => (
          <button
            key={q.kind}
            type="button"
            role="menuitem"
            className="w-full text-left px-3 py-2 hover:bg-secondary flex items-center justify-between gap-2"
            onClick={() => onAdd(q.kind)}
          >
            <span>
              <span className="block text-xs font-semibold" style={{ color: 'var(--foreground)' }}>
                {q.label}
              </span>
              <span className="block text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {q.hint}
              </span>
            </span>
            <Badge tone="gray">{q.kind.toUpperCase()}</Badge>
          </button>
        ))}

        <div className="mx-3 my-1.5" style={{ borderTop: '1px solid var(--border)' }} aria-hidden="true" />

        {groups.length === 0 && (
          <p className="px-3 py-3 text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {query ? `No actions match “${query}”.` : 'The action catalog is empty.'}
          </p>
        )}
        {groups.map((group) => (
          <div key={group.substrate}>
            <p
              className="px-3 pt-2 pb-1 text-[9px] font-bold uppercase"
              style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
            >
              {substrateLabel(group.substrate)}
            </p>
            {group.actions.map((action) => {
              const disabled = !action.supported;
              return (
                <button
                  key={action.id}
                  type="button"
                  role="menuitem"
                  disabled={disabled}
                  title={disabled ? action.supportReason ?? 'Not supported' : action.description}
                  className="w-full text-left px-3 py-2 hover:bg-secondary flex items-start justify-between gap-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  onClick={() => onAdd('action', action.id)}
                >
                  <span className="min-w-0">
                    <span className="block text-xs font-medium truncate" style={{ color: 'var(--foreground)' }}>
                      {action.title}
                    </span>
                    <span className="block font-mono text-[10px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                      {action.operation ? `${action.operation.method} ${action.operation.path}` : action.id}
                    </span>
                  </span>
                  <span className="flex-shrink-0 flex gap-1 pt-0.5">
                    {action.destructive && <Badge tone="red">destructive</Badge>}
                    {disabled && <Badge tone="amber">unsupported</Badge>}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
