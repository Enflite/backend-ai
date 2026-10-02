/**
 * studio/components/DeployConfirmModal.tsx — the destructive-deploy gate.
 *
 * Deploy is blocked behind this confirmation whenever the automation
 * contains destructive actions. It lists each destructive step (title,
 * underlying operation) so the operator sees exactly what will mutate
 * state. The API call only sends confirmDestructive: true after this
 * explicit confirmation. Always required — no quiet path around it.
 */
import { Badge, Button, Modal } from '../../components/ui/primitives';
import type { DestructiveStep } from '../builder';
import { summarizeStep } from '../builder';
import { IconAlert } from './StudioIcons';

export default function DeployConfirmModal({
  destructive,
  automationTitle,
  deploying,
  onConfirm,
  onCancel,
}: {
  destructive: DestructiveStep[];
  automationTitle: string;
  deploying: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal
      title="Deploy with destructive actions?"
      subtitle={`“${automationTitle}” contains ${destructive.length} destructive action${destructive.length === 1 ? '' : 's'}.`}
      onClose={onCancel}
      wide
    >
      <div className="flex items-start gap-3 rounded-lg px-4 py-3" style={{ background: '#cf0c2c0f', border: '1px solid #cf0c2c40' }}>
        <span className="flex-shrink-0 mt-0.5" style={{ color: '#cf0c2c' }}>
          <IconAlert size={16} />
        </span>
        <p className="text-xs" style={{ color: 'var(--foreground)', lineHeight: 1.6 }}>
          Deploying will let these steps <strong>mutate SyteLine state</strong> on every run. Review them
          carefully — this cannot be undone from here. Confirming sends an explicit destructive
          confirmation to the backend.
        </p>
      </div>

      <ul className="mt-4 space-y-2 max-h-64 overflow-y-auto" aria-label="Destructive steps">
        {destructive.map(({ step, action }) => (
          <li
            key={step.id}
            className="rounded-md px-3 py-2.5"
            style={{ background: 'var(--secondary)', border: '1px solid var(--border)' }}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold truncate" style={{ color: 'var(--foreground)' }}>
                {summarizeStep(step, action)}
              </span>
              <Badge tone="red">destructive</Badge>
            </div>
            {action.operation && (
              <p className="mt-1 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {action.operation.method} {action.operation.path}
              </p>
            )}
            {step.actionId && (
              <p className="mt-0.5 font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                {step.actionId}
              </p>
            )}
          </li>
        ))}
      </ul>

      <div className="mt-5 flex items-center justify-end gap-2">
        <Button variant="outline" onClick={onCancel} disabled={deploying}>
          Cancel
        </Button>
        <Button variant="danger" onClick={onConfirm} disabled={deploying}>
          {deploying ? 'Deploying…' : `Deploy with ${destructive.length} destructive action${destructive.length === 1 ? '' : 's'}`}
        </Button>
      </div>
    </Modal>
  );
}
