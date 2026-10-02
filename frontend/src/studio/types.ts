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
  /** Operation the action binds to, when it binds to anything real. */
  operation?: { method: string; path: string };
  /** Param shape as JSON Schema (published by the backend from the zod schema). */
  paramsJsonSchema?: unknown;
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
/** Permission that unlocks test execution (dry-run / per-step test). */
export const STUDIO_RUN_PERMISSIONS = ['studio:run'];

/* ------------------------------------------------------------------ */
/* Automations (builder slice)                                         */
/*                                                                     */
/* Shapes mirror the builder contract:                                 */
/*   GET  /api/v1/studio/automations                                    */
/*   GET  /api/v1/studio/automations/:id                               */
/*   PUT  /api/v1/studio/automations/:id      (save draft)              */
/*   POST /api/v1/studio/automations/:id/test (dry-run)                */
/*   POST /api/v1/studio/automations/:id/deploy                        */
/*   POST /api/v1/studio/automations/:id/undeploy                       */
/* The backend builder slice is still in flight: every endpoint getter */
/* validates its envelope and the UI renders an honest "not available" */
/* state on 404 instead of inventing automations.                      */
/* ------------------------------------------------------------------ */

export type StudioTriggerKind = 'manual' | 'scheduled' | 'webhook' | 'event';

export interface StudioTrigger {
  kind: StudioTriggerKind;
  /** Kind-specific config: cron expression for scheduled, event description for event. */
  cron?: string;
  /** Backend-issued webhook URL; display only, never editable. */
  webhookUrl?: string;
  /** Human description of the event this automation listens for. */
  event?: string;
}

export type StudioStepKind = 'action' | 'condition' | 'verify' | 'log';

export interface StudioStep {
  id: string;
  kind: StudioStepKind;
  /** Optional operator label; falls back to the derived summary. */
  name?: string;
  /** Action steps: catalog action id + its params + the connection to test against. */
  actionId?: string;
  params?: Record<string, unknown>;
  connectionId?: string;
  /** Condition steps: expression to evaluate. */
  expression?: string;
  /** Verify steps: expected outcome the run checks. */
  expectation?: string;
  /** Log steps: message template. */
  message?: string;
}

export type StudioAutomationStatus = 'draft' | 'active' | 'failed' | 'scheduled' | string;

export interface StudioAutomationSummary {
  id: string;
  name: string;
  title: string;
  status: StudioAutomationStatus;
  triggerKind: StudioTriggerKind;
  updatedAt: string;
  lastRunAt?: string | null;
}

export interface StudioAutomation extends StudioAutomationSummary {
  description?: string;
  trigger: StudioTrigger;
  steps: StudioStep[];
  deployment?: {
    deployed: boolean;
    deployedAt?: string;
    deployedBy?: string;
  } | null;
}

/** Per-step result from POST /:id/test (dry-run). Rendered only from the real API. */
export interface StudioStepTestResult {
  stepId: string;
  status: 'ok' | 'failed' | 'skipped' | string;
  request?: unknown;
  response?: unknown;
  durationMs?: number;
  skipped?: boolean;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* Runs                                                                */
/* ------------------------------------------------------------------ */

export interface StudioRunSummary {
  id: string;
  automationId: string;
  automationName: string;
  status: 'ok' | 'failed' | 'running' | 'cancelled' | string;
  startedAt: string;
  finishedAt?: string | null;
  durationMs?: number;
  triggeredBy?: string;
}

export interface StudioRunStepResult {
  stepId: string;
  name?: string;
  kind?: StudioStepKind;
  status: 'ok' | 'failed' | 'skipped' | 'running' | string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  error?: string;
}

export interface StudioRunDetail extends StudioRunSummary {
  steps: StudioRunStepResult[];
  error?: string;
}

/** Single-action test result (POST /studio/actions/test — live, Wave 1). */
export interface StudioActionTestResult {
  request: {
    method: string;
    /** Token-free URL the test actually hit. */
    url: string;
    params: Record<string, unknown>;
  };
  response: {
    /** Upstream HTTP status, or null when the request never completed. */
    status: number | null;
    bodyTruncated: { truncated: boolean; preview: string };
    durationMs: number;
  };
  connectionId: string;
  actionId: string;
  executedAt: string;
}
