/**
 * studio/builder.ts — pure helpers for the automation builder canvas.
 *
 * All step-graph edits are immutable and DOM-free so they're unit-testable:
 * create / reorder / duplicate / delete, step summaries, destructive-action
 * detection, and JSON-Schema → typed-input field descriptors for the step
 * editor. Nothing here touches the network or invents backend data.
 */
import type {
  StudioAction,
  StudioActionTestResult,
  StudioStep,
  StudioStepKind,
  StudioStepTestResult,
  StudioTrigger,
} from './types';

/** Client-side step ids; replaced by backend ids after the first save. */
export function newStepId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `step-${crypto.randomUUID()}`;
  }
  return `step-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Micro-label shown on every card, per Jake's builder spec. */
export function stepKindLabel(kind: StudioStepKind | 'trigger'): string {
  switch (kind) {
    case 'trigger':
      return 'TRIGGER';
    case 'action':
      return 'ACTION';
    case 'condition':
      return 'CONDITION';
    case 'verify':
      return 'VERIFY';
    case 'log':
      return 'LOG';
  }
}

export function createStep(kind: StudioStepKind, actionId?: string): StudioStep {
  const step: StudioStep = { id: newStepId(), kind, params: {} };
  if (kind === 'action' && actionId) step.actionId = actionId;
  return step;
}

/** Immutable reorder; dir is -1 (up) or +1 (down). No-op when out of bounds. */
export function moveStep(steps: StudioStep[], id: string, dir: -1 | 1): StudioStep[] {
  const index = steps.findIndex((s) => s.id === id);
  const target = index + dir;
  if (index < 0 || target < 0 || target >= steps.length) return steps;
  const next = [...steps];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Duplicate a step, inserting the copy directly after the original. */
export function duplicateStep(steps: StudioStep[], id: string): StudioStep[] {
  const index = steps.findIndex((s) => s.id === id);
  if (index < 0) return steps;
  const original = steps[index];
  const copy: StudioStep = {
    ...original,
    id: newStepId(),
    params: original.params ? { ...original.params } : undefined,
    name: original.name ? `${original.name} (copy)` : undefined,
  };
  const next = [...steps];
  next.splice(index + 1, 0, copy);
  return next;
}

/** Remove a step by id. */
export function removeStep(steps: StudioStep[], id: string): StudioStep[] {
  return steps.filter((s) => s.id !== id);
}

/** One-line summary of what the step does, for the card body. */
export function summarizeStep(step: StudioStep, action?: StudioAction): string {
  if (step.name) return step.name;
  switch (step.kind) {
    case 'action':
      return action ? action.title : 'Choose an action';
    case 'condition':
      return step.expression ? `If ${truncate(step.expression, 72)}` : 'If… (no condition set)';
    case 'verify':
      return step.expectation ? `Verify: ${truncate(step.expectation, 72)}` : 'Verify… (no expectation set)';
    case 'log':
      return step.message ? truncate(step.message, 90) : 'Log a message';
  }
}

/** Mono operation line under the summary, when the catalog binds one. */
export function stepOperation(step: StudioStep, action?: StudioAction): string | null {
  if (step.kind !== 'action') return null;
  if (action?.operation) return `${action.operation.method} ${action.operation.path}`;
  if (step.actionId) return step.actionId;
  return null;
}

export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface DestructiveStep {
  step: StudioStep;
  action: StudioAction;
}

/** Action steps whose catalog entry is flagged destructive. */
export function destructiveSteps(
  steps: StudioStep[],
  catalogById: Map<string, StudioAction>,
): DestructiveStep[] {
  const found: DestructiveStep[] = [];
  for (const step of steps) {
    if (step.kind !== 'action' || !step.actionId) continue;
    const action = catalogById.get(step.actionId);
    if (action?.destructive) found.push({ step, action });
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* JSON Schema → typed editor fields                                   */
/*                                                                     */
/* The catalog publishes each action's params as a JSON Schema object  */
/* (from its zod schema):                                              */
/*   { type: 'object', properties: { item: { type: 'string', ... } },  */
/*     required: ['item'] }                                            */
/* The editor renders text / number / boolean / select inputs from     */
/* these descriptors — simple typed inputs only, per the spec.         */
/* ------------------------------------------------------------------ */

export type ParamFieldType = 'text' | 'number' | 'boolean' | 'select';

export interface ParamField {
  name: string;
  type: ParamFieldType;
  required: boolean;
  description?: string;
  options?: string[];
  defaultValue?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function fieldTypeOf(schema: Record<string, unknown>): { type: ParamFieldType; options?: string[] } {
  if (Array.isArray(schema.enum) && schema.enum.every((v) => typeof v === 'string')) {
    return { type: 'select', options: schema.enum as string[] };
  }
  switch (schema.type) {
    case 'number':
    case 'integer':
      return { type: 'number' };
    case 'boolean':
      return { type: 'boolean' };
    default:
      return { type: 'text' };
  }
}

/** Flatten a JSON-Schema object into ordered editor field descriptors. */
export function fieldsFromJsonSchema(schema: unknown): ParamField[] {
  if (!isRecord(schema) || schema.type !== 'object') return [];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required)
    ? schema.required.filter((r): r is string => typeof r === 'string')
    : [];
  const fields: ParamField[] = [];
  for (const [name, raw] of Object.entries(properties)) {
    if (!isRecord(raw)) continue;
    const { type, options } = fieldTypeOf(raw);
    fields.push({
      name,
      type,
      required: required.includes(name),
      description: typeof raw.description === 'string' ? raw.description : undefined,
      options,
      defaultValue: 'default' in raw ? raw.default : undefined,
    });
  }
  return fields;
}

/** Coerce a raw input value to the field's type for the params payload. */
export function coerceParamValue(field: ParamField, raw: string | boolean): unknown {
  if (field.type === 'boolean') return raw === true || raw === 'true';
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (field.type === 'number') {
    const num = Number(trimmed);
    return Number.isFinite(num) ? num : undefined;
  }
  return raw;
}

/** Display value for an input: params value → string/boolean. */
export function paramInputValue(field: ParamField, value: unknown): string | boolean {
  if (field.type === 'boolean') return value === true;
  if (value === undefined || value === null) {
    return field.defaultValue !== undefined && field.defaultValue !== null
      ? String(field.defaultValue)
      : '';
  }
  return String(value);
}

/** One-line summary of the trigger config for the trigger card. */
export function summarizeTrigger(trigger: StudioTrigger): string {
  switch (trigger.kind) {
    case 'manual':
      return 'Runs when you press Test or Run';
    case 'scheduled':
      return trigger.cron ? `Cron: ${trigger.cron}` : 'No schedule set';
    case 'webhook':
      return trigger.webhookUrl ? `POST ${trigger.webhookUrl}` : 'Webhook URL issued on deploy';
    case 'event':
      return trigger.event ? truncate(trigger.event, 80) : 'No event described';
  }
}

/** Normalize a backend status string to one of Jake's filter buckets. */
export function automationStatusBucket(status: string): 'active' | 'draft' | 'failed' | 'scheduled' | 'other' {
  const s = status.toLowerCase();
  if (s === 'draft') return 'draft';
  if (s === 'failed') return 'failed';
  if (s === 'scheduled') return 'scheduled';
  if (s === 'active' || s === 'deployed' || s === 'enabled' || s === 'running') return 'active';
  return 'other';
}

/**
 * Convert a single-action test result (POST /studio/actions/test) into the
 * per-step result shape the canvas renders inline. 2xx → ok, anything else
 * → failed. Pure mapping — the data always comes from the real API.
 */
export function actionTestToStepResult(stepId: string, result: StudioActionTestResult): StudioStepTestResult {
  const status = result.response.status;
  const ok = status !== null && status >= 200 && status < 300;
  return {
    stepId,
    status: ok ? 'ok' : 'failed',
    request: result.request,
    response: result.response,
    durationMs: result.response.durationMs,
  };
}
