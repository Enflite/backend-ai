/**
 * issues.ts — Mongo persistence for the `aps_issues` collection backing the
 * APS exception-resolution flow (upload report → snapshot → verify →
 * close/re-analyze loop).
 *
 * Tenant isolation: every query is scoped by tenantId (no RLS in MongoDB,
 * ADR-014). The model never supplies the tenant — it comes from the caller's
 * auth context at the tool layer.
 *
 * Issue lifecycle:
 *   - recordSnapshot with an empty/missing issueId creates a new issue in
 *     'open' status and appends the first snapshot.
 *   - recordSnapshot with an existing issueId appends a snapshot; the issue
 *     must exist and still be open (ISSUE_NOT_FOUND / ISSUE_CLOSED).
 *   - closeIssue moves an issue to 'closed' (idempotent).
 *
 * Issue doc shape:
 *   { _id, tenantId, site, reportDocumentId, status: 'open' | 'closed',
 *     snapshots: [{ snapshotId, createdAt, issues, classifications?,
 *                   findings?, rootCause?, recommendation?, sytelineSteps? }],
 *     createdAt, updatedAt }
 */

import { randomUUID } from 'node:crypto';
import { getDb } from '../db/mongo.js';
import { Errors } from '../errors.js';

/** Lifecycle state of an APS issue. */
export type ApsIssueStatus = 'open' | 'closed';

/**
 * One pass of the exception pipeline over a report (or re-report). `issues`
 * is the normalized issue list; the remaining fields are the deterministic
 * and agent-produced analysis for that pass.
 */
export interface ApsSnapshot {
  snapshotId: string;
  createdAt: Date;
  /** Normalized exception rows this pass was computed from. */
  issues: unknown[];
  classifications?: unknown;
  findings?: unknown;
  rootCause?: unknown;
  recommendation?: unknown;
  sytelineSteps?: unknown;
}

/** Shape of the `aps_issues` MongoDB documents. `_id` is an app-generated UUID string (ADR-014). */
export interface ApsIssueDoc {
  _id: string;
  tenantId: string;
  site: string;
  reportDocumentId: string;
  status: ApsIssueStatus;
  snapshots: ApsSnapshot[];
  createdAt: Date;
  updatedAt: Date;
}

/** Input to recordSnapshot. */
export interface RecordSnapshotInput {
  /**
   * Empty or missing → create a new issue. Otherwise the snapshot is
   * appended to the open issue with this id (tenant-scoped).
   */
  issueId: string;
  reportDocumentId: string;
  site: string;
  issues: unknown[];
  classifications?: unknown;
  findings?: unknown;
  rootCause?: unknown;
  recommendation?: unknown;
  sytelineSteps?: unknown;
}

/** Compact rollup returned by recordSnapshot. */
export interface SnapshotSummary {
  /** Number of normalized exception rows in this snapshot. */
  issueCount: number;
  /** Total snapshots on the issue after this append. */
  snapshotCount: number;
  /** Finding count when `findings` was an array, else 0. */
  findingCount: number;
}

/** Count findings when the analysis was supplied as a flat array. */
function countFindings(findings: unknown): number {
  return Array.isArray(findings) ? findings.length : 0;
}

/** Build the snapshot record for this pass (ids generated here, never by the model). */
function buildSnapshot(input: RecordSnapshotInput): ApsSnapshot {
  return {
    snapshotId: randomUUID(),
    createdAt: new Date(),
    issues: input.issues,
    ...(input.classifications !== undefined ? { classifications: input.classifications } : {}),
    ...(input.findings !== undefined ? { findings: input.findings } : {}),
    ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
    ...(input.recommendation !== undefined ? { recommendation: input.recommendation } : {}),
    ...(input.sytelineSteps !== undefined ? { sytelineSteps: input.sytelineSteps } : {}),
  };
}

/**
 * Create a new issue (empty/missing issueId) or append a snapshot to an
 * existing open issue. Returns the issue id, the new snapshot id, and a
 * rollup summary.
 *
 * @throws ISSUE_NOT_FOUND when issueId is non-empty but no such issue exists
 *   for this tenant.
 * @throws ISSUE_CLOSED when the issue exists but is already closed — history
 *   is append-only on open issues; closed issues keep their final snapshot.
 */
export async function recordSnapshot(
  tenantId: string,
  input: RecordSnapshotInput,
): Promise<{ issueId: string; snapshotId: string; summary: SnapshotSummary }> {
  const db = await getDb();
  const collection = db.collection<ApsIssueDoc>('aps_issues');
  const now = new Date();
  const issueId = (input.issueId ?? '').trim();
  const snapshot = buildSnapshot(input);
  const summary: SnapshotSummary = {
    issueCount: input.issues.length,
    snapshotCount: 1,
    findingCount: countFindings(input.findings),
  };

  if (!issueId) {
    const doc: ApsIssueDoc = {
      _id: randomUUID(),
      tenantId,
      site: input.site,
      reportDocumentId: input.reportDocumentId,
      status: 'open',
      snapshots: [snapshot],
      createdAt: now,
      updatedAt: now,
    };
    await collection.insertOne(doc);
    return { issueId: doc._id, snapshotId: snapshot.snapshotId, summary };
  }

  const existing = await collection.findOne({ _id: issueId, tenantId });
  if (!existing) {
    throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
  }
  if (existing.status !== 'open') {
    throw Errors.conflict('ISSUE_CLOSED', 'APS issue is already closed; snapshots are append-only on open issues');
  }
  const snapshotCount = existing.snapshots.length + 1;
  await collection.updateOne(
    { _id: issueId, tenantId, status: 'open' },
    {
      $push: { snapshots: snapshot },
      $set: { updatedAt: now },
    },
  );
  summary.snapshotCount = snapshotCount;
  return { issueId, snapshotId: snapshot.snapshotId, summary };
}

/** Fetch an issue tenant-scoped. Returns null when not found (callers map to ISSUE_NOT_FOUND). */
export async function getIssue(tenantId: string, issueId: string): Promise<ApsIssueDoc | null> {
  const db = await getDb();
  return db.collection<ApsIssueDoc>('aps_issues').findOne({ _id: issueId, tenantId });
}

/** Fetch one snapshot of an issue, tenant-scoped. Returns null when the issue or snapshot is missing. */
export async function getSnapshot(
  tenantId: string,
  issueId: string,
  snapshotId: string,
): Promise<ApsSnapshot | null> {
  const issue = await getIssue(tenantId, issueId);
  return issue?.snapshots.find((snapshot) => snapshot.snapshotId === snapshotId) ?? null;
}

/**
 * Close an issue (status 'open' → 'closed'). Idempotent: closing an already
 * closed issue is a no-op that returns the issue unchanged.
 *
 * @throws ISSUE_NOT_FOUND when no such issue exists for this tenant.
 */
export async function closeIssue(tenantId: string, issueId: string): Promise<ApsIssueDoc> {
  const db = await getDb();
  const collection = db.collection<ApsIssueDoc>('aps_issues');
  const existing = await collection.findOne({ _id: issueId, tenantId });
  if (!existing) {
    throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
  }
  if (existing.status === 'open') {
    await collection.updateOne(
      { _id: issueId, tenantId, status: 'open' },
      { $set: { status: 'closed', updatedAt: new Date() } },
    );
    const updated = await collection.findOne({ _id: issueId, tenantId });
    if (updated) return updated;
  }
  return existing;
}
