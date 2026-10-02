/**
 * suggest.ts — next-step suggestions for a Studio automation draft (Wave 3).
 *
 * Fully deterministic and grounded in the REAL action catalog: every
 * suggestion is a concrete, schema-valid AutomationStep built from catalog
 * entries — never invented actions, never invented procedures. Suggestions
 * are returned only; nothing is applied automatically.
 *
 * Heuristics (kept small and honest):
 * - empty draft        → up to 3 foundational non-destructive reads
 * - last step = action → verify that action, log its outcome, chain one
 *                        more non-destructive read not already used
 * - last step = verify/condition/log → a non-destructive read not already
 *                        used, a log step; plus a verify for the most recent
 *                        action when the draft has none yet
 * Suggested steps reuse the draft's most recent connection id ('default'
 * when the draft names none).
 */

import { ACTION_CATALOG } from '../catalog/catalog.js';
import type { AutomationStep, StudioAutomationDoc } from '../automations/types.js';

export interface StepSuggestion {
  /** Stable suggestion id (not a step id). */
  id: string;
  kind: AutomationStep['kind'];
  /** One-line operator label. */
  title: string;
  /** Why this step is a sensible next move. */
  reason: string;
  /** Concrete step JSON, ready to insert into the draft. */
  step: AutomationStep;
}

function freshStepId(existing: Set<string>, base: string): string {
  let id = base;
  let n = 1;
  while (existing.has(id)) {
    n += 1;
    id = `${base}-${n}`;
  }
  existing.add(id);
  return id;
}

/** Non-destructive catalog action ids, in catalog order. */
const READ_ACTIONS = ACTION_CATALOG.filter((a) => !a.destructive).map((a) => a.id);

function lastConnectionId(doc: StudioAutomationDoc): string {
  for (let i = doc.steps.length - 1; i >= 0; i--) {
    const step: AutomationStep | undefined = doc.steps[i];
    if (!step) continue;
    if ((step.kind === 'action' || step.kind === 'verify') && step.connectionId) {
      return step.connectionId;
    }
  }
  return 'default';
}

function usedActionIds(doc: StudioAutomationDoc): Set<string> {
  const used = new Set<string>();
  for (const step of doc.steps) {
    if (step.kind === 'action' || step.kind === 'verify') used.add(step.actionId);
  }
  return used;
}

function lastActionStep(doc: StudioAutomationDoc): Extract<AutomationStep, { kind: 'action' }> | null {
  for (let i = doc.steps.length - 1; i >= 0; i--) {
    const step: AutomationStep | undefined = doc.steps[i];
    if (step && step.kind === 'action') return step;
  }
  return null;
}

function actionTitleOf(actionId: string): string {
  return ACTION_CATALOG.find((a) => a.id === actionId)?.title ?? actionId;
}

/** Build the suggestion list for a draft. Pure function of the definition. */
export function suggestNextSteps(doc: StudioAutomationDoc): StepSuggestion[] {
  const out: StepSuggestion[] = [];
  const existingIds = new Set(doc.steps.map((s) => s.id));
  const connectionId = lastConnectionId(doc);
  const used = usedActionIds(doc);
  const id = (base: string) => freshStepId(existingIds, base);

  const pushActionSuggestion = (actionId: string, reason: string): void => {
    out.push({
      id: `suggestion-${out.length + 1}`,
      kind: 'action',
      title: `Read: ${actionTitleOf(actionId)}`,
      reason,
      step: {
        id: id('step-action'),
        kind: 'action',
        actionId,
        connectionId,
        params: {},
        retries: 0,
        continueOnError: false,
      },
    });
  };

  const pushLogSuggestion = (refId: string): void => {
    out.push({
      id: `suggestion-${out.length + 1}`,
      kind: 'log',
      title: 'Log the outcome',
      reason: `Writes the previous step's outcome to the audit log, so every run leaves a trace you can review in Logs.`,
      step: {
        id: id('step-log'),
        kind: 'log',
        message: `Completed step ${refId}: {{steps.${refId}.output.data}}`,
      },
    });
  };

  const pushVerifySuggestion = (source: Extract<AutomationStep, { kind: 'action' }>): void => {
    out.push({
      id: `suggestion-${out.length + 1}`,
      kind: 'verify',
      title: `Verify: ${actionTitleOf(source.actionId)}`,
      reason:
        `Re-fetches with "${actionTitleOf(source.actionId)}" and blocks the run when the assertion fails — ` +
        'edit the expected value to match what a healthy run should see.',
      step: {
        id: id('step-verify'),
        kind: 'verify',
        actionId: source.actionId,
        connectionId: source.connectionId,
        params: { ...source.params },
        assertions: [{ path: 'status', operator: '==', value: '<expected-status>' }],
      },
    });
  };

  const last = doc.steps[doc.steps.length - 1];

  if (!last) {
    // Empty draft: start with foundational reads.
    for (const actionId of READ_ACTIONS.slice(0, 3)) {
      pushActionSuggestion(
        actionId,
        `Start with a read: "${actionTitleOf(actionId)}" fetches real data you can branch on or verify later. Fill in its parameters in the step editor.`,
      );
    }
    return out;
  }

  if (last.kind === 'action') {
    pushVerifySuggestion(last);
    pushLogSuggestion(last.id);
    const next = READ_ACTIONS.find((a) => !used.has(a));
    if (next) {
      pushActionSuggestion(
        next,
        `Chain another read: "${actionTitleOf(next)}" hasn't been used in this draft yet and its output can feed a condition or a verify step.`,
      );
    }
    return out.slice(0, 3);
  }

  // verify / condition / log tail: offer an unused read, a log, and a
  // verify for the most recent action when the draft has none yet.
  const next = READ_ACTIONS.find((a) => !used.has(a));
  if (next) {
    pushActionSuggestion(
      next,
      `"${actionTitleOf(next)}" hasn't been used in this draft yet — add it to fetch more data before the next branch.`,
    );
  }
  pushLogSuggestion(last.id);
  const hasVerify = doc.steps.some((s) => s.kind === 'verify');
  const recent = lastActionStep(doc);
  if (!hasVerify && recent) {
    pushVerifySuggestion(recent);
  }
  return out.slice(0, 3);
}
