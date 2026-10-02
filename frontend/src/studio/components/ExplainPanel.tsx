/**
 * studio/components/ExplainPanel.tsx — "Explain" side panel for the builder.
 *
 * A slide-over drawer rendering the deterministic explanation of the
 * automation: summary, trigger, and a plain-language tour of every step.
 * Destructive steps get a prominent warning section. The content is
 * derived from the stored definition — the panel never invents steps.
 */
import { useEffect, useState } from 'react';
import { Badge, IconButton, Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import { explainStudioAutomation } from '../api';
import type { StudioAiExplanation } from '../types';
import { stepKindLabel } from '../builder';
import { IconAlert, IconX } from './StudioIcons';

type Phase =
  | { name: 'loading' }
  | { name: 'error'; message: string }
  | { name: 'ready'; explanation: StudioAiExplanation };

export default function ExplainPanel({
  automationId,
  onClose,
}: {
  automationId: string;
  onClose: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });

  const load = () => {
    setPhase({ name: 'loading' });
    void explainStudioAutomation(automationId)
      .then((explanation) => setPhase({ name: 'ready', explanation }))
      .catch((cause: unknown) =>
        setPhase({
          name: 'error',
          message: cause instanceof Error ? cause.message : 'Could not explain this automation.',
        }),
      );
  };

  useEffect(() => {
    load();
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [automationId]);

  return (
    <div
      role="complementary"
      aria-label="Automation explanation"
      className="fixed top-0 right-0 bottom-0 z-40 w-full max-w-md overflow-y-auto"
      style={{
        background: 'var(--card)',
        borderLeft: '1px solid var(--border)',
        boxShadow: 'var(--shadow-lg)',
      }}
    >
      <div
        className="sticky top-0 flex items-start justify-between gap-3 px-5 py-4"
        style={{ background: 'var(--card)', borderBottom: '1px solid var(--border)' }}
      >
        <div>
          <p
            className="text-[9px] font-bold uppercase"
            style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
          >
            Explain
          </p>
          <h2 className="mt-1 font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
            What will this do?
          </h2>
        </div>
        <IconButton label="Close explanation" onClick={onClose}>
          <IconX size={14} />
        </IconButton>
      </div>

      <div className="px-5 py-4">
        {phase.name === 'loading' && (
          <div className="space-y-2" aria-label="Loading explanation">
            <Skeleton height={48} />
            <Skeleton height={72} />
            <Skeleton height={72} />
          </div>
        )}

        {phase.name === 'error' && <ErrorState message={phase.message} onRetry={load} />}

        {phase.name === 'ready' && (
          <div>
            <p className="text-[13px]" style={{ color: 'var(--foreground)', lineHeight: 1.65 }}>
              {phase.explanation.summary}
            </p>
            <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
              Trigger: {phase.explanation.trigger.text}
            </p>

            {phase.explanation.destructive.length > 0 && (
              <div
                className="mt-4 rounded-lg px-4 py-3"
                role="alert"
                style={{ background: '#d2827914', border: '1px solid #d2827940' }}
              >
                <p
                  className="flex items-center gap-2 text-[10px] font-bold uppercase"
                  style={{ color: '#d28279', letterSpacing: '0.1em' }}
                >
                  <IconAlert size={13} />
                  Destructive steps ({phase.explanation.destructive.length})
                </p>
                <ul className="mt-2 space-y-2">
                  {phase.explanation.destructive.map((d) => (
                    <li key={d.stepId}>
                      <p className="font-mono text-[10px]" style={{ color: '#d28279' }}>
                        {d.stepId} · {d.actionId}
                      </p>
                      <p className="mt-0.5 text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.6 }}>
                        {d.warning}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <p
              className="mt-5 text-[9px] font-bold uppercase"
              style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
            >
              Step by step ({phase.explanation.steps.length})
            </p>
            <ol className="mt-2 space-y-3">
              {phase.explanation.steps.map((step) => (
                <li key={step.stepId}>
                  <p className="font-mono text-[9px] font-bold uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}>
                    {stepKindLabel(step.kind)} · <span className="normal-case tracking-normal">{step.stepId}</span>
                  </p>
                  <p className="mt-1 text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.65 }}>
                    {step.text}
                  </p>
                </li>
              ))}
            </ol>

            {phase.explanation.destructive.length > 0 && (
              <div className="mt-4">
                <Badge tone="red">Deploy requires explicit confirmation</Badge>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
