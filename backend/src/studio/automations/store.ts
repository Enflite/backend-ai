/**
 * store.ts — Studio automation persistence (`studio_automations`) and
 * studio-scoped run/snapshot queries.
 *
 * Tenant-scoped everywhere (no RLS in MongoDB, ADR-014). Automation names
 * are unique per tenant (case-insensitive, like connections). The
 * `studio_snapshots` collection backs the poll-based event trigger's
 * change detection (see tools.ts `studio.snapshotCheck`).
 *
 * Webhook tokens are stored as sha256 hashes only — the raw token is
 * returned exactly once, in the deploy response that issues it, and never
 * persisted, logged, or returned again.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import type { AuthContext } from '../../authz/permissions.js';
import type { FlowRunDoc, FlowRunStatus } from '../../flows/flowTypes.js';
import { getCatalogAction } from '../catalog/catalog.js';
import {
  type AutomationDeployment,
  type AutomationPublicView,
  type CreateAutomationInput,
  type DestructiveStepInfo,
  type StudioAutomationDoc,
  type UpdateAutomationInput,
} from './types.js';

export const AUTOMATIONS_COLLECTION = 'studio_automations';
export const SNAPSHOTS_COLLECTION = 'studio_snapshots';

/** Deterministic flow name for an automation: `studio-<automationId>`. */
export function automationFlowName(automationId: string): string {
  return `studio-${automationId}`;
}

/** Watcher flow / schedule name for a poll-based event trigger. */
export function automationWatcherName(automationId: string): string {
  return `studio-${automationId}-watch`;
}

/** True when the flow name belongs to the Studio (automation or watcher). */
export function isStudioFlowName(flowName: string): boolean {
  return flowName.startsWith('studio-');
}

/** Extract the automation id from a studio flow name (or null). */
export function automationIdFromFlowName(flowName: string): string | null {
  if (!flowName.startsWith('studio-')) return null;
  const rest = flowName.slice('studio-'.length);
  if (rest.endsWith('-watch')) return rest.slice(0, -'-watch'.length);
  return rest;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Steps of an automation/doc that use a destructive catalog action. */
export function destructiveStepsOf(
  steps: StudioAutomationDoc['steps'],
): DestructiveStepInfo[] {
  const out: DestructiveStepInfo[] = [];
  for (const step of steps) {
    if (step.kind !== 'action' && step.kind !== 'verify') continue;
    const entry = getCatalogAction(step.actionId);
    if (entry?.destructive) {
      out.push({ stepId: step.id, actionId: entry.id, title: entry.title });
    }
  }
  return out;
}

export function toAutomationView(doc: StudioAutomationDoc): AutomationPublicView {
  const d = doc.deployment;
  return {
    id: doc._id,
    name: doc.name,
    title: doc.title,
    description: doc.description,
    status: doc.status,
    trigger: doc.trigger,
    steps: doc.steps,
    inputs: doc.inputs,
    destructiveSteps: destructiveStepsOf(doc.steps),
    deployment: {
      status: d.status,
      flowName: d.flowName,
      ...(d.flowVersion !== undefined ? { flowVersion: d.flowVersion } : {}),
      ...(d.triggerKind ? { triggerKind: d.triggerKind } : {}),
      ...(d.scheduleId ? { scheduleId: d.scheduleId } : {}),
      ...(d.scheduleName ? { scheduleName: d.scheduleName } : {}),
      ...(d.confirmWrites !== undefined ? { confirmWrites: d.confirmWrites } : {}),
      webhookConfigured: !!d.webhookTokenHash,
      ...(d.webhookTokenIssuedAt ? { webhookTokenIssuedAt: d.webhookTokenIssuedAt } : {}),
      ...(d.deployedAt ? { deployedAt: d.deployedAt.toISOString() } : {}),
      ...(d.deployedBy ? { deployedBy: d.deployedBy } : {}),
      ...(d.undeployedAt ? { undeployedAt: d.undeployedAt.toISOString() } : {}),
    },
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Automations CRUD
// ---------------------------------------------------------------------------

async function findByName(
  tenantId: string,
  name: string,
): Promise<StudioAutomationDoc | null> {
  const db = await getDb();
  return db
    .collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION)
    .findOne({
      tenantId,
      name: { $regex: `^${escapeRegex(name)}$`, $options: 'i' },
    });
}

export async function createAutomation(
  auth: AuthContext,
  input: CreateAutomationInput,
): Promise<StudioAutomationDoc> {
  const existing = await findByName(auth.tenantId, input.name);
  if (existing) {
    throw Errors.conflict(
      'STUDIO_AUTOMATION_NAME_TAKEN',
      `An automation named '${input.name}' already exists`,
    );
  }
  const id = randomUUID();
  const now = new Date();
  const doc: StudioAutomationDoc = {
    _id: id,
    tenantId: auth.tenantId,
    name: input.name,
    title: input.title,
    description: input.description,
    status: 'draft',
    trigger: input.trigger,
    steps: input.steps,
    inputs: input.inputs,
    deployment: { status: 'never', flowName: automationFlowName(id) },
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION).insertOne(doc);
  return doc;
}

export async function getAutomation(
  tenantId: string,
  id: string,
): Promise<StudioAutomationDoc | null> {
  const db = await getDb();
  return db
    .collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION)
    .findOne({ _id: id, tenantId });
}

export async function listAutomations(
  tenantId: string,
  filter: { status?: StudioAutomationDoc['status']; limit: number },
): Promise<StudioAutomationDoc[]> {
  const db = await getDb();
  const query: Record<string, unknown> = { tenantId };
  if (filter.status) query.status = filter.status;
  return db
    .collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION)
    .find(query)
    .sort({ updatedAt: -1 })
    .limit(filter.limit)
    .toArray();
}

export async function updateAutomation(
  tenantId: string,
  id: string,
  patch: UpdateAutomationInput,
  userId: string,
): Promise<StudioAutomationDoc> {
  const db = await getDb();
  const coll = db.collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION);
  const current = await coll.findOne({ _id: id, tenantId });
  if (!current) {
    throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  }
  if (patch.name !== undefined && patch.name !== current.name) {
    const clash = await findByName(tenantId, patch.name);
    if (clash && clash._id !== id) {
      throw Errors.conflict(
        'STUDIO_AUTOMATION_NAME_TAKEN',
        `An automation named '${patch.name}' already exists`,
      );
    }
  }
  const now = new Date();
  const res = await coll.updateOne(
    { _id: id, tenantId },
    {
      $set: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.trigger !== undefined ? { trigger: patch.trigger } : {}),
        ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
        ...(patch.inputs !== undefined ? { inputs: patch.inputs } : {}),
        // Editing a deployed automation returns it to draft: the edits
        // take effect on the next deploy, never silently on the live flow.
        ...(current.status === 'active' ? { status: 'draft' as const } : {}),
        updatedAt: now,
      },
    },
  );
  if (res.matchedCount === 0) {
    throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  }
  const updated = await coll.findOne({ _id: id, tenantId });
  if (!updated) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  return updated;
}

/** Replace the deployment record (deploy/undeploy bookkeeping). */
export async function setDeployment(
  tenantId: string,
  id: string,
  deployment: AutomationDeployment,
  status: StudioAutomationDoc['status'],
): Promise<StudioAutomationDoc> {
  const db = await getDb();
  const coll = db.collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION);
  const res = await coll.updateOne(
    { _id: id, tenantId },
    { $set: { deployment, status, updatedAt: new Date() } },
  );
  if (res.matchedCount === 0) {
    throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  }
  const updated = await coll.findOne({ _id: id, tenantId });
  if (!updated) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
  return updated;
}

export async function deleteAutomation(
  tenantId: string,
  id: string,
): Promise<StudioAutomationDoc | null> {
  const db = await getDb();
  const coll = db.collection<StudioAutomationDoc>(AUTOMATIONS_COLLECTION);
  const doc = await coll.findOne({ _id: id, tenantId });
  if (!doc) return null;
  await coll.deleteOne({ _id: id, tenantId });
  return doc;
}

// ---------------------------------------------------------------------------
// Studio runs (flow_runs filtered to studio flow names)
// ---------------------------------------------------------------------------

export interface StudioRunSummary {
  id: string;
  automationId: string | null;
  /** 'automation' for the automation's own flow, 'watcher' for an event
   *  trigger's generated watcher flow. */
  kind: 'automation' | 'watcher';
  flowName: string;
  flowVersion: number;
  status: FlowRunStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  resultSummary?: string;
  blockedReason?: string;
  scheduleRef?: { scheduleId: string; scheduleName: string };
}

function toRunSummary(run: FlowRunDoc): StudioRunSummary {
  const automationId = automationIdFromFlowName(run.flowName);
  return {
    id: run._id,
    automationId,
    kind: run.flowName.endsWith('-watch') ? 'watcher' : 'automation',
    flowName: run.flowName,
    flowVersion: run.flowVersion,
    status: run.status,
    createdAt: run.createdAt.toISOString(),
    ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
    ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    ...(run.resultSummary ? { resultSummary: run.resultSummary } : {}),
    ...(run.blockedReason ? { blockedReason: run.blockedReason } : {}),
    ...(run.scheduleRef ? { scheduleRef: run.scheduleRef } : {}),
  };
}

export async function listStudioRuns(
  tenantId: string,
  filter: { automationId?: string; status?: FlowRunStatus; limit: number },
): Promise<StudioRunSummary[]> {
  const db = await getDb();
  const query: Record<string, unknown> = {
    tenantId,
    flowName: { $regex: '^studio-' },
  };
  if (filter.automationId) {
    const id = filter.automationId;
    query.flowName = { $regex: `^studio-${escapeRegex(id)}(-watch)?$` };
  }
  if (filter.status) query.status = filter.status;
  const runs = await db
    .collection<FlowRunDoc>('flow_runs')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(filter.limit)
    .toArray();
  return runs.map(toRunSummary);
}

/** A studio run with its per-step log. Only studio flow runs are visible
 *  here (flowName prefix guard); anything else is a 404. */
export async function getStudioRun(
  tenantId: string,
  runId: string,
): Promise<(FlowRunDoc & { automationId: string | null; kind: 'automation' | 'watcher' }) | null> {
  const db = await getDb();
  const run = await db.collection<FlowRunDoc>('flow_runs').findOne({
    _id: runId,
    tenantId,
    flowName: { $regex: '^studio-' },
  });
  if (!run) return null;
  return {
    ...run,
    automationId: automationIdFromFlowName(run.flowName),
    kind: run.flowName.endsWith('-watch') ? 'watcher' : 'automation',
  };
}

// ---------------------------------------------------------------------------
// Snapshots (poll-based event trigger change detection)
// ---------------------------------------------------------------------------

export interface StudioSnapshotDoc {
  _id: string;
  tenantId: string;
  /** e.g. `studio:<automationId>:event`. */
  key: string;
  /** sha256 of the canonical watched value. */
  valueHash: string;
  /** Canonical JSON of the watched value, capped (never secrets-bearing
   *  beyond what the upstream returned for a read). */
  valueJson: string;
  updatedAt: Date;
}

/** Max canonical-JSON bytes persisted per snapshot; larger values persist
 *  hash-only (change detection still works; the preview is omitted). */
export const SNAPSHOT_VALUE_CAP = 64 * 1024;

export async function getSnapshot(
  tenantId: string,
  key: string,
): Promise<StudioSnapshotDoc | null> {
  const db = await getDb();
  return db
    .collection<StudioSnapshotDoc>(SNAPSHOTS_COLLECTION)
    .findOne({ tenantId, key });
}

export async function putSnapshot(
  tenantId: string,
  key: string,
  valueHash: string,
  valueJson: string,
): Promise<void> {
  const db = await getDb();
  const coll = db.collection<StudioSnapshotDoc>(SNAPSHOTS_COLLECTION);
  const existing = await coll.findOne({ tenantId, key });
  const now = new Date();
  if (existing) {
    await coll.updateOne(
      { _id: existing._id, tenantId },
      { $set: { valueHash, valueJson, updatedAt: now } },
    );
    return;
  }
  await coll.insertOne({
    _id: randomUUID(),
    tenantId,
    key,
    valueHash,
    valueJson,
    updatedAt: now,
  });
}
