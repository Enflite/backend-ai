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
import type { StudioAction, StudioConnection } from './types';

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
