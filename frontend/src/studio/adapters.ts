/**
 * studio/adapters.ts — backend automation views <-> frontend builder model.
 *
 * The backend serves the bare `AutomationPublicView` (lists as `{ items }`);
 * the builder canvas works with the looser `StudioAutomation` / `StudioStep`
 * shapes. These adapters convert losslessly in both directions:
 * backend-structured fields (`when`/`then`/`else`, `assertions`,
 * `retries`, trigger details) ride through on the frontend objects so a
 * save never drops what the canvas can't edit.
 *
 * Frontend->backend throws a descriptive Error when a hand-authored step or
 * trigger can't be expressed honestly (a condition with no branch targets,
 * a verify with no assertions, an event trigger with no watch config) —
 * the builder surfaces that in its banner instead of inventing values.
 */
import type {
  StudioAutomation,
  StudioAutomationSummary,
  StudioStep,
  StudioStepKind,
  StudioTrigger,
  StudioVerifyAssertion,
} from './types';

/* Backend wire shapes (subset of AutomationPublicView we consume). */

interface BackendTrigger {
  kind: string;
  cron?: string;
  timezone?: string;
  inputs?: Record<string, unknown>;
  actionId?: string;
  connectionId?: string;
  params?: Record<string, unknown>;
  watchPath?: string;
  pollCron?: string;
}

interface BackendStep {
  id: string;
  kind: StudioStepKind;
  actionId?: string;
  connectionId?: string;
  params?: Record<string, unknown>;
  retries?: number;
  continueOnError?: boolean;
  when?: string;
  then?: string;
  else?: string;
  assertions?: StudioVerifyAssertion[];
  message?: string;
}

export interface BackendAutomationView {
  id: string;
  name: string;
  title: string;
  description?: string;
  status: string;
  trigger: BackendTrigger;
  steps: BackendStep[];
  destructiveSteps?: { stepId: string; actionId: string; title: string }[];
  deployment?: {
    status: 'never' | 'deployed' | 'undeployed';
    flowName?: string;
    deployedAt?: string;
    deployedBy?: string;
  };
  createdAt: string;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isBackendAutomationView(value: unknown): value is BackendAutomationView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.title === 'string' &&
    isRecord(value.trigger) &&
    Array.isArray(value.steps)
  );
}

/* ---------------- backend -> frontend ---------------- */

function adaptTrigger(trigger: BackendTrigger): StudioTrigger {
  const base: StudioTrigger = {
    kind: (['manual', 'scheduled', 'webhook', 'event'] as const).includes(trigger.kind as never)
      ? (trigger.kind as StudioTrigger['kind'])
      : 'manual',
  };
  if (typeof trigger.cron === 'string') base.cron = trigger.cron;
  if (typeof trigger.timezone === 'string') base.timezone = trigger.timezone;
  if (isRecord(trigger.inputs)) base.inputs = trigger.inputs as Record<string, unknown>;
  if (typeof trigger.actionId === 'string') base.actionId = trigger.actionId;
  if (typeof trigger.connectionId === 'string') base.connectionId = trigger.connectionId;
  if (isRecord(trigger.params)) base.params = trigger.params as Record<string, unknown>;
  if (typeof trigger.watchPath === 'string') base.watchPath = trigger.watchPath;
  if (typeof trigger.pollCron === 'string') base.pollCron = trigger.pollCron;
  if (base.kind === 'event' && base.actionId) {
    base.event = `Watches ${base.actionId} for changes${base.pollCron ? ` (poll ${base.pollCron})` : ''}`;
  }
  return base;
}

function adaptStep(step: BackendStep): StudioStep {
  switch (step.kind) {
    case 'action':
      return {
        id: step.id,
        kind: 'action',
        actionId: step.actionId,
        connectionId: step.connectionId,
        params: step.params,
        retries: step.retries,
        continueOnError: step.continueOnError,
      };
    case 'condition':
      return {
        id: step.id,
        kind: 'condition',
        when: step.when,
        then: step.then,
        else: step.else,
        expression: step.when,
      };
    case 'verify':
      return {
        id: step.id,
        kind: 'verify',
        actionId: step.actionId,
        connectionId: step.connectionId,
        params: step.params,
        assertions: step.assertions,
        expectation: step.assertions
          ?.map((a) => `${a.path} ${a.operator} '${a.value}'`)
          .join(' and '),
      };
    case 'log':
      return { id: step.id, kind: 'log', message: step.message };
  }
}

export function adaptAutomationSummary(view: BackendAutomationView): StudioAutomationSummary {
  return {
    id: view.id,
    name: view.name,
    title: view.title,
    status: view.status,
    triggerKind: adaptTrigger(view.trigger).kind,
    updatedAt: view.updatedAt,
    lastRunAt: null,
  };
}

export function adaptAutomation(view: BackendAutomationView): StudioAutomation {
  const deployment = view.deployment;
  return {
    ...adaptAutomationSummary(view),
    description: view.description ?? '',
    trigger: adaptTrigger(view.trigger),
    steps: view.steps.map(adaptStep),
    deployment:
      deployment && deployment.status !== 'never'
        ? {
            deployed: deployment.status === 'deployed',
            deployedAt: deployment.deployedAt,
            deployedBy: deployment.deployedBy,
          }
        : null,
    destructiveSteps: view.destructiveSteps ?? [],
  };
}

/* ---------------- frontend -> backend (save) ---------------- */

function stepProblem(stepId: string, what: string): Error {
  return new Error(`Step "${stepId}" can't be saved: ${what}.`);
}

/** Serialize one canvas step to the backend automation schema. */
export function toBackendStep(step: StudioStep, steps: StudioStep[]): Record<string, unknown> {
  switch (step.kind) {
    case 'action': {
      if (!step.actionId) throw stepProblem(step.id, 'pick a catalog action first');
      return {
        id: step.id,
        kind: 'action',
        actionId: step.actionId,
        connectionId: step.connectionId ?? 'default',
        params: step.params ?? {},
        retries: step.retries ?? 0,
        continueOnError: step.continueOnError ?? false,
      };
    }
    case 'condition': {
      const when = step.when ?? step.expression ?? '';
      if (!when.trim()) throw stepProblem(step.id, 'it needs a condition expression');
      // The canvas is linear: without explicit branch targets both branches
      // continue at the next card (or the previous one for a trailing card).
      const index = steps.findIndex((s) => s.id === step.id);
      const fallback = steps[index + 1]?.id ?? steps[index - 1]?.id;
      const then = step.then ?? fallback;
      const elseTarget = step.else ?? fallback;
      if (!then || !elseTarget) {
        throw stepProblem(step.id, 'a lone condition step has no branch target — add another step first');
      }
      return { id: step.id, kind: 'condition', when, then, else: elseTarget };
    }
    case 'verify': {
      if (!step.actionId) throw stepProblem(step.id, 'pick a catalog action to verify with');
      const assertions = step.assertions;
      if (!assertions || assertions.length === 0) {
        throw stepProblem(
          step.id,
          'it needs at least one field assertion (generate one with AI or add it via the API)',
        );
      }
      return {
        id: step.id,
        kind: 'verify',
        actionId: step.actionId,
        connectionId: step.connectionId ?? 'default',
        params: step.params ?? {},
        assertions,
      };
    }
    case 'log': {
      const message = step.message ?? '';
      if (!message.trim()) throw stepProblem(step.id, 'it needs a log message');
      return { id: step.id, kind: 'log', message };
    }
  }
}

/** Serialize the canvas trigger to the backend trigger schema. */
export function toBackendTrigger(trigger: StudioTrigger): Record<string, unknown> {
  switch (trigger.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'scheduled': {
      if (!trigger.cron?.trim()) {
        throw new Error("The scheduled trigger needs a cron expression before it can be saved.");
      }
      return {
        kind: 'scheduled',
        cron: trigger.cron.trim(),
        timezone: trigger.timezone ?? 'UTC',
        inputs: trigger.inputs ?? {},
      };
    }
    case 'webhook':
      return { kind: 'webhook' };
    case 'event': {
      if (!trigger.actionId || !trigger.connectionId || !trigger.pollCron || !trigger.timezone) {
        throw new Error(
          'The event trigger needs a watched action, connection, poll schedule, and timezone — generate it with AI or use the API.',
        );
      }
      return {
        kind: 'event',
        actionId: trigger.actionId,
        connectionId: trigger.connectionId,
        params: trigger.params ?? {},
        watchPath: trigger.watchPath ?? '',
        pollCron: trigger.pollCron,
        timezone: trigger.timezone,
      };
    }
  }
}

/** The PATCH /studio/automations/:id body for a canvas draft. */
export function toBackendDraft(automation: Pick<StudioAutomation, 'name' | 'title' | 'description' | 'trigger' | 'steps'>): {
  name: string;
  title: string;
  description: string;
  trigger: Record<string, unknown>;
  steps: Record<string, unknown>[];
} {
  return {
    name: automation.name,
    title: automation.title,
    description: automation.description ?? '',
    trigger: toBackendTrigger(automation.trigger),
    steps: automation.steps.map((s) => toBackendStep(s, automation.steps)),
  };
}
