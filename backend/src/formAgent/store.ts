/**
 * store.ts — Mongo persistence for the `form_customizations` collection
 * (one document per SyteLine Form AI Agent flow run). Tenant-scoped
 * everywhere: every filter carries { tenantId } (no RLS in MongoDB,
 * ADR-014).
 */

import { getDb } from '../db/mongo.js';
import type { AuthContext } from '../authz/permissions.js';
import {
  type CustomizationAuthSnapshot,
  type CustomizationResult,
  type FlowStepLog,
  type FormCustomizationDoc,
  type FormCustomizationStatus,
  TERMINAL_FORM_CUSTOMIZATION_STATUSES,
} from './types.js';
import type { FlowStepOutcome } from './flowRunner.js';

export function snapshotCustomizationRequester(auth: AuthContext): CustomizationAuthSnapshot {
  return {
    userId: auth.userId,
    tenantId: auth.tenantId,
    email: auth.email,
    displayName: auth.displayName,
    clearance: auth.clearance,
    roleId: auth.roleId,
    roleName: auth.roleName,
    permissions: [...auth.permissions],
  };
}

export interface CreateCustomizationRecord {
  _id: string;
  formName: string;
  title: string;
  requestedBy?: string;
  instructions: string[];
  flowName: string;
  flowVersion: string;
  inboxDir: string;
  projectDir: string;
  repo: string;
  hasPrdOriginal: boolean;
  inlineNormalized: boolean;
  attachmentNames: string[];
  intakeOutcome: FlowStepOutcome;
}

export async function createCustomization(
  auth: AuthContext,
  record: CreateCustomizationRecord,
): Promise<FormCustomizationDoc> {
  const now = new Date();
  const doc: FormCustomizationDoc = {
    _id: record._id,
    tenantId: auth.tenantId,
    requesterUserId: auth.userId,
    requestedBy: record.requestedBy,
    formName: record.formName,
    title: record.title,
    instructions: record.instructions,
    status: 'requested',
    flowName: record.flowName,
    flowVersion: record.flowVersion,
    inboxDir: record.inboxDir,
    projectDir: record.projectDir,
    repo: record.repo,
    hasPrdOriginal: record.hasPrdOriginal,
    inlineNormalized: record.inlineNormalized,
    attachmentNames: record.attachmentNames,
    plan: null,
    steps: [
      {
        name: record.intakeOutcome.name,
        status: record.intakeOutcome.status === 'done' ? 'done' : 'failed',
        startedAt: new Date(record.intakeOutcome.startedAt),
        completedAt: new Date(record.intakeOutcome.completedAt),
        detail: record.intakeOutcome.detail,
      },
    ],
    authSnapshot: snapshotCustomizationRequester(auth),
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.collection<FormCustomizationDoc>('form_customizations').insertOne(doc);
  return doc;
}

export async function getCustomization(
  tenantId: string,
  id: string,
): Promise<FormCustomizationDoc | null> {
  const db = await getDb();
  return db
    .collection<FormCustomizationDoc>('form_customizations')
    .findOne({ _id: id, tenantId });
}

/**
 * Listing: admins (tenant:manage) see the tenant's requests; everyone
 * else sees only their own. Status filter and limit are optional.
 */
export async function listCustomizations(
  tenantId: string,
  requesterUserId: string,
  isAdmin: boolean,
  options: { status?: FormCustomizationStatus; limit?: number } = {},
): Promise<FormCustomizationDoc[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = { tenantId };
  if (!isAdmin) filter.requesterUserId = requesterUserId;
  if (options.status) filter.status = options.status;
  return db
    .collection<FormCustomizationDoc>('form_customizations')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 20)
    .toArray();
}

/**
 * Atomic claim: `requested` -> `in_progress` in a single findOneAndUpdate,
 * so concurrent backends (multi-instance deployments) can never double-run
 * the same request. Returns the claimed doc, or null when another runner won.
 */
export async function claimCustomization(
  tenantId: string,
  id: string,
  runnerId: string,
): Promise<FormCustomizationDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<FormCustomizationDoc>('form_customizations').findOneAndUpdate(
    { _id: id, tenantId, status: 'requested' },
    {
      $set: {
        status: 'in_progress',
        runnerId,
        startedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
}

/** Append a flow step outcome to the run's progress log. */
export async function appendStepOutcome(
  tenantId: string,
  id: string,
  outcome: FlowStepOutcome,
): Promise<void> {
  const db = await getDb();
  const step: FlowStepLog = {
    name: outcome.name,
    // A blocked step is recorded as failed in the log; the run-level
    // blockedReason carries the enumerated code.
    status: outcome.status === 'done' ? 'done' : 'failed',
    startedAt: new Date(outcome.startedAt),
    completedAt: new Date(outcome.completedAt),
    detail: outcome.detail ?? outcome.blockedCode,
  };
  await db.collection<FormCustomizationDoc>('form_customizations').updateOne(
    { _id: id, tenantId },
    { $push: { steps: step }, $set: { updatedAt: new Date() } },
  );
}

export async function saveCustomizationPlan(
  tenantId: string,
  id: string,
  plan: unknown,
): Promise<void> {
  const db = await getDb();
  await db.collection<FormCustomizationDoc>('form_customizations').updateOne(
    { _id: id, tenantId },
    { $set: { plan, updatedAt: new Date() } },
  );
}

export async function completeCustomization(
  tenantId: string,
  id: string,
  result: CustomizationResult,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  // Guarded: only an `in_progress` run may complete. One cancelled (or
  // otherwise moved) mid-run keeps its newer state — the runner must
  // never silently resurrect a cancelled run.
  const res = await db.collection<FormCustomizationDoc>('form_customizations').updateOne(
    { _id: id, tenantId, status: 'in_progress' },
    {
      $set: {
        status: 'awaiting_review',
        result,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function blockCustomization(
  tenantId: string,
  id: string,
  blockedReason: string,
  blockedDetail: string,
): Promise<boolean> {
  const db = await getDb();
  const now = new Date();
  // Same guard as completeCustomization: never overwrite a newer terminal state.
  const res = await db.collection<FormCustomizationDoc>('form_customizations').updateOne(
    { _id: id, tenantId, status: 'in_progress' },
    {
      $set: {
        status: 'blocked',
        blockedReason,
        blockedDetail,
        completedAt: now,
        updatedAt: now,
      },
    },
  );
  return res.matchedCount === 1;
}

export async function cancelCustomization(
  tenantId: string,
  id: string,
): Promise<FormCustomizationDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<FormCustomizationDoc>('form_customizations').findOneAndUpdate(
    {
      _id: id,
      tenantId,
      status: { $nin: [...TERMINAL_FORM_CUSTOMIZATION_STATUSES] },
    },
    { $set: { status: 'cancelled', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
}

/**
 * Record a human's merge of the review PR: `awaiting_review` → `completed`.
 * Only a human records this (the merge-marker endpoint); the agent has no
 * merge capability and never calls it.
 */
export async function markCustomizationMerged(
  tenantId: string,
  id: string,
): Promise<FormCustomizationDoc | null> {
  const db = await getDb();
  const now = new Date();
  return db.collection<FormCustomizationDoc>('form_customizations').findOneAndUpdate(
    { _id: id, tenantId, status: 'awaiting_review' },
    { $set: { status: 'completed', completedAt: now, updatedAt: now } },
    { returnDocument: 'after' },
  );
}

/** Oldest `requested` runs first, bounded per sweep. */
export async function findRequestedCustomizations(
  limit: number,
): Promise<FormCustomizationDoc[]> {
  const db = await getDb();
  return db
    .collection<FormCustomizationDoc>('form_customizations')
    .find({ status: 'requested' })
    .sort({ createdAt: 1 })
    .limit(limit)
    .toArray();
}
