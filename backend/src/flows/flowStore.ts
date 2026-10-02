/**
 * flowStore.ts — Mongo persistence for the `flows` and `flow_runs`
 * collections (ADR-022). Tenant-scoped everywhere: every filter carries
 * { tenantId } (no RLS in MongoDB, ADR-014).
 *
 * A flow document carries a mutable validated `draft`, an immutable
 * `versions` array (append-only; each entry is the frozen definition a
 * run executes), a `liveVersion` alias, and a `revision` counter that
 * guards alias changes (If-Match → 412 on mismatch).
 */

import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../db/mongo.js';
import type { AuthContext } from '../authz/permissions.js';
import { AppError, Errors } from '../errors.js';
import {
  type FlowAuthSnapshot,
  type FlowDefinition,
  type FlowDoc,
  type FlowRunDoc,
  type FlowRunStatus,
  type FlowVersionEntry,
  flowDefinitionSchema,
  TERMINAL_FLOW_RUN_STATUSES,
} from './flowTypes.js';

export function snapshotRequesterAuth(
  auth: AuthContext,
  classification: string,
): FlowAuthSnapshot {
  return {
    userId: auth.userId,
    tenantId: auth.tenantId,
    email: auth.email,
    displayName: auth.displayName,
    clearance: auth.clearance,
    roleId: auth.roleId,
    roleName: auth.roleName,
    permissions: [...auth.permissions],
    classification,
  };
}

/** Canonical JSON (sorted keys) so the sha256 is stable across key order. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, val]) => `${JSON.stringify(key)}:${canonicalize(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** sha256 of the canonical definition JSON (change detection). */
export function definitionHash(definition: FlowDefinition): string {
  return createHash('sha256').update(canonicalize(definition)).digest('hex');
}

/** Parse a flow definition, mapping Zod failures to 400 INVALID_FLOW_DEFINITION. */
function parseDefinition(definition: unknown): FlowDefinition {
  try {
    return flowDefinitionSchema.parse(definition);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues.slice(0, 3).map((issue) => issue.message).join('; ');
      throw Errors.badRequest('INVALID_FLOW_DEFINITION', `Invalid flow definition: ${first}`);
    }
    throw error;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return canonicalize(a) === canonicalize(b);
}

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------

export async function createFlow(
  auth: AuthContext,
  definition: unknown,
): Promise<FlowDoc> {
  const parsed = parseDefinition(definition);
  const now = new Date();
  const doc: FlowDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    name: parsed.name,
    draft: parsed,
    draftUpdatedAt: now,
    draftUpdatedBy: auth.userId,
    revision: 1,
    liveVersion: null,
    versions: [],
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  try {
    await db.collection<FlowDoc>('flows').insertOne(doc);
  } catch (error: unknown) {
    if (isDuplicateKey(error)) {
      throw Errors.conflict('FLOW_ALREADY_EXISTS', `Flow "${parsed.name}" already exists`);
    }
    throw error;
  }
  return doc;
}

export async function getFlow(tenantId: string, name: string): Promise<FlowDoc | null> {
  const db = await getDb();
  return db.collection<FlowDoc>('flows').findOne({ name, tenantId });
}

export async function listFlows(tenantId: string): Promise<FlowDoc[]> {
  const db = await getDb();
  return db
    .collection<FlowDoc>('flows')
    .find({ tenantId })
    .sort({ name: 1 })
    .limit(200)
    .toArray();
}

export async function updateFlowDraft(
  tenantId: string,
  name: string,
  definition: unknown,
  updatedBy: string,
): Promise<FlowDoc> {
  const parsed = parseDefinition(definition);
  if (parsed.name !== name) {
    throw Errors.badRequest(
      'FLOW_NAME_MISMATCH',
      'Draft definition name must match the flow being updated',
    );
  }
  const db = await getDb();
  const now = new Date();
  const doc = await db.collection<FlowDoc>('flows').findOneAndUpdate(
    { name, tenantId },
    {
      $set: {
        draft: parsed,
        draftUpdatedAt: now,
        draftUpdatedBy: updatedBy,
        updatedAt: now,
      },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!doc) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  return doc;
}

export async function deleteFlow(tenantId: string, name: string): Promise<void> {
  const db = await getDb();
  const res = await db.collection<FlowDoc>('flows').deleteOne({ name, tenantId });
  if (res.deletedCount === 0) {
    throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  }
  // Run history is kept: flow_runs outlive their flow for auditability.
}

/**
 * Publish the current draft as a new immutable version. The version entry
 * freezes the validated definition + its sha256 so runs always execute a
 * byte-stable artifact. Returns the updated flow and the new entry.
 */
export async function publishVersion(
  tenantId: string,
  name: string,
  publishedBy: string,
): Promise<{ flow: FlowDoc; version: FlowVersionEntry }> {
  const db = await getDb();
  const flow = await getFlow(tenantId, name);
  if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  const definition = parseDefinition(flow.draft);
  const nextVersion = flow.versions.length + 1;
  const entry: FlowVersionEntry = {
    version: nextVersion,
    definition,
    definitionHash: definitionHash(definition),
    publishedBy,
    publishedAt: new Date(),
  };
  const updated = await db.collection<FlowDoc>('flows').findOneAndUpdate(
    { name, tenantId },
    {
      $push: { versions: entry },
      $set: { updatedAt: new Date() },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!updated) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  return { flow: updated, version: entry };
}

export async function listVersions(
  tenantId: string,
  name: string,
): Promise<FlowVersionEntry[]> {
  const flow = await getFlow(tenantId, name);
  if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  return flow.versions;
}

export async function getVersion(
  tenantId: string,
  name: string,
  version: number,
): Promise<FlowVersionEntry | null> {
  const flow = await getFlow(tenantId, name);
  return flow?.versions.find((v) => v.version === version) ?? null;
}

/**
 * Point the `live` alias at a published version. If-Match guarded by the
 * flow's revision counter: a stale expectedRevision fails with 412
 * REVISION_MISMATCH so two publishers cannot silently race the alias.
 */
export async function setLiveAlias(
  tenantId: string,
  name: string,
  version: number,
  expectedRevision: number,
): Promise<FlowDoc> {
  const db = await getDb();
  const flow = await getFlow(tenantId, name);
  if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${name}" not found`);
  if (!flow.versions.some((v) => v.version === version)) {
    throw Errors.notFound('FLOW_VERSION_NOT_FOUND', `Flow "${name}" has no version ${version}`);
  }
  const updated = await db.collection<FlowDoc>('flows').findOneAndUpdate(
    { name, tenantId, revision: expectedRevision },
    {
      $set: { liveVersion: version, updatedAt: new Date() },
      $inc: { revision: 1 },
    },
    { returnDocument: 'after' },
  );
  if (!updated) {
    // The revision guard lost the race (or, vanishingly rarely, the flow
    // was deleted between the read and the update — report the mismatch).
    throw new AppError(
      412,
      'REVISION_MISMATCH',
      `Flow "${name}" changed since revision ${expectedRevision}; re-read and retry`,
    );
  }
  return updated;
}

/** Resolve the live alias to its frozen definition. */
export async function getLiveDefinition(
  tenantId: string,
  name: string,
): Promise<{ version: number; definition: FlowDefinition } | null> {
  const flow = await getFlow(tenantId, name);
  if (!flow || flow.liveVersion === null) return null;
  const entry = flow.versions.find((v) => v.version === flow.liveVersion);
  if (!entry) return null;
  return { version: entry.version, definition: entry.definition };
}

// ---------------------------------------------------------------------------
// Flow runs
// ---------------------------------------------------------------------------

function isDuplicateKey(error: unknown): boolean {
  const e = error as { code?: unknown };
  return e?.code === 11000;
}

export interface CreateRunOptions {
  inputs?: Record<string, unknown>;
  confirmWrites?: boolean;
  idempotencyKey?: string;
  /** Explicit version; defaults to the live alias. */
  version?: number;
  /**
   * Create the run already claimed by this runner (status `running`).
   * Used by drivers that create a run they immediately execute in-process
   * (e.g. the SyteLine Form AI Agent): the run never sits `queued` where
   * the generic sweep could claim it.
   */
  claimBy?: string;
  /** Schedule that fired this run (set by the schedules platform). */
  scheduleRef?: { scheduleId: string; scheduleName: string };
}

/**
 * Create a run against a frozen version (explicit or live). The steps log
 * is initialized from that version's definition; the runner executes the
 * frozen definition, never the mutable draft.
 *
 * Idempotency: when idempotencyKey is supplied it is unique per
 * (tenant, key). Repeating the same key with the same flow and inputs
 * returns the existing run; the same key with a different flow or
 * different inputs is a 409 IDEMPOTENCY_KEY_CONFLICT.
 */
export async function createRun(
  auth: AuthContext,
  flowName: string,
  options: CreateRunOptions,
  classification: string,
): Promise<{ run: FlowRunDoc; duplicate: boolean }> {
  const db = await getDb();
  const runs = db.collection<FlowRunDoc>('flow_runs');

  if (options.idempotencyKey) {
    const existing = await runs.findOne({
      tenantId: auth.tenantId,
      idempotencyKey: options.idempotencyKey,
    });
    if (existing) {
      if (existing.flowName === flowName && deepEqual(existing.inputs, options.inputs)) {
        return { run: existing, duplicate: true };
      }
      throw Errors.conflict(
        'IDEMPOTENCY_KEY_CONFLICT',
        'Idempotency key was already used for a different flow or inputs',
      );
    }
  }

  let resolvedVersion: number;
  let definition: FlowDefinition;
  if (options.version !== undefined) {
    const entry = await getVersion(auth.tenantId, flowName, options.version);
    if (!entry) {
      throw Errors.notFound(
        'FLOW_VERSION_NOT_FOUND',
        `Flow "${flowName}" has no version ${options.version}`,
      );
    }
    resolvedVersion = entry.version;
    definition = entry.definition;
  } else {
    const live = await getLiveDefinition(auth.tenantId, flowName);
    if (!live) {
      const flow = await getFlow(auth.tenantId, flowName);
      if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', `Flow "${flowName}" not found`);
      throw Errors.badRequest(
        'NO_LIVE_VERSION',
        `Flow "${flowName}" has no live version; publish one first`,
      );
    }
    resolvedVersion = live.version;
    definition = live.definition;
  }

  const now = new Date();
  const doc: FlowRunDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    flowName,
    flowVersion: resolvedVersion,
    status: options.claimBy ? 'running' : 'queued',
    inputs: options.inputs ?? {},
    steps: definition.steps.map((step) => ({
      stepId: step.id,
      kind: step.kind,
      status: 'pending' as const,
    })),
    idempotencyKey: options.idempotencyKey,
    confirmWrites: options.confirmWrites ?? false,
    scheduleRef: options.scheduleRef,
    requestedBy: snapshotRequesterAuth(auth, classification),
    createdAt: now,
    updatedAt: now,
    ...(options.claimBy ? { runnerId: options.claimBy } : {}),
  };
  try {
    await runs.insertOne(doc);
  } catch (error: unknown) {
    if (isDuplicateKey(error) && options.idempotencyKey) {
      // Lost a race with a concurrent identical create: re-read and apply
      // the same duplicate/conflict logic.
      return createRun(auth, flowName, options, classification);
    }
    throw error;
  }
  return { run: doc, duplicate: false };
}

/**
 * Atomic claim: `queued` -> `running` in a single findOneAndUpdate, so
 * concurrent backends never double-run the same flow run.
 */
export async function claimRun(
  tenantId: string,
  runId: string,
  runnerId: string,
): Promise<FlowRunDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<FlowRunDoc>('flow_runs').findOneAndUpdate(
    { _id: runId, tenantId, status: 'queued' },
    {
      $set: {
        status: 'running',
        runnerId,
        startedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
}

export async function updateRunStep(
  tenantId: string,
  runId: string,
  index: number,
  patch: Partial<FlowRunDoc['steps'][number]>,
): Promise<void> {
  const db = await getDb();
  const set: Record<string, unknown> = { updatedAt: new Date() };
  for (const [key, value] of Object.entries(patch)) {
    set[`steps.${index}.${key}`] = value;
  }
  await db
    .collection<FlowRunDoc>('flow_runs')
    .updateOne({ _id: runId, tenantId }, { $set: set });
}

export async function completeRun(
  tenantId: string,
  runId: string,
  resultSummary: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  // Guarded: only a `running` run may complete. A run cancelled mid-run
  // keeps its newer state — the runner must never resurrect it.
  const res = await db.collection<FlowRunDoc>('flow_runs').updateOne(
    { _id: runId, tenantId, status: 'running' },
    {
      $set: {
        status: 'completed',
        resultSummary,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function blockRun(
  tenantId: string,
  runId: string,
  blockedReason: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  const res = await db.collection<FlowRunDoc>('flow_runs').updateOne(
    { _id: runId, tenantId, status: 'running' },
    {
      $set: {
        status: 'blocked',
        blockedReason,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function cancelRun(
  tenantId: string,
  runId: string,
): Promise<FlowRunDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<FlowRunDoc>('flow_runs').findOneAndUpdate(
    {
      _id: runId,
      tenantId,
      status: { $nin: [...TERMINAL_FLOW_RUN_STATUSES] },
    },
    { $set: { status: 'cancelled', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
}

export async function getRun(tenantId: string, runId: string): Promise<FlowRunDoc | null> {
  const db = await getDb();
  return db.collection<FlowRunDoc>('flow_runs').findOne({ _id: runId, tenantId });
}

/** Board listing: admins (tenant:manage) see the tenant's runs; everyone else sees only their own. */
export async function listRuns(
  tenantId: string,
  requesterUserId: string,
  isAdmin: boolean,
  filter: { flowName?: string; status?: FlowRunStatus; limit: number },
): Promise<FlowRunDoc[]> {
  const db = await getDb();
  const query: Record<string, unknown> = { tenantId };
  if (!isAdmin) query['requestedBy.userId'] = requesterUserId;
  if (filter.flowName) query.flowName = filter.flowName;
  if (filter.status) query.status = filter.status;
  return db
    .collection<FlowRunDoc>('flow_runs')
    .find(query)
    .sort({ createdAt: -1 })
    .limit(filter.limit)
    .toArray();
}

/** Oldest `queued` runs first, bounded per sweep. Cross-tenant by design:
 *  the scheduler is global; each run carries its own tenantId. */
export async function findQueuedRuns(limit: number): Promise<FlowRunDoc[]> {
  const db = await getDb();
  return db
    .collection<FlowRunDoc>('flow_runs')
    .find({ status: 'queued' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}

/** Guard: a run may be viewed/cancelled by its requester or an admin. */
export function assertRunVisible(
  run: FlowRunDoc,
  requesterUserId: string,
  isAdmin: boolean,
): void {
  if (run.requestedBy.userId !== requesterUserId && !isAdmin) {
    throw Errors.notFound('FLOW_RUN_NOT_FOUND', 'Flow run not found');
  }
}
