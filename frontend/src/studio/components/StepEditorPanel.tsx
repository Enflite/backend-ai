/**
 * studio/components/StepEditorPanel.tsx — the canvas side panel.
 *
 * Edits the selected trigger or step. Action-step inputs are driven by the
 * catalog entry's published params JSON Schema (simple typed inputs only:
 * text / number / boolean / select). Condition/verify/log steps get their
 * own plain fields. Read-only users see the panel without inputs.
 */
import { Badge, Button, IconButton, SectionLabel, Select, TextInput } from '../../components/ui/primitives';
import type { StudioAction, StudioConnection, StudioStep, StudioTrigger, StudioTriggerKind } from '../types';
import { coerceParamValue, fieldsFromJsonSchema, paramInputValue, stepKindLabel } from '../builder';
import type { ParamField } from '../builder';
import { IconX } from './StudioIcons';

const TRIGGER_KINDS: { kind: StudioTriggerKind; label: string; hint: string }[] = [
  { kind: 'manual', label: 'Manual', hint: 'run on demand from Test / Run' },
  { kind: 'scheduled', label: 'Scheduled', hint: 'run on a cron schedule' },
  { kind: 'webhook', label: 'Webhook', hint: 'run when the URL is called' },
  { kind: 'event', label: 'Event', hint: 'run when the described event fires' },
];

function ParamFieldInput({
  field,
  value,
  readOnly,
  onChange,
}: {
  field: ParamField;
  value: unknown;
  readOnly: boolean;
  onChange: (value: unknown) => void;
}) {
  const current = paramInputValue(field, value);
  if (readOnly) {
    return (
      <div>
        <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
          {field.name}
          {field.required && <span style={{ color: 'var(--accent)' }}> *</span>}
        </span>
        <p className="font-mono text-xs px-3 py-2 rounded-md truncate" style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}>
          {String(current) || '—'}
        </p>
      </div>
    );
  }
  if (field.type === 'boolean') {
    return (
      <label className="flex items-center gap-2 text-xs" style={{ color: 'var(--foreground)' }}>
        <input
          type="checkbox"
          checked={current === true}
          onChange={(e) => onChange(coerceParamValue(field, e.target.checked))}
        />
        {field.name}
        {field.required && <span style={{ color: 'var(--accent)' }}> *</span>}
      </label>
    );
  }
  if (field.type === 'select') {
    return (
      <Select
        label={`${field.name}${field.required ? ' *' : ''}`}
        value={typeof current === 'string' ? current : ''}
        onChange={(e) => onChange(coerceParamValue(field, e.target.value) ?? '')}
        className="w-full"
      >
        {!field.required && <option value="">—</option>}
        {(field.options ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt}
          </option>
        ))}
      </Select>
    );
  }
  return (
    <TextInput
      label={`${field.name}${field.required ? ' *' : ''}`}
      type={field.type === 'number' ? 'number' : 'text'}
      value={typeof current === 'string' ? current : ''}
      placeholder={field.description}
      onChange={(e) => onChange(coerceParamValue(field, e.target.value))}
    />
  );
}

function TextArea({
  label,
  value,
  placeholder,
  readOnly,
  onChange,
  mono = false,
  rows = 3,
}: {
  label: string;
  value: string;
  placeholder?: string;
  readOnly: boolean;
  onChange: (value: string) => void;
  mono?: boolean;
  rows?: number;
}) {
  return (
    <label className="block">
      <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
        {label}
      </span>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        readOnly={readOnly}
        onChange={(e) => onChange(e.target.value)}
        className={`w-full rounded-md px-3 py-2 text-sm bg-transparent ${mono ? 'font-mono' : ''}`}
        style={{
          border: '1px solid var(--border)',
          color: 'var(--foreground)',
          fontSize: mono ? 'var(--text-meta)' : undefined,
          resize: 'vertical',
        }}
      />
    </label>
  );
}

export type EditorSelection =
  | { type: 'trigger'; trigger: StudioTrigger }
  | { type: 'step'; step: StudioStep }
  | null;

export default function StepEditorPanel({
  selection,
  catalog,
  catalogById,
  connections,
  readOnly,
  onChangeTrigger,
  onChangeStep,
  onDeleteStep,
  onClose,
}: {
  selection: EditorSelection;
  catalog: StudioAction[];
  catalogById: Map<string, StudioAction>;
  connections: StudioConnection[];
  readOnly: boolean;
  onChangeTrigger: (trigger: StudioTrigger) => void;
  onChangeStep: (patch: Partial<StudioStep>) => void;
  onDeleteStep: () => void;
  onClose: () => void;
}) {
  if (!selection) {
    return (
      <div className="rounded-lg px-4 py-6" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
        <SectionLabel>Editor</SectionLabel>
        <p className="mt-2 text-xs" style={{ color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
          Select the trigger or any step on the canvas to edit it here.
        </p>
      </div>
    );
  }

  const title = selection.type === 'trigger' ? 'Trigger' : `${stepKindLabel(selection.step.kind)} step`;

  return (
    <div className="rounded-lg" style={{ background: 'var(--card)', border: '1px solid var(--border)' }}>
      <div className="flex items-center justify-between px-4 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
        <SectionLabel>{title}</SectionLabel>
        <IconButton label="Close editor" onClick={onClose}>
          <IconX size={14} />
        </IconButton>
      </div>

      <div className="px-4 py-4 space-y-4">
        {selection.type === 'trigger' ? (
          <TriggerEditor trigger={selection.trigger} readOnly={readOnly} onChange={onChangeTrigger} />
        ) : (
          <StepEditor
            step={selection.step}
            catalog={catalog}
            catalogById={catalogById}
            connections={connections}
            readOnly={readOnly}
            onChange={onChangeStep}
            onDelete={onDeleteStep}
          />
        )}
      </div>
    </div>
  );
}

function TriggerEditor({
  trigger,
  readOnly,
  onChange,
}: {
  trigger: StudioTrigger;
  readOnly: boolean;
  onChange: (trigger: StudioTrigger) => void;
}) {
  return (
    <div className="space-y-4">
      {readOnly ? (
        <div>
          <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>Kind</span>
          <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
            {TRIGGER_KINDS.find((k) => k.kind === trigger.kind)?.label}
          </p>
        </div>
      ) : (
        <Select
          label="Kind"
          value={trigger.kind}
          onChange={(e) => onChange({ kind: e.target.value as StudioTriggerKind })}
          className="w-full"
        >
          {TRIGGER_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label} — {k.hint}
            </option>
          ))}
        </Select>
      )}

      {trigger.kind === 'scheduled' && (
        <TextInput
          label="Cron expression"
          value={trigger.cron ?? ''}
          className="font-mono"
          placeholder="0 6 * * *"
          readOnly={readOnly}
          onChange={(e) => onChange({ ...trigger, cron: e.target.value })}
        />
      )}

      {trigger.kind === 'webhook' && (
        <div>
          <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
            Webhook URL
          </span>
          {trigger.webhookUrl ? (
            <p className="font-mono text-xs px-3 py-2 rounded-md break-all" style={{ background: 'var(--secondary)', color: 'var(--muted-foreground)' }}>
              {trigger.webhookUrl}
            </p>
          ) : (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              The backend issues the webhook URL when this automation is deployed.
            </p>
          )}
        </div>
      )}

      {trigger.kind === 'event' && (
        <TextArea
          label="Event description"
          value={trigger.event ?? ''}
          placeholder="e.g. a purchase order is created in SyteLine"
          readOnly={readOnly}
          onChange={(event) => onChange({ ...trigger, event })}
        />
      )}

      {trigger.kind === 'manual' && (
        <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
          Manual automations run on demand — from the Test and Run buttons. No trigger config needed.
        </p>
      )}
    </div>
  );
}

function StepEditor({
  step,
  catalog,
  catalogById,
  connections,
  readOnly,
  onChange,
  onDelete,
}: {
  step: StudioStep;
  catalog: StudioAction[];
  catalogById: Map<string, StudioAction>;
  connections: StudioConnection[];
  readOnly: boolean;
  onChange: (patch: Partial<StudioStep>) => void;
  onDelete: () => void;
}) {
  const action = step.actionId ? catalogById.get(step.actionId) : undefined;
  const fields = action?.paramsJsonSchema ? fieldsFromJsonSchema(action.paramsJsonSchema) : [];

  return (
    <div className="space-y-4">
      {!readOnly && (
        <TextInput
          label="Label (optional)"
          value={step.name ?? ''}
          placeholder="e.g. Fetch the PO header"
          onChange={(e) => onChange({ name: e.target.value })}
        />
      )}

      {step.kind === 'action' && (
        <>
          <div>
            <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
              Action
            </span>
            {readOnly ? (
              <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                {action ? action.title : step.actionId ?? '—'}
              </p>
            ) : (
              <select
                value={step.actionId ?? ''}
                onChange={(e) => onChange({ actionId: e.target.value || undefined, params: {} })}
                className="w-full rounded-md px-2 py-1.5 text-sm bg-transparent"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                aria-label="Action"
              >
                <option value="">Choose an action…</option>
                {catalog.map((a) => (
                  <option key={a.id} value={a.id} disabled={!a.supported}>
                    {a.title}
                    {!a.supported ? ' (unsupported)' : ''}
                  </option>
                ))}
              </select>
            )}
            {action && (
              <div className="mt-1.5 flex items-center gap-1.5">
                {action.destructive && <Badge tone="red">destructive</Badge>}
                {!action.supported && (
                  <Badge tone="amber" title={action.supportReason ?? 'Not supported'}>
                    unsupported
                  </Badge>
                )}
                {action.operation && (
                  <span className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>
                    {action.operation.method} {action.operation.path}
                  </span>
                )}
              </div>
            )}
            {action && !action.supported && action.supportReason && (
              <p className="mt-1.5 text-xs" style={{ color: '#d9aa68' }}>
                {action.supportReason}
              </p>
            )}
          </div>

          <div>
            <span className="block text-xs font-medium mb-1" style={{ color: 'var(--foreground)' }}>
              Connection
            </span>
            {readOnly ? (
              <p className="text-sm" style={{ color: 'var(--muted-foreground)' }}>
                {connections.find((c) => c.id === step.connectionId)?.name ?? '—'}
              </p>
            ) : connections.length > 0 ? (
              <select
                value={step.connectionId ?? connections[0]?.id ?? ''}
                onChange={(e) => onChange({ connectionId: e.target.value })}
                className="w-full rounded-md px-2 py-1.5 text-sm bg-transparent"
                style={{ border: '1px solid var(--border)', color: 'var(--foreground)' }}
                aria-label="Connection"
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.environment})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                No connections yet — create one under Connections to test steps.
              </p>
            )}
          </div>

          {action && fields.length > 0 && (
            <div className="space-y-3">
              <SectionLabel>Parameters</SectionLabel>
              {fields.map((field) => (
                <ParamFieldInput
                  key={field.name}
                  field={field}
                  value={step.params?.[field.name]}
                  readOnly={readOnly}
                  onChange={(value) => {
                    const params = { ...(step.params ?? {}) };
                    if (value === undefined) delete params[field.name];
                    else params[field.name] = value;
                    onChange({ params });
                  }}
                />
              ))}
            </div>
          )}
          {action && fields.length === 0 && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              This action takes no parameters.
            </p>
          )}
          {!action && (
            <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              Choose an action above to configure its parameters.
            </p>
          )}
        </>
      )}

      {step.kind === 'condition' && (
        <TextArea
          label="Condition expression"
          value={step.expression ?? ''}
          placeholder="e.g. steps[0].total > 1000"
          readOnly={readOnly}
          mono
          onChange={(expression) => onChange({ expression })}
        />
      )}

      {step.kind === 'verify' && (
        <TextArea
          label="Expected outcome"
          value={step.expectation ?? ''}
          placeholder="e.g. the item record exists at the site"
          readOnly={readOnly}
          onChange={(expectation) => onChange({ expectation })}
        />
      )}

      {step.kind === 'log' && (
        <TextArea
          label="Message"
          value={step.message ?? ''}
          placeholder="e.g. Checked POs at {{now}}"
          readOnly={readOnly}
          onChange={(message) => onChange({ message })}
        />
      )}

      {!readOnly && (
        <div className="pt-2" style={{ borderTop: '1px solid var(--border)' }}>
          <Button variant="danger" size="sm" onClick={onDelete}>
            Delete step
          </Button>
        </div>
      )}
    </div>
  );
}
