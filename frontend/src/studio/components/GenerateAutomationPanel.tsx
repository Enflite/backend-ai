/**
 * studio/components/GenerateAutomationPanel.tsx — "Generate with AI".
 *
 * Natural-language input -> loading -> draft preview rendered as step
 * cards -> "Edit in builder" (the draft already exists server-side as
 * `draft`; the builder loads it for review) or "Discard draft" (deletes
 * the server-side draft). Nothing is ever deployed from here: deploy
 * stays behind the builder's explicit confirm flow.
 *
 * Honest states throughout: the preview renders only the returned draft
 * (summaries from the real catalog, action ids when the catalog is
 * unavailable); generation failures surface the backend's message with a
 * retry; a 502 means the model output failed validation and nothing was
 * created.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Badge, Button, Modal, Skeleton } from '../../components/ui/primitives';
import ErrorState from '../../components/ui/ErrorState';
import {
  deleteStudioAutomation,
  generateStudioAutomation,
  listStudioActions,
} from '../api';
import type { StudioAction, StudioAutomation, StudioConnection } from '../types';
import { stepKindLabel, summarizeStep } from '../builder';
import { IconAlert, IconX } from './StudioIcons';

const PROMPT_MAX = 2000;

type Phase =
  | { name: 'input' }
  | { name: 'working' }
  | { name: 'error'; message: string }
  | { name: 'preview'; draft: StudioAutomation };

function DestructiveBanner({ count }: { count: number }) {
  return (
    <div
      className="flex items-start gap-2.5 rounded-lg px-4 py-3"
      role="alert"
      style={{ background: '#d2827914', border: '1px solid #d2827940' }}
    >
      <span className="flex-shrink-0 mt-0.5" style={{ color: '#d28279' }}>
        <IconAlert size={14} />
      </span>
      <p className="text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.6 }}>
        This draft contains {count} destructive step{count === 1 ? '' : 's'}. Destructive steps are
        skipped in dry-runs and the automation cannot be deployed until you explicitly confirm them.
      </p>
    </div>
  );
}

export default function GenerateAutomationPanel({
  connections,
  onClose,
}: {
  connections: StudioConnection[];
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ name: 'input' });
  const [prompt, setPrompt] = useState('');
  const [connectionId, setConnectionId] = useState<string>(connections[0]?.id ?? 'default');
  const [catalog, setCatalog] = useState<StudioAction[]>([]);
  const [discarding, setDiscarding] = useState(false);

  const catalogById = useMemo(() => new Map(catalog.map((a) => [a.id, a])), [catalog]);

  useEffect(() => {
    let cancelled = false;
    void listStudioActions()
      .then((actions) => {
        if (!cancelled) setCatalog(actions);
      })
      .catch(() => {
        /* summaries fall back to action ids — never invented */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const canGenerate = prompt.trim().length > 0 && prompt.length <= PROMPT_MAX;

  const runGenerate = async () => {
    if (!canGenerate || phase.name === 'working') return;
    setPhase({ name: 'working' });
    try {
      const draft = await generateStudioAutomation(
        prompt.trim(),
        connectionId === 'default' ? undefined : connectionId,
      );
      setPhase({ name: 'preview', draft });
    } catch (cause) {
      setPhase({
        name: 'error',
        message:
          cause instanceof Error ? cause.message : 'Generation failed. Nothing was created.',
      });
    }
  };

  const discardDraft = async (draft: StudioAutomation) => {
    setDiscarding(true);
    try {
      await deleteStudioAutomation(draft.id);
    } catch {
      /* the draft stays server-side as a draft; the user can delete it later */
    } finally {
      setDiscarding(false);
      onClose();
    }
  };

  return (
    <Modal
      title="Generate with AI"
      subtitle="Describe the automation in plain language. A draft is created for your review — nothing is deployed."
      onClose={onClose}
      wide
    >
      <div className="px-5 py-4">
        {phase.name === 'input' && (
          <div>
            <label
              htmlFor="ai-generate-prompt"
              className="text-[9px] font-bold uppercase"
              style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
            >
              What should this automation do?
            </label>
            <textarea
              id="ai-generate-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              maxLength={PROMPT_MAX}
              placeholder="e.g. Every morning, check item availability for WIDGET-1 at MAIN and log the result"
              className="mt-2 w-full rounded-lg px-3 py-2.5 text-[13px] bg-transparent"
              style={{
                border: '1px solid var(--border)',
                color: 'var(--foreground)',
                lineHeight: 1.6,
                resize: 'vertical',
              }}
            />
            <div className="mt-1.5 flex items-center justify-between">
              <span className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {prompt.length}/{PROMPT_MAX}
              </span>
              {connections.length > 0 && (
                <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  Connection
                  <select
                    value={connectionId}
                    onChange={(e) => setConnectionId(e.target.value)}
                    className="rounded-md px-2 py-1 text-xs bg-transparent"
                    style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                    aria-label="Connection for the generated draft"
                  >
                    {connections.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} ({c.environment})
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" onClick={() => void runGenerate()} disabled={!canGenerate}>
                Generate draft
              </Button>
            </div>
            <p className="mt-3 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
              Drafts are built only from the real action catalog. Destructive actions are included
              only when you ask for them — and still deploy only with your explicit confirmation.
            </p>
          </div>
        )}

        {phase.name === 'working' && (
          <div aria-label="Generating automation draft">
            <p className="text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
              Drafting your automation…
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)' }}>
              The model is working from the real action catalog. This can take a few seconds.
            </p>
            <div className="mt-4 space-y-2">
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} height={56} />
              ))}
            </div>
          </div>
        )}

        {phase.name === 'error' && (
          <div>
            <ErrorState message={phase.message} onRetry={() => setPhase({ name: 'input' })} />
            <p className="mt-2 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
              A generation failure never creates a partial draft.
            </p>
          </div>
        )}

        {phase.name === 'preview' && (
          <PreviewDraft
            draft={phase.draft}
            catalogById={catalogById}
            discarding={discarding}
            onRegenerate={() => setPhase({ name: 'input' })}
            onDiscard={() => void discardDraft(phase.draft)}
            onEdit={() => {
              onClose();
              navigate(`/studio/automations/${phase.draft.id}`);
            }}
          />
        )}
      </div>
    </Modal>
  );
}

function PreviewDraft({
  draft,
  catalogById,
  discarding,
  onRegenerate,
  onDiscard,
  onEdit,
}: {
  draft: StudioAutomation;
  catalogById: Map<string, StudioAction>;
  discarding: boolean;
  onRegenerate: () => void;
  onDiscard: () => void;
  onEdit: () => void;
}) {
  const destructiveCount = draft.destructiveSteps?.length ?? 0;
  return (
    <div>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.08em' }}>
            Draft · {draft.status}
          </p>
          <h3 className="mt-1 font-semibold truncate" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
            {draft.title}
          </h3>
          {draft.description && (
            <p className="mt-1 text-xs" style={{ color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
              {draft.description}
            </p>
          )}
        </div>
        <Badge tone="gray">DRAFT</Badge>
      </div>

      {destructiveCount > 0 && (
        <div className="mt-3">
          <DestructiveBanner count={destructiveCount} />
        </div>
      )}

      <p
        className="mt-4 text-[9px] font-bold uppercase"
        style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
      >
        Steps ({draft.steps.length})
      </p>
      <ul className="mt-2 space-y-2" aria-label="Generated steps">
        {draft.steps.map((step, i) => {
          const action = step.actionId ? catalogById.get(step.actionId) : undefined;
          const destructive = action?.destructive === true;
          return (
            <li
              key={step.id}
              className="rounded-lg px-4 py-3"
              style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[9px] font-bold uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}>
                  {i + 1} · {stepKindLabel(step.kind)}
                </span>
                {destructive && <Badge tone="red">destructive</Badge>}
              </div>
              <p className="mt-1 text-[13px] font-medium" style={{ color: 'var(--foreground)' }}>
                {summarizeStep(step, action)}
              </p>
              {step.kind === 'action' && (
                <p className="mt-0.5 font-mono text-[10px] truncate" style={{ color: 'var(--muted-foreground)' }}>
                  {action?.operation ? `${action.operation.method} ${action.operation.path}` : step.actionId}
                  {step.connectionId ? ` · ${step.connectionId}` : ''}
                </p>
              )}
            </li>
          );
        })}
      </ul>

      <div className="mt-5 flex items-center justify-between gap-2">
        <Button variant="outline" size="sm" onClick={onDiscard} disabled={discarding}>
          <span className="inline-flex items-center gap-1.5">
            <IconX size={12} />
            {discarding ? 'Discarding…' : 'Discard draft'}
          </span>
        </Button>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRegenerate}>
            Regenerate
          </Button>
          <Button variant="primary" size="sm" onClick={onEdit}>
            Edit in builder
          </Button>
        </div>
      </div>
    </div>
  );
}
