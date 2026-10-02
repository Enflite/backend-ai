/**
 * studio/types.ts — Automation Studio client types.
 *
 * Shapes mirror the backend's public views for /api/v1/studio/*
 * (connections, action catalog, action test — backend slice landing
 * alongside this frontend work). Nothing here is invented: fields come
 * from the contract; the UI never fabricates records from them.
 */

export interface StudioConnection {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  /** Capability flags keyed by capability name, e.g. { idoProbe: true }. */
  capabilities: Record<string, boolean>;
  updatedAt: string;
}

export interface StudioAction {
  id: string;
  title: string;
  description: string;
  /** The system/area the action runs against (used for grouping). */
  substrate: string;
  destructive: boolean;
  supported: boolean;
  /** Human-readable reason when supported=false. */
  supportReason?: string;
}

/** Known capability keys surfaced on connections; unknown keys render as-is. */
export const STUDIO_CAPABILITY_LABELS: Record<string, string> = {
  idoProbe: 'IDO metadata probe',
  runs: 'Run history',
  webhooks: 'Webhooks',
};

/** Permission required to see the whole studio section. */
export const STUDIO_VIEW_PERMISSIONS = ['studio:manage', 'studio:run'];
/** Permissions that unlock create/run affordances inside the studio. */
export const STUDIO_MANAGE_PERMISSIONS = ['studio:manage'];
