/**
 * studio/views/NewAutomationView.tsx — the "New automation" route.
 *
 * Two ways in: describe the automation in plain language ("Generate with
 * AI" — the backend drafts it from the real action catalog for review),
 * or build it manually on the canvas (a local draft until the first save
 * creates it). Generating requires studio:run; manual building requires
 * studio:manage.
 */
import { useCallback, useState } from 'react';
import { useAuth } from '../../auth';
import { hasAnyPermission } from '../../shell/navRegistry';
import { Button } from '../../components/ui/primitives';
import { listStudioConnections } from '../api';
import type { StudioConnection } from '../types';
import { STUDIO_MANAGE_PERMISSIONS, STUDIO_RUN_PERMISSIONS } from '../types';
import BuilderView from './BuilderView';
import GenerateAutomationPanel from '../components/GenerateAutomationPanel';

function ChoiceCard({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action: React.ReactNode;
}) {
  return (
    <div
      className="rounded-xl px-6 py-6 flex flex-col"
      style={{ background: 'var(--card)', border: '1px solid var(--border)' }}
    >
      <h2 className="font-semibold" style={{ fontSize: 'var(--text-section-title)', color: 'var(--foreground)' }}>
        {title}
      </h2>
      <p className="mt-2 text-[13px] flex-1" style={{ color: 'var(--muted-foreground)', lineHeight: 1.65 }}>
        {description}
      </p>
      <div className="mt-5">{action}</div>
    </div>
  );
}

export default function NewAutomationView() {
  const { user } = useAuth();
  const permissions = user?.permissions ?? [];
  const canManage = hasAnyPermission(permissions, STUDIO_MANAGE_PERMISSIONS);
  const canGenerate = hasAnyPermission(permissions, STUDIO_RUN_PERMISSIONS);

  const [mode, setMode] = useState<'choice' | 'manual'>('choice');
  const [generateOpen, setGenerateOpen] = useState(false);
  const [connections, setConnections] = useState<StudioConnection[]>([]);

  const openGenerate = useCallback(() => {
    setGenerateOpen(true);
    void listStudioConnections()
      .then(setConnections)
      .catch(() => setConnections([]));
  }, []);

  if (mode === 'manual') {
    return <BuilderView mode="new" />;
  }

  return (
    <div className="max-w-3xl">
      <p className="font-mono text-[11px] uppercase" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }} aria-label="Breadcrumb">
        Automations / New
      </p>
      <h1
        className="mt-2 font-semibold"
        style={{ fontSize: 'var(--text-page-title)', color: 'var(--foreground)', letterSpacing: '-0.02em' }}
      >
        New automation
      </h1>
      <p className="mt-1 text-sm" style={{ color: 'var(--muted-foreground)' }}>
        Start from a plain-language description or build the workflow yourself on the canvas.
      </p>

      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <ChoiceCard
          title="Generate with AI"
          description="Describe what the automation should do. A draft is created from the real action catalog for your review — nothing is deployed until you say so."
          action={
            <Button variant="primary" onClick={openGenerate} disabled={!canGenerate}>
              Generate with AI
            </Button>
          }
        />
        <ChoiceCard
          title="Build manually"
          description="Assemble trigger and steps yourself on the visual canvas, with the catalog-driven step editor and per-step testing."
          action={
            <Button variant="outline" onClick={() => setMode('manual')} disabled={!canManage}>
              Open the builder
            </Button>
          }
        />
      </div>
      {!canGenerate && !canManage && (
        <p className="mt-4 text-xs" style={{ color: 'var(--muted-foreground)' }}>
          You don't have permission to create automations.
        </p>
      )}

      {generateOpen && (
        <GenerateAutomationPanel connections={connections} onClose={() => setGenerateOpen(false)} />
      )}
    </div>
  );
}
