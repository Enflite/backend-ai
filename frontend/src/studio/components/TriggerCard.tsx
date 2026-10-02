/**
 * studio/components/TriggerCard.tsx — the first card on the canvas.
 *
 * Always the trigger; kind-specific config lives in the editor panel.
 * The card itself shows the kind label + a one-line summary of the config.
 */
import { Badge } from '../../components/ui/primitives';
import type { StudioTrigger } from '../types';
import { summarizeTrigger } from '../builder';
import { IconCopy, IconLink } from './StudioIcons';

const TRIGGER_KIND_LABEL: Record<StudioTrigger['kind'], string> = {
  manual: 'Manual',
  scheduled: 'Scheduled',
  webhook: 'Webhook',
  event: 'Event',
};

export default function TriggerCard({
  trigger,
  selected,
  readOnly,
  onSelect,
  onCopyWebhook,
  copied,
}: {
  trigger: StudioTrigger;
  selected: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onCopyWebhook: () => void;
  copied: boolean;
}) {
  return (
    <div
      role="button"
      tabIndex={readOnly ? -1 : 0}
      aria-pressed={selected}
      aria-label={`Trigger: ${TRIGGER_KIND_LABEL[trigger.kind]}. ${summarizeTrigger(trigger)}`}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (!readOnly && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onSelect();
        }
      }}
      className={`rounded-lg px-4 py-3 text-left w-full ${selected ? 'studio-step-selected' : ''}`}
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        cursor: readOnly ? 'default' : 'pointer',
        transition: 'border-color 160ms ease, box-shadow 160ms ease',
      }}
    >
      <div className="flex items-center gap-2">
        <span
          className="font-mono text-[9px] font-bold uppercase"
          style={{ color: 'var(--muted-foreground)', letterSpacing: '0.1em' }}
        >
          Trigger
        </span>
        <Badge tone="neutral">{TRIGGER_KIND_LABEL[trigger.kind]}</Badge>
      </div>
      <div className="mt-1.5 flex items-center gap-2 min-w-0">
        <span className="inline-flex flex-shrink-0" style={{ color: 'var(--muted-foreground)' }}>
          <IconLink size={14} />
        </span>
        <p className="font-mono truncate" style={{ fontSize: 'var(--text-meta)', color: 'var(--muted-foreground)' }}>
          {summarizeTrigger(trigger)}
        </p>
        {trigger.kind === 'webhook' && trigger.webhookUrl && !readOnly && (
          <button
            type="button"
            className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] flex-shrink-0"
            style={{ color: 'var(--muted-foreground)' }}
            onClick={(e) => {
              e.stopPropagation();
              onCopyWebhook();
            }}
          >
            <IconCopy size={12} />
            {copied ? 'copied' : 'copy'}
          </button>
        )}
      </div>
    </div>
  );
}
