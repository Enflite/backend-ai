/**
 * explain.ts — plain-language explanation of a Studio automation (Wave 3).
 *
 * Fully deterministic: every sentence is DERIVED from the automation's
 * stored definition and the real action catalog. No model, no invented
 * steps. Destructive steps get a prominent warning section describing
 * exactly what the deploy gate requires.
 */

import { getCatalogAction } from '../catalog/catalog.js';
import { destructiveStepsOf } from '../automations/store.js';
import type { AutomationStep, AutomationTrigger, StudioAutomationDoc } from '../automations/types.js';

export interface ExplainedStep {
  stepId: string;
  kind: AutomationStep['kind'];
  text: string;
}

export interface DestructiveWarning {
  stepId: string;
  actionId: string;
  title: string;
  warning: string;
}

export interface AutomationExplanation {
  automationId: string;
  title: string;
  summary: string;
  trigger: { kind: AutomationTrigger['kind']; text: string };
  steps: ExplainedStep[];
  destructive: DestructiveWarning[];
}

function actionTitle(actionId: string): string {
  return getCatalogAction(actionId)?.title ?? actionId;
}

function paramsText(params: Record<string, unknown>): string {
  const keys = Object.keys(params);
  if (keys.length === 0) return 'no parameters';
  return keys
    .map((k) => {
      const v = params[k];
      return `${k}=${typeof v === 'string' ? v : JSON.stringify(v) ?? '?'}`;
    })
    .join(', ');
}

function explainStep(step: AutomationStep, index: number): ExplainedStep {
  const label = `Step ${index + 1} (${step.id})`;
  switch (step.kind) {
    case 'action': {
      const destructive = getCatalogAction(step.actionId)?.destructive === true;
      return {
        stepId: step.id,
        kind: step.kind,
        text: `${label} runs the action "${actionTitle(step.actionId)}" (${step.actionId}) against connection "${step.connectionId}" with ${paramsText(step.params)}.${destructive ? ' This action is DESTRUCTIVE — it can change SyteLine data.' : ''}`,
      };
    }
    case 'condition':
      return {
        stepId: step.id,
        kind: step.kind,
        text: `${label} branches on the expression "${step.when}": when it holds, the run continues at step "${step.then}"; otherwise it continues at step "${step.else}".`,
      };
    case 'verify': {
      const assertions = step.assertions
        .map((a) => `"${a.path}" ${a.operator} "${a.value}"`)
        .join(' and ');
      return {
        stepId: step.id,
        kind: step.kind,
        text: `${label} re-fetches using "${actionTitle(step.actionId)}" (${step.actionId}) against connection "${step.connectionId}" with ${paramsText(step.params)}, then requires ${assertions}. A failed assertion blocks the run.`,
      };
    }
    case 'log':
      return {
        stepId: step.id,
        kind: step.kind,
        text: `${label} writes "${step.message}" to the audit log.`,
      };
  }
}

function explainTrigger(trigger: AutomationTrigger): { kind: AutomationTrigger['kind']; text: string } {
  switch (trigger.kind) {
    case 'manual':
      return { kind: trigger.kind, text: 'It runs on demand, when you press Run.' };
    case 'scheduled':
      return {
        kind: trigger.kind,
        text: `It runs on the schedule "${trigger.cron}" (${trigger.timezone}).`,
      };
    case 'webhook':
      return { kind: trigger.kind, text: 'It runs when its webhook URL receives a POST request.' };
    case 'event':
      return {
        kind: trigger.kind,
        text: `It watches "${trigger.actionId}" (poll-based: checks "${trigger.pollCron}", ${trigger.timezone}) and runs when the watched value changes.`,
      };
  }
}

/**
 * Derive a plain-language explanation from the stored automation doc.
 * Pure function of the definition + catalog — it cannot describe steps
 * that are not in the definition.
 */
export function explainAutomation(doc: StudioAutomationDoc): AutomationExplanation {
  const trigger = explainTrigger(doc.trigger);
  const steps = doc.steps.map((step, i) => explainStep(step, i));
  const destructiveWarnings: DestructiveWarning[] = destructiveStepsOf(doc.steps).map((d) => ({
    stepId: d.stepId,
    actionId: d.actionId,
    title: d.title,
    warning:
      `Step "${d.stepId}" uses the destructive action "${d.title}" (${d.actionId}). ` +
      'Destructive steps are skipped in dry-runs, never run silently, and this automation ' +
      'cannot be deployed until a human explicitly confirms with confirmDestructive.',
  }));
  const summary = destructiveWarnings.length
    ? `This automation "${doc.title}" has ${doc.steps.length} step(s) including ${destructiveWarnings.length} destructive one(s). ${trigger.text}`
    : `This automation "${doc.title}" has ${doc.steps.length} step(s) and no destructive steps. ${trigger.text}`;
  return {
    automationId: doc._id,
    title: doc.title,
    summary,
    trigger,
    steps,
    destructive: destructiveWarnings,
  };
}
