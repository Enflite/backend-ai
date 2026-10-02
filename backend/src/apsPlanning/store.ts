/**
 * store.ts — Mongo persistence for the `aps_analyses` collection (one
 * document per APS Planning Agent analysis intake). Tenant-scoped
 * everywhere: every filter carries { tenantId } (no RLS in MongoDB,
 * ADR-014).
 *
 * Deliberately narrow: the sibling owns the `aps_issues` store
 * (snapshots, issue lifecycle) — this module stores only what the
 * sibling lacks: analysis intake records (upload → flow-run linkage →
 * column-map confirmation). See docs/aps-planning-agent/contracts.md.
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo.js';
import type { AuthContext } from '../authz/permissions.js';
import type { AnalysisStatus, ApsAnalysisDoc } from './types.js';

export interface CreateAnalysisRecord {
  exportType: 'EXCEPTION_REPORT';
  sourceDocumentIds: string[];
  site?: string;
}

export async function createAnalysis(
  auth: AuthContext,
  record: CreateAnalysisRecord,
): Promise<ApsAnalysisDoc> {
  const now = new Date();
  const doc: ApsAnalysisDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    requesterUserId: auth.userId,
    exportType: record.exportType,
    sourceDocumentIds: record.sourceDocumentIds,
    ...(record.site ? { site: record.site } : {}),
    status: 'intake',
    createdAt: now,
    updatedAt: now,
  };
  const db = await getDb();
  await db.collection<ApsAnalysisDoc>('aps_analyses').insertOne(doc);
  return doc;
}

export async function getAnalysis(tenantId: string, id: string): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOne({ _id: id, tenantId });
}

/**
 * Listing: requesters see their own analyses; callers with
 * `tenant:manage` see the tenant's. Status filter and limit optional.
 */
export async function listAnalyses(
  tenantId: string,
  requesterUserId: string,
  isAdmin: boolean,
  options: { status?: AnalysisStatus; limit?: number } = {},
): Promise<ApsAnalysisDoc[]> {
  const db = await getDb();
  const filter: Record<string, unknown> = { tenantId };
  if (!isAdmin) filter.requesterUserId = requesterUserId;
  if (options.status) filter.status = options.status;
  return db
    .collection<ApsAnalysisDoc>('aps_analyses')
    .find(filter)
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 20)
    .toArray();
}

export async function setAnalysisFlowRun(
  tenantId: string,
  id: string,
  update: {
    status: AnalysisStatus;
    statusNote?: string;
    flowName?: string;
    flowRunId?: string;
    issueId?: string;
    baselineSnapshotId?: string;
  },
): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  const $set: Record<string, unknown> = { status: update.status, updatedAt: new Date() };
  if (update.statusNote !== undefined) $set.statusNote = update.statusNote;
  if (update.flowName !== undefined) $set.flowName = update.flowName;
  if (update.flowRunId !== undefined) $set.flowRunId = update.flowRunId;
  if (update.issueId !== undefined) $set.issueId = update.issueId;
  if (update.baselineSnapshotId !== undefined) $set.baselineSnapshotId = update.baselineSnapshotId;
  return db
    .collection<ApsAnalysisDoc>('aps_analyses')
    .findOneAndUpdate({ _id: id, tenantId }, { $set }, { returnDocument: 'after' });
}

export async function setAnalysisColumnMap(
  tenantId: string,
  id: string,
  columns: Record<string, string>,
  confirmed: boolean,
): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOneAndUpdate(
    { _id: id, tenantId },
    {
      $set: {
        columnMap: { columns, confirmed, confirmedAt: new Date() },
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}

/**
 * Atomically claim a `pending-substrate` analysis for retry: transitions
 * pending-substrate → analyzing with the internal `retryInFlight` marker.
 * Returns null when the analysis is not in pending-substrate — i.e. the
 * caller lost a concurrent retry race and must NOT start a second flow
 * run (idempotency lives here).
 */
export async function claimPendingSubstrateRetry(
  tenantId: string,
  id: string,
): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOneAndUpdate(
    { _id: id, tenantId, status: 'pending-substrate' },
    {
      $set: {
        status: 'analyzing',
        statusNote: 'Retry: invoking the aps-exception-analysis pipeline.',
        retryInFlight: true,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}

/**
 * Release a retry claim when the substrate start failed: the analysis
 * goes back to `pending-substrate` honestly — the pipeline never ran.
 * Guarded by the claim marker so a claim that already progressed is
 * never clobbered.
 */
export async function releaseRetryClaim(
  tenantId: string,
  id: string,
  statusNote: string,
): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOneAndUpdate(
    { _id: id, tenantId, status: 'analyzing', retryInFlight: true },
    {
      $set: {
        status: 'pending-substrate',
        statusNote,
        retryInFlight: false,
        updatedAt: new Date(),
      },
    },
    { returnDocument: 'after' },
  );
}

/**
 * Record the flow run after a successful retry start. The status is
 * left untouched (the claim already moved it to `analyzing`).
 */
export async function setAnalysisFlowRunIds(
  tenantId: string,
  id: string,
  ids: { flowName: string; flowRunId: string; statusNote?: string },
): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  const $set: Record<string, unknown> = {
    flowName: ids.flowName,
    flowRunId: ids.flowRunId,
    retryInFlight: false,
    updatedAt: new Date(),
  };
  if (ids.statusNote !== undefined) $set.statusNote = ids.statusNote;
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOneAndUpdate(
    { _id: id, tenantId },
    { $set },
    { returnDocument: 'after' },
  );
}

/**
 * Cancel an analysis: only from a non-terminal status. A cancelled
 * analysis never drives a flow run — callers check the status before
 * invoking the substrate.
 */
export async function cancelAnalysis(tenantId: string, id: string): Promise<ApsAnalysisDoc | null> {
  const db = await getDb();
  return db.collection<ApsAnalysisDoc>('aps_analyses').findOneAndUpdate(
    {
      _id: id,
      tenantId,
      status: { $nin: ['resolved', 'still-open', 'blocked', 'cancelled'] },
    },
    { $set: { status: 'cancelled', updatedAt: new Date() } },
    { returnDocument: 'after' },
  );
}
