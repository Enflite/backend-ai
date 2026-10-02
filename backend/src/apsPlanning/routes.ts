/**
 * routes.ts — versioned REST API for the APS Planning Agent
 * (`/api/v1/aps/*`).
 *
 * V1 is READ-ONLY vs SyteLine: the product surface takes an APS
 * exception-report workbook, drives the sibling-owned
 * `aps-exception-analysis` / `aps-exception-verify` flows through the
 * Flows platform, and reports analyses, snapshots, and per-row compare
 * verdicts. The planner executes SyteLine steps by hand; nothing here
 * writes to SyteLine.
 *
 * Endpoints:
 * - POST   /aps/analyses                    intake (multipart workbook or JSON documentId) → 202
 * - GET    /aps/analyses                    list (requester sees own; tenant:manage sees tenant's)
 * - GET    /aps/analyses/:id                analysis detail (status refreshed from the flow run)
 * - POST   /aps/analyses/:id/column-map     confirm/override the workbook column mapping
 * - POST   /aps/analyses/:id/verify         trigger a verification run against a newer report
 * - POST   /aps/analyses/:id/cancel         cancel (ends work in flight)
 * - GET    /aps/snapshots                   list snapshots of one issue (?issueId=)
 * - GET    /aps/snapshots/:snapshotId       one snapshot (?issueId=)
 * - GET    /aps/snapshots/compare           per-row verdicts (?base=&other=[&issueId=])
 *
 * Access: auth + `aps:plan`, behind APS_PLANNING_ENABLED (default true —
 * V1 is read-only, no SyteLine writes; 403 FEATURE_DISABLED when off).
 *
 * Substrate honesty: the flow .json definitions ship in the repo, but
 * flows are tenant data — they must be published (live alias) on a tenant
 * before invocation works. Intake records the analysis either way; flow
 * invocation that hits an unpublished flow leaves the analysis in
 * `pending-substrate` (202, honest note) instead of failing the intake,
 * and substrate-dependent endpoints return 409 SUBSTRATE_UNAVAILABLE.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import type { AuthContext } from '../authz/permissions.js';
import { AppError, Errors } from '../errors.js';
import { config } from '../config.js';
import { recordAudit } from '../audit/audit.js';
import { getDb } from '../db/mongo.js';
import { intakeUploadedDocument } from '../documents/intake.js';
import { grantedDocumentIds } from '../documents/grants.js';
import {
  TERMINAL_ANALYSIS_STATUSES,
  analysisIdParamSchema,
  columnMapSchema,
  compareSnapshots,
  compareSnapshotsQuery,
  createAnalysisInput,
  listAnalysesQuery,
  planningRowSchema,
  productInfo,
  publicAnalysisDetailView,
  publicAnalysisListItem,
  snapshotIdParamSchema,
  snapshotsQuery,
  MAX_REPORT_PART_BYTES,
  type AnalysisStatus,
  type ApsAnalysisDoc,
  type PlanningRow,
} from './types.js';
import {
  cancelAnalysis,
  createAnalysis,
  getAnalysis,
  listAnalyses,
  setAnalysisColumnMap,
  setAnalysisFlowRun,
} from './store.js';
import {
  SubstrateUnavailableError,
  getSubstrateClient,
  substrateErrorToHttp,
  type InvokeFlowResult,
  type SubstrateIssue,
} from './substrate.js';

async function requireFeatureEnabled(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.APS_PLANNING_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'The APS Planning Agent is disabled (APS_PLANNING_ENABLED=false)',
    );
  }
}

/** tenant:manage sees the tenant's analyses; others see only their own. */
function isAnalysisAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

function validationError(message: string, details?: unknown): never {
  throw Errors.badRequest('VALIDATION_ERROR', message, details);
}

/** Guard: an analysis may be read by its requester or a tenant admin (403 otherwise). */
function assertAnalysisReadable(doc: ApsAnalysisDoc, requesterUserId: string, isAdmin: boolean): void {
  if (doc.requesterUserId !== requesterUserId && !isAdmin) {
    throw Errors.forbidden('FORBIDDEN', 'This APS analysis is not yours to read');
  }
}

/** Workbook-shaped uploads only: .xlsx / .xls / .csv. */
function assertWorkbookFile(filename: string, mimeType: string): void {
  const lower = filename.toLowerCase();
  const ok =
    lower.endsWith('.xlsx') ||
    lower.endsWith('.xls') ||
    lower.endsWith('.csv') ||
    mimeType.includes('spreadsheet') ||
    mimeType.includes('excel') ||
    mimeType === 'text/csv';
  if (!ok) {
    throw Errors.badRequest(
      'INVALID_REPORT_TYPE',
      'The exception report must be a workbook (.xlsx, .xls, or .csv)',
    );
  }
}

interface ReportDocument {
  _id: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  deletedAt?: Date | null;
}

/**
 * The referenced document exists, belongs to this tenant, is not deleted,
 * is a workbook, and the caller may read it (owner or an explicit grant —
 * the same rule as GET /documents/:id).
 */
async function resolveReportDocument(
  auth: AuthContext,
  documentId: string,
): Promise<ReportDocument> {
  const db = await getDb();
  const doc = await db.collection<ReportDocument>('documents').findOne({
    _id: documentId,
    tenantId: auth.tenantId,
    deletedAt: null,
  });
  if (!doc) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Exception report document not found');
  const grantedIds = await grantedDocumentIds(db, auth.tenantId, auth.userId, auth.roleId);
  if (doc.ownerId !== auth.userId && !grantedIds.includes(documentId)) {
    throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Exception report document not found');
  }
  assertWorkbookFile(doc.filename, doc.mimeType);
  return doc;
}

// ---------------------------------------------------------------------------
// Intake parsing: JSON or multipart, one shape
// ---------------------------------------------------------------------------

interface IntakeParts {
  documentId?: string;
  site?: string;
  issueId?: string;
  file?: { filename: string; data: Buffer };
  requestedClassification?: string;
}

async function parseIntakeBody(req: FastifyRequest): Promise<IntakeParts> {
  const contentType = String(req.headers['content-type'] ?? '');
  if (!contentType.includes('multipart/form-data')) {
    const parsed = createAnalysisInput.safeParse(req.body);
    if (!parsed.success) validationError('The analysis request is invalid', parsed.error.flatten());
    return {
      documentId: parsed.data.documentId,
      site: parsed.data.site,
      issueId: parsed.data.issueId,
    };
  }
  const fields: Record<string, string> = {};
  let file: { filename: string; data: Buffer } | undefined;
  try {
    const parts = (req as unknown as {
      parts: (options?: unknown) => AsyncIterableIterator<any>;
    }).parts({
      limits: { files: 1, fileSize: MAX_REPORT_PART_BYTES, fields: 6, parts: 8 },
    });
    for await (const part of parts) {
      if (part.file) {
        if (part.fieldname !== 'report') {
          throw new AppError(400, 'VALIDATION_ERROR', `Unexpected file part "${part.fieldname}" — use "report"`);
        }
        if (file) throw new AppError(400, 'VALIDATION_ERROR', 'Only one "report" file part is accepted');
        file = { filename: part.filename ?? 'report.xlsx', data: await part.toBuffer() };
      } else {
        fields[part.fieldname] = String(part.value ?? '');
      }
    }
  } catch (error) {
    if (error instanceof AppError) throw error;
    if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
      throw new AppError(413, 'PART_TOO_LARGE', 'The report file exceeds the 10 MB size limit');
    }
    throw error;
  }
  if (file && file.data.length > MAX_REPORT_PART_BYTES) {
    throw new AppError(413, 'PART_TOO_LARGE', 'The report file exceeds the 10 MB size limit');
  }
  const nonEmpty = (v: string | undefined): string | undefined =>
    v !== undefined && v.trim() !== '' ? v.trim() : undefined;
  return {
    documentId: nonEmpty(fields.documentId),
    site: nonEmpty(fields.site),
    issueId: nonEmpty(fields.issueId),
    requestedClassification: nonEmpty(fields.classification),
    ...(file ? { file } : {}),
  };
}

/**
 * Best-effort status refresh: when an analysis is mid-flight and its flow
 * run reached a terminal state, advance the analysis. Never throws —
 * substrate absence just leaves the status alone.
 */
async function refreshAnalysisFromRun(doc: ApsAnalysisDoc): Promise<ApsAnalysisDoc> {
  if (!doc.flowRunId || (doc.status !== 'analyzing' && doc.status !== 'verifying')) return doc;
  let runStatus: { status: string; outputs?: Record<string, unknown> } | null = null;
  try {
    runStatus = await getSubstrateClient().getFlowRunStatus(doc.tenantId, doc.flowRunId);
  } catch (error) {
    if (error instanceof SubstrateUnavailableError) return doc;
    throw error;
  }
  if (!runStatus) return doc;
  let next: AnalysisStatus | null = null;
  let patch: Record<string, unknown> = {};
  if (runStatus.status === 'completed') {
    const outputs = runStatus.outputs ?? {};
    const issueId = typeof outputs.issueId === 'string' ? outputs.issueId : undefined;
    const snapshotId = typeof outputs.snapshotId === 'string' ? outputs.snapshotId : undefined;
    next = 'awaiting-planner';
    patch = {
      ...(issueId ? { issueId } : {}),
      ...(snapshotId ? { baselineSnapshotId: snapshotId } : {}),
      statusNote: 'Pipeline run completed — the planner executes the SyteLine steps by hand, then verifies with a new report.',
    };
    if (doc.status === 'verifying') {
      // The verify flow reports resolved/closed in its outputs when present.
      const resolved = outputs.resolved;
      if (resolved === true) {
        next = 'resolved';
        patch.statusNote = 'Verification run resolved the issue.';
      } else if (resolved === false) {
        next = 'still-open';
        patch.statusNote = 'Verification run completed — the issue is still open.';
      }
    }
  } else if (runStatus.status === 'blocked' || runStatus.status === 'cancelled') {
    next = 'blocked';
    patch = { statusNote: `Pipeline run ${runStatus.status} — see the flow run for the blocked reason.` };
  }
  if (!next) return doc;
  const updated = await setAnalysisFlowRun(doc.tenantId, doc._id, {
    status: next,
    ...(typeof patch.statusNote === 'string' ? { statusNote: patch.statusNote } : {}),
    ...(typeof patch.issueId === 'string' ? { issueId: patch.issueId } : {}),
    ...(typeof patch.baselineSnapshotId === 'string' ? { baselineSnapshotId: patch.baselineSnapshotId } : {}),
  });
  return updated ?? doc;
}

/** Tolerantly coerce a sibling snapshot row into a PlanningRow (never throws). */
function toPlanningRow(raw: unknown): PlanningRow {
  if (raw && typeof raw === 'object') {
    const parsed = planningRowSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    return raw as PlanningRow;
  }
  return {};
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const apsPreHandlers = [requireAuth, requirePermission('aps:plan'), requireFeatureEnabled];

export async function apsPlanningRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/aps/analyses', {
    // Uploading the workbook runs it through the documents pipeline, so
    // the documents upload permission applies to this intake route.
    preHandler: [...apsPreHandlers, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const intake = await parseIntakeBody(req);

    // The workbook: either uploaded here (through the documents pipeline —
    // malware scan, classification, S3; never a second uploader) or
    // referenced by documentId.
    let documentId = intake.documentId;
    if (intake.file) {
      assertWorkbookFile(intake.file.filename, '');
      const result = await intakeUploadedDocument(auth, {
        filename: intake.file.filename,
        bytes: intake.file.data,
        requestedClassification: intake.requestedClassification,
        requestId: req.requestId,
        ip: req.ip,
      });
      documentId = result.id;
    }
    if (!documentId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide the exception report as a "report" file part or a documentId',
          requestId: req.requestId,
        },
      });
    }
    await resolveReportDocument(auth, documentId);

    const doc = await createAnalysis(auth, {
      exportType: 'EXCEPTION_REPORT',
      sourceDocumentIds: [documentId],
      ...(intake.site ? { site: intake.site } : {}),
    });

    // Drive the sibling's pipeline by name. When the substrate has not
    // landed, the analysis waits honestly in `pending-substrate`.
    let status: AnalysisStatus = 'analyzing';
    let statusNote: string | undefined;
    let flowName: string | undefined;
    let flowRunId: string | undefined;
    try {
      const invoked = await getSubstrateClient().invokeAnalysisFlow(auth, {
        exceptionReportDocumentId: documentId,
        issueId: intake.issueId ?? '',
        site: intake.site ?? '',
      });
      flowName = invoked.flowName;
      flowRunId = invoked.runId;
    } catch (error) {
      if (error instanceof SubstrateUnavailableError) {
        status = 'pending-substrate';
        statusNote =
          'The aps-exception-analysis pipeline has not been published on this tenant yet — ' +
          'the analysis is recorded and will run once the APS exception pipeline lands.';
      } else {
        throw error;
      }
    }
    const updated = await setAnalysisFlowRun(auth.tenantId, doc._id, {
      status,
      ...(statusNote ? { statusNote } : {}),
      ...(flowName ? { flowName } : {}),
      ...(flowRunId ? { flowRunId } : {}),
      ...(intake.issueId ? { issueId: intake.issueId } : {}),
    });

    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'APS_ANALYSIS_REQUESTED',
      success: true,
      metadata: {
        analysisId: doc._id,
        exportType: 'EXCEPTION_REPORT',
        documentId,
        status,
      },
    });
    return reply.status(202).send({
      id: doc._id,
      status: updated?.status ?? status,
      ...(statusNote ? { statusNote } : {}),
      product: productInfo(),
    });
  });

  fastify.get('/aps/analyses', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const query = listAnalysesQuery.safeParse(req.query);
    if (!query.success) validationError('Invalid list query', query.error.flatten());
    const docs = await listAnalyses(auth.tenantId, auth.userId, isAnalysisAdmin(auth), {
      status: query.data.status,
      limit: query.data.limit,
    });
    return reply.send({ items: docs.map(publicAnalysisListItem) });
  });

  fastify.get('/aps/analyses/:id', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = analysisIdParamSchema.safeParse(req.params);
    if (!params.success) validationError('Invalid analysis id', params.error.flatten());
    const doc = await getAnalysis(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Analysis not found');
    assertAnalysisReadable(doc, auth.userId, isAnalysisAdmin(auth));
    const refreshed = await refreshAnalysisFromRun(doc);
    return reply.send(publicAnalysisDetailView(refreshed));
  });

  fastify.post('/aps/analyses/:id/column-map', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = analysisIdParamSchema.safeParse(req.params);
    if (!params.success) validationError('Invalid analysis id', params.error.flatten());
    const body = columnMapSchema.safeParse(req.body);
    if (!body.success) validationError('Invalid column map', body.error.flatten());
    const doc = await getAnalysis(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Analysis not found');
    assertAnalysisReadable(doc, auth.userId, isAnalysisAdmin(auth));
    if (TERMINAL_ANALYSIS_STATUSES.includes(doc.status)) {
      throw Errors.conflict('ANALYSIS_TERMINAL', `Analysis is already ${doc.status}`);
    }
    const updated = await setAnalysisColumnMap(auth.tenantId, doc._id, body.data.columns, body.data.confirmed);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'APS_COLUMN_MAP_CONFIRMED',
      success: true,
      metadata: { analysisId: doc._id, confirmed: body.data.confirmed },
    });
    return reply.send({
      id: doc._id,
      columnMap: {
        columns: updated?.columnMap?.columns ?? body.data.columns,
        confirmed: updated?.columnMap?.confirmed ?? body.data.confirmed,
      },
    });
  });

  fastify.post('/aps/analyses/:id/verify', {
    preHandler: [...apsPreHandlers, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = analysisIdParamSchema.safeParse(req.params);
    if (!params.success) validationError('Invalid analysis id', params.error.flatten());
    const doc = await getAnalysis(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Analysis not found');
    assertAnalysisReadable(doc, auth.userId, isAnalysisAdmin(auth));
    if (!doc.issueId) {
      throw Errors.conflict(
        'ANALYSIS_HAS_NO_ISSUE',
        'This analysis has no recorded planning issue yet — the analysis pipeline must complete first',
      );
    }
    if (TERMINAL_ANALYSIS_STATUSES.includes(doc.status) && doc.status !== 'still-open' && doc.status !== 'awaiting-planner') {
      throw Errors.conflict('ANALYSIS_TERMINAL', `Analysis is already ${doc.status}`);
    }
    const intake = await parseIntakeBody(req);
    let documentId = intake.documentId;
    if (intake.file) {
      assertWorkbookFile(intake.file.filename, '');
      const result = await intakeUploadedDocument(auth, {
        filename: intake.file.filename,
        bytes: intake.file.data,
        requestedClassification: intake.requestedClassification,
        requestId: req.requestId,
        ip: req.ip,
      });
      documentId = result.id;
    }
    if (!documentId) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Provide the newer exception report as a "report" file part or a documentId',
          requestId: req.requestId,
        },
      });
    }
    await resolveReportDocument(auth, documentId);

    let invoked: InvokeFlowResult;
    try {
      invoked = await getSubstrateClient().invokeVerifyFlow(auth, {
        issueId: doc.issueId,
        newReportDocumentId: documentId,
        site: doc.site ?? '',
      });
    } catch (error) {
      substrateErrorToHttp(error);
    }
    const updated = await setAnalysisFlowRun(auth.tenantId, doc._id, {
      status: 'verifying',
      statusNote: 'Verification run started — comparing the new report against the recorded baseline.',
      flowName: invoked.flowName,
      flowRunId: invoked.runId,
    });
    // Track the verification report alongside the analysis documents.
    const db = await getDb();
    await db.collection<ApsAnalysisDoc>('aps_analyses').updateOne(
      { _id: doc._id, tenantId: auth.tenantId },
      { $addToSet: { sourceDocumentIds: documentId }, $set: { updatedAt: new Date() } },
    );
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'APS_ANALYSIS_VERIFY_REQUESTED',
      success: true,
      metadata: { analysisId: doc._id, issueId: doc.issueId, documentId },
    });
    return reply.status(202).send({
      id: doc._id,
      status: updated?.status ?? 'verifying',
      flowRunId: invoked.runId,
      product: productInfo(),
    });
  });

  fastify.post('/aps/analyses/:id/cancel', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = analysisIdParamSchema.safeParse(req.params);
    if (!params.success) validationError('Invalid analysis id', params.error.flatten());
    const doc = await getAnalysis(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Analysis not found');
    assertAnalysisReadable(doc, auth.userId, isAnalysisAdmin(auth));
    const updated = await cancelAnalysis(auth.tenantId, doc._id);
    if (!updated) throw Errors.conflict('ANALYSIS_TERMINAL', `Analysis is already ${doc.status}`);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'APS_ANALYSIS_CANCELLED',
      success: true,
      metadata: { analysisId: doc._id },
    });
    return reply.send({ id: updated._id, status: updated.status });
  });

  // -------------------------------------------------------------------------
  // Snapshots — read through the substrate seam (the sibling's aps_issues
  // store). Snapshots live inside issue documents; issueId is required.
  // -------------------------------------------------------------------------

  fastify.get('/aps/snapshots', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const query = snapshotsQuery.safeParse(req.query);
    if (!query.success) validationError('Invalid snapshots query', query.error.flatten());
    let issue: SubstrateIssue | null;
    try {
      issue = await getSubstrateClient().getIssue(auth.tenantId, query.data.issueId);
    } catch (error) {
      substrateErrorToHttp(error);
    }
    if (!issue) throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
    const snapshots = [...issue.snapshots]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.data.limit)
      .map((s) => ({
        snapshotId: s.snapshotId,
        issueId: issue!._id,
        createdAt: s.createdAt.toISOString(),
        rowCount: s.issues.length,
      }));
    return reply.send({ issueId: issue._id, status: issue.status, snapshots });
  });

  fastify.get('/aps/snapshots/:snapshotId', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const params = snapshotIdParamSchema.safeParse(req.params);
    if (!params.success) validationError('Invalid snapshot id', params.error.flatten());
    const query = z.object({ issueId: z.string().trim().min(1).max(120) }).safeParse(req.query);
    if (!query.success) validationError('Missing issueId query parameter', query.error.flatten());
    let singleIssue: SubstrateIssue | null;
    try {
      singleIssue = await getSubstrateClient().getIssue(auth.tenantId, query.data.issueId);
    } catch (error) {
      substrateErrorToHttp(error);
    }
    if (!singleIssue) throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
    const snapshot = singleIssue.snapshots.find((s) => s.snapshotId === params.data.snapshotId);
    if (!snapshot) throw Errors.notFound('SNAPSHOT_NOT_FOUND', 'Snapshot not found on this issue');
    return reply.send({
      snapshotId: snapshot.snapshotId,
      issueId: singleIssue._id,
      createdAt: snapshot.createdAt.toISOString(),
      rowCount: snapshot.issues.length,
      issues: snapshot.issues,
    });
  });

  /**
   * Cross-snapshot compare: per-row verdicts (resolved | still-open |
   * worsened | new) using the stable identity key
   * (type|item|supplyId|demandId, with the documented fallback chain).
   *
   * Mapping to the sibling's `aps.compareSnapshots` tool: that tool
   * answers the ISSUE-level question for the verify loop ("is every
   * baseline row gone from the new report?" → resolved boolean) using its
   * composite key item|orderNumber|workOrderNumber|dueDate. This endpoint
   * answers the ROW-level question across any two RECORDED snapshots —
   * which rows resolved, which are still open, which worsened, which are
   * new — so the planner sees the evidence diff, not just a boolean.
   */
  fastify.get('/aps/snapshots/compare', {
    preHandler: apsPreHandlers,
  }, async (req, reply) => {
    const auth = req.auth!;
    const query = compareSnapshotsQuery.safeParse(req.query);
    if (!query.success) validationError('Invalid compare query', query.error.flatten());
    let compareIssue: SubstrateIssue | null;
    try {
      const client = getSubstrateClient();
      compareIssue = query.data.issueId
        ? await client.getIssue(auth.tenantId, query.data.issueId)
        : null;
      if (!compareIssue) {
        // Without an issueId we cannot locate the snapshots: snapshots
        // live inside the sibling's issue documents.
        throw Errors.badRequest(
          'ISSUE_ID_REQUIRED',
          'Snapshots live inside issue documents — pass issueId to compare snapshots',
        );
      }
    } catch (error) {
      substrateErrorToHttp(error);
    }
    if (!compareIssue) throw Errors.notFound('ISSUE_NOT_FOUND', 'APS issue not found');
    const base = compareIssue.snapshots.find((s) => s.snapshotId === query.data.base);
    const other = compareIssue.snapshots.find((s) => s.snapshotId === query.data.other);
    if (!base) throw Errors.notFound('SNAPSHOT_NOT_FOUND', 'Baseline snapshot not found on this issue');
    if (!other) throw Errors.notFound('SNAPSHOT_NOT_FOUND', 'Other snapshot not found on this issue');
    const comparison = compareSnapshots(
      base.snapshotId,
      other.snapshotId,
      base.issues.map(toPlanningRow),
      other.issues.map(toPlanningRow),
    );
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'APS_SNAPSHOTS_COMPARED',
      success: true,
      metadata: {
        issueId: compareIssue._id,
        base: base.snapshotId,
        other: other.snapshotId,
        summary: comparison.summary,
      },
    });
    return reply.send({ issueId: compareIssue._id, comparison });
  });
}
