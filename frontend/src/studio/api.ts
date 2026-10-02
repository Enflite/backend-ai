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
import type {
  StudioAction,
  StudioActionTestResult,
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
/* Automations + runs (builder slice — 404 until the backend lands).    */
/*                                                                     */
/* Every getter validates its envelope; callers use isStudioUnavailable */
/* to render the honest "backend slice in flight" state.               */
/* ------------------------------------------------------------------ */

export async function listStudioAutomations(): Promise<StudioAutomationSummary[]> {
  const body = await api.request<unknown>(`${BASE}/automations`);
  if (!isRecord(body) || !Array.isArray(body.automations)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automations response was not in the expected shape.');
  }
  return body.automations as StudioAutomationSummary[];
}

export async function getStudioAutomation(id: string): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}`);
  if (!isRecord(body) || !isRecord(body.automation)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation response was not in the expected shape.');
  }
  return body.automation as unknown as StudioAutomation;
}

/** Save a draft: name, title, description, trigger, steps. */
export async function saveStudioAutomation(
  id: string,
  draft: Pick<StudioAutomation, 'name' | 'title' | 'description' | 'trigger' | 'steps'>,
): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify({ automation: draft }),
  });
  if (!isRecord(body) || !isRecord(body.automation)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation save response was not in the expected shape.');
  }
  return body.automation as unknown as StudioAutomation;
}

/** Dry-run: per-step results come back only from the real backend. */
export async function testStudioAutomation(id: string): Promise<StudioStepTestResult[]> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isRecord(body) || !Array.isArray(body.results)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation test response was not in the expected shape.');
  }
  return body.results as StudioStepTestResult[];
}

/** Deploy. The caller must surface the destructive-confirmation UI first:
 *  this client only sends confirmDestructive: true when told to. */
export async function deployStudioAutomation(id: string, confirmDestructive: boolean): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/deploy`, {
    method: 'POST',
    body: JSON.stringify({ confirmDestructive }),
  });
  if (!isRecord(body) || !isRecord(body.automation)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation deploy response was not in the expected shape.');
  }
  return body.automation as unknown as StudioAutomation;
}

export async function undeployStudioAutomation(id: string): Promise<StudioAutomation> {
  const body = await api.request<unknown>(`${BASE}/automations/${encodeURIComponent(id)}/undeploy`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  if (!isRecord(body) || !isRecord(body.automation)) {
    throw new ApiError(502, 'STUDIO_MALFORMED', 'Studio automation undeploy response was not in the expected shape.');
  }
  return body.automation as unknown as StudioAutomation;
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
