/**
 * studio/api.ts — Automation Studio REST client.
 *
 * Dedicated product endpoints (backend slice in flight):
 *   GET /api/v1/studio/connections   tenant connections with capability flags
 *   GET /api/v1/studio/actions       action catalog with support badges
 *
 * Unwrap the { connections } / { actions } envelopes and reject anything
 * that doesn't look like a list, so a half-landed backend fails loudly
 * instead of rendering invented shapes.
 */
import { api, ApiError } from '../api';
import {
  adaptAutomation,
  adaptAutomationSummary,
  isBackendAutomationView,
  toBackendDraft,
} from './adapters';
import type {
  StudioAction,
  StudioActionTestResult,
  StudioAiExplanation,
  StudioAiSuggestion,
  StudioAutomation,
  StudioAutomationSummary,
  StudioConnection,
  StudioRunDetail,
  StudioRunSummary,
  StudioStepTestResult,
} from './types';

const BASE = '/studio';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** The catalog endpoints are 404 until the backend slice lands. */
export function isStudioUnavailable(cause: unknown): boolean {
  return cause instanceof ApiError && cause.status === 404;
}

export async function listStudioConnections(): Promise<StudioConnection[]> {
  const body = await api.request<unknown>(`${BASE}/connections`);
  if (!isRecord(body) || !Array.isArray(body.connections)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio connections response was not in the expected shape.');
  }
  return body.connections as StudioConnection[];
}

export async function listStudioActions(): Promise<StudioAction[]> {
  const body = await api.request<unknown>(`${BASE}/actions`);
  if (!isRecord(body) || !Array.isArray(body.actions)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio action catalog response was not in the expected shape.');
  }
  return body.actions as StudioAction[];
}

/* ------------------------------------------------------------------ */
/* Automations + runs                                                */
/*                                                                     */
/* Real backend contract: lists arrive as { items: [...] }; single     */
/* resources arrive as the bare view (no envelope). Every getter        */
/* validates its envelope; callers use isStudioUnavailable to render    */
/* the honest "backend slice in flight" state on 404.                  */
/* ------------------------------------------------------------------ */

export async function listStudioAutomations(): Promise<StudioAutomationSummary[]> {
  const body = await api.request<unknown>(`${BASE}/automations`);
  if (!isRecord(body) || !Array.isArray(body.items)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automations response was not in the expected shape.');
  }
  return (body.items as unknown[]).map((item) => {
    if (!isBackendAutomationView(item)) {
      throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation item was not in the expected shape.');
    }
    return adaptAutomationSummary(item);
  });
}

export async function getStudioAutomation(id: string): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}`);
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation response was not in the expected shape.');
  }
  return adaptAutomation(body);
}

/** Create a draft automation (used by flows that create server-side, e.g. AI generation). */
export async function createStudioAutomation(
  draft: Pick<StudioAutomation, 'name' | 'title' | 'description' | 'trigger' | 'steps'>,
): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations`, {
    method: 'POST',
    body: JSON.stringify(toBackendDraft(draft)),
  });
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation create response was not in the expected shape.');
  }
  return adaptAutomation(body);
}

/** Save a draft: name, title, description, trigger, steps. */
export async function saveStudioAutomation(
  id: string,
  draft: Pick<StudioAutomation, 'name' | 'title' | 'description' | 'trigger' | 'steps'>,
): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(toBackendDraft(draft)),
  });
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation save response was not in the expected shape.');
  }
  return adaptAutomation(body);
}

/** Delete an automation (tears down triggers and studio-managed flows first). */
export async function deleteStudioAutomation(id: string): Promise<void> {
  await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

function isDryRunReport(body: unknown): body is { steps: unknown[] } {
  return isRecord(body) && Array.isArray(body.steps);
}

/** Dry-run: per-step results come back only from the real backend. */
export async function testStudioAutomation(id: string): Promise<StudioStepTestResult[]> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isDryRunReport(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation test response was not in the expected shape.');
  }
  return body.steps.map((raw) => {
    const s = raw as Record<string, unknown>;
    const status = s.status === 'ok' || s.status === 'failed' || s.status === 'skipped' ? s.status : 'failed';
    return {
      stepId: String(s.stepId ?? ''),
      status,
      skipped: s.skipped === true,
      request: s.request,
      response: s.response,
      durationMs: typeof s.durationMs === 'number' ? s.durationMs : undefined,
      error: typeof s.error === 'string' ? s.error : undefined,
    } satisfies StudioStepTestResult;
  });
}

/** Deploy. The caller must surface the destructive-confirmation UI first:
 *  this client only sends confirmDestructive: true when told to. A webhook
 *  URL issued at deploy is merged onto the trigger for display. */
export async function deployStudioAutomation(id: string, confirmDestructive: boolean): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/deploy`, {
    method: 'POST',
    body: JSON.stringify({ confirmDestructive }),
  });
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation deploy response was not in the expected shape.');
  }
  const automation = adaptAutomation(body);
  const webhookUrl =
    isRecord(body) && typeof body.webhookUrl === 'string' ? body.webhookUrl : undefined;
  if (webhookUrl) automation.trigger = { ...automation.trigger, webhookUrl };
  return automation;
}

export async function undeployStudioAutomation(id: string): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/undeploy`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation undeploy response was not in the expected shape.');
  }
  return adaptAutomation(body);
}

/* ------------------------------------------------------------------ */
/* AI generation (Wave 3)                                              */
/*                                                                     */
/*   POST /studio/automations/generate — NL prompt -> draft automation */
/*     (created server-side as `draft`; never deployed). The preview    */
/*     renders from the returned draft — nothing is invented client-    */
/*     side.                                                           */
/*   POST /studio/automations/:id/explain — deterministic explanation   */
/*   POST /studio/automations/:id/suggest — next-step suggestions       */
/* ------------------------------------------------------------------ */

/** Generate a draft automation from natural language. The backend creates
 *  the draft (status `draft`, never deployed); the caller renders the
 *  returned draft for review before anything else happens. */
export async function generateStudioAutomation(
  prompt: string,
  connectionId?: string,
): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/generate`, {
    method: 'POST',
    body: JSON.stringify(connectionId ? { prompt, connectionId } : { prompt }),
  });
  if (!isBackendAutomationView(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation generate response was not in the expected shape.');
  }
  return adaptAutomation(body);
}

function isAiExplanation(body: unknown): body is StudioAiExplanation {
  return (
    isRecord(body) &&
    typeof body.automationId === 'string' &&
    typeof body.summary === 'string' &&
    Array.isArray(body.steps) &&
    Array.isArray(body.destructive)
  );
}

/** Plain-language explanation of what the automation will do, derived
 *  from its stored definition. Never invents steps. */
export async function explainStudioAutomation(id: string): Promise<StudioAiExplanation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/explain`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isAiExplanation(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation explain response was not in the expected shape.');
  }
  return body;
}

function isAiSuggestionList(body: unknown): body is { suggestions: StudioAiSuggestion[] } {
  return isRecord(body) && Array.isArray(body.suggestions);
}

/** 1–3 catalog-grounded next-step suggestions. Returned only — the caller
 *  inserts them explicitly; nothing is applied automatically. */
export async function suggestStudioAutomationSteps(id: string): Promise<StudioAiSuggestion[]> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/suggest`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isAiSuggestionList(body)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation suggest response was not in the expected shape.');
  }
  return body.suggestions;
}

export async function listStudioRuns(): Promise<StudioRunSummary[]> {
  const body = await api.request<unknown>(`${BASE}/runs`);
  if (!isRecord(body) || !Array.isArray(body.runs)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio runs response was not in the expected shape.');
  }
  return body.runs as StudioRunSummary[];
}

export async function getStudioRun(id: string): Promise<StudioRunDetail> {
  const body = await api.request<unknown>(`${BASE}/runs/${encodeURIComponent(id)}`);
  if (!isRecord(body) || !isRecord(body.run)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio run response was not in the expected shape.');
  }
  return body.run as unknown as StudioRunDetail;
}

/* ------------------------------------------------------------------ */
/* Single-action test (live since Wave 1)                              */
/*                                                                     */
/* Powers per-step testing for action steps: the request runs against  */
/* the real upstream through the real connection. Returns the raw      */
/* result view (not wrapped in an envelope).                           */
/* ------------------------------------------------------------------ */

export async function testStudioAction(
  connectionId: string,
  actionId: string,
  params: Record<string, unknown>,
): Promise<StudioActionTestResult> {
  const body = await api.request<unknown>(`${BASE}/actions/test`, {
    method: 'POST',
    body: JSON.stringify({ connectionId, actionId, params }),
  });
  if (!isRecord(body) || !isRecord(body.request) || !isRecord(body.response)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio action test response was not in the expected shape.');
  }
  return body as unknown as StudioActionTestResult;
}
