import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ClientSession, Db } from 'mongodb';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification, canAccessClassification, classificationRank } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { getDb, withTenantTx } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import { retrieveAuthorizedContext } from '../rag/retrieval.js';
import { enqueueIngestion, cancelIngestionJob, requeueIngestionJob } from './queue.js';
import { s3Storage } from '../storage/storage.js';
import { intakeUploadedDocument } from './intake.js';
import { grantedDocumentIds, principalOrConditions } from './grants.js';
import { config } from '../config.js';

const idSchema = z.object({ id: z.string().uuid() });
const searchSchema = z.object({
  query: z.string().min(1).max(8000),
  documentIds: z.array(z.string().uuid()).max(100).optional(),
  topK: z.number().int().min(1).max(config.RAG_TOP_K_MAX).default(8),
});
const classificationSchema = z.object({ classification: z.enum(['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'PROPRIETARY', 'CUI']) });

function allowedClassifications(clearance: Classification): Classification[] {
  return CLASSIFICATIONS.filter((value) => value !== 'UNKNOWN' && canAccessClassification(clearance, value));
}

/** Shape of the `documents` MongoDB documents (ADR-014). */
interface DocumentDoc {
  _id: string;
  tenantId: string;
  ownerId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  objectKey: string;
  classification: string;
  status: string;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/** Shape of the `document_permissions` MongoDB documents (sparse principal convention). */
interface DocumentPermissionDoc {
  _id: string;
  tenantId: string;
  documentId: string;
  canRead: boolean;
  userId?: string;
  roleId?: string;
  departmentId?: string;
  groupId?: string;
}

/** API shape: camelCase with `_id` surfaced as `id` (matches auth route conventions). */
function toDocumentApi(doc: DocumentDoc): Record<string, unknown> {
  return {
    id: doc._id,
    tenantId: doc.tenantId,
    ownerId: doc.ownerId,
    filename: doc.filename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    checksumSha256: doc.checksumSha256,
    classification: doc.classification,
    status: doc.status,
    errorCode: doc.errorCode,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/documents', {
    preHandler: [requireAuth, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const part = await req.file();
    if (!part) throw Errors.badRequest('FILE_REQUIRED', 'A document file is required');
    const bytes = await part.toBuffer();
    const requestedClassification = part.fields.classification && 'value' in part.fields.classification
      ? String(part.fields.classification.value)
      : undefined;
    // Single upload-intake path (documents/intake.ts): malware scan,
    // classification, S3 storage, ingestion queue. Shared with the APS
    // Planning Agent's report intake — never a second uploader.
    const result = await intakeUploadedDocument(auth, {
      filename: part.filename,
      bytes,
      requestedClassification,
      requestId: req.requestId,
      ip: req.ip,
    });
    return reply.status(201).send({
      document: toDocumentApi({
        _id: result.id,
        tenantId: auth.tenantId,
        ownerId: auth.userId,
        filename: result.filename,
        mimeType: result.mimeType,
        sizeBytes: result.sizeBytes,
        checksumSha256: result.checksumSha256,
        objectKey: result.objectKey,
        classification: result.classification,
        status: result.status,
        errorCode: result.errorCode,
        createdAt: result.createdAt,
        updatedAt: result.createdAt,
      }),
    });
  });

  fastify.get('/documents', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const pagination = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    const db = await getDb();
    const grantedIds = await grantedDocumentIds(db, auth.tenantId, auth.userId, auth.roleId);
    const documents = await db.collection<DocumentDoc>('documents')
      .find({
        tenantId: auth.tenantId,
        deletedAt: null,
        classification: { $in: allowedClassifications(auth.clearance) },
        $or: [{ ownerId: auth.userId }, { _id: { $in: grantedIds } }],
      })
      .sort({ createdAt: -1 })
      .skip(pagination.data.offset)
      .limit(pagination.data.limit)
      .toArray();
    return reply.send({ documents: documents.map(toDocumentApi), pagination: pagination.data });
  });

  fastify.get('/documents/:id', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const db = await getDb();
    const grantedIds = await grantedDocumentIds(db, auth.tenantId, auth.userId, auth.roleId);
    const document = await db.collection<DocumentDoc>('documents').findOne({
      _id: parsed.data.id,
      tenantId: auth.tenantId,
      deletedAt: null,
      classification: { $in: allowedClassifications(auth.clearance) },
      $or: [{ ownerId: auth.userId }, { _id: { $in: grantedIds } }],
    });
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'DOCUMENT_ACCESS', resource: 'document', resourceId: parsed.data.id });
    return reply.send({ document: toDocumentApi(document) });
  });

  fastify.post('/documents/:id/retry', {
    preHandler: [requireAuth, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const db = await getDb();
    const owned = await db.collection<DocumentDoc>('documents').findOne(
      {
        _id: parsed.data.id,
        tenantId: req.auth!.tenantId,
        ownerId: req.auth!.userId,
        deletedAt: null,
        status: { $in: ['FAILED', 'QUARANTINED'] },
        classification: { $ne: 'UNKNOWN' },
      },
      { projection: { _id: 1 } }
    );
    if (!owned) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await db.collection<DocumentDoc>('documents').updateOne(
      { _id: parsed.data.id, tenantId: req.auth!.tenantId },
      { $set: { status: 'PENDING', errorCode: null, updatedAt: new Date() } }
    );
    const jobId = await enqueueIngestion({ documentId: parsed.data.id, tenantId: req.auth!.tenantId,
      requestedBy: req.auth!.userId, requestId: req.requestId });
    return reply.status(202).send({ status: 'PENDING', jobId });
  });

  // Cancel an ingestion job. A PENDING job is canceled immediately; a
  // PROCESSING job is marked cancel-requested and the worker aborts it at the
  // next pipeline stage boundary (202 = accepted, still winding down).
  fastify.post('/documents/jobs/:id/cancel', {
    preHandler: [requireAuth, requirePermission('document:upload')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid job ID');
    const result = await cancelIngestionJob({
      jobId: parsed.data.id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      // The requesting user or a platform admin (tenant:manage) may cancel.
      isAdmin: auth.permissions.includes('tenant:manage'),
      requestId: req.requestId,
    });
    return reply.status(result.status === 'cancel-requested' ? 202 : 200).send(result);
  });

  // Admin requeue of a quarantined (or failed) job. Quarantined jobs are never
  // auto-retried; this audited endpoint is the only way back.
  fastify.post('/documents/jobs/:id/requeue', {
    preHandler: [requireAuth, requirePermission('tenant:manage')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid job ID');
    const result = await requeueIngestionJob({
      jobId: parsed.data.id,
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
    });
    return reply.status(202).send(result);
  });

  fastify.patch('/documents/:id/classification', {
    preHandler: [requireAuth, requirePermission('document:classify')],
    // Reclassification is expensive (deletes all chunks + full re-ingestion).
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = idSchema.safeParse(req.params);
    const parsedBody = classificationSchema.extend({ confirm: z.boolean().optional() }).safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid classification request');
    const next = parsedBody.data.classification;
    assertClassificationAllowed(auth.clearance, next);
    // Status guard, UPDATE, and chunk DELETE run in ONE transaction. The
    // update re-applies the status guard atomically (findOneAndUpdate with
    // the guard in the filter): concurrent relabels serialize on the
    // document — the second one finds status PENDING (set by the first) and
    // fails closed instead of overwriting an in-flight reclassification or
    // resurrecting chunks of the previous label.
    const reclassified = await withTenantTx(auth.tenantId, async (session, db, tenantId) => {
      const current = await db.collection<DocumentDoc>('documents').findOne(
        {
          _id: parsedId.data.id,
          tenantId,
          deletedAt: null,
          status: { $nin: ['PENDING', 'PROCESSING'] },
        },
        { session, projection: { classification: 1, ownerId: 1 } }
      );
      if (!current) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
      const grant = await db.collection<DocumentPermissionDoc>('document_permissions').findOne(
        {
          tenantId,
          documentId: parsedId.data.id,
          canRead: true,
          $or: await principalOrConditions(db, auth.userId, auth.roleId, session),
        },
        { session, projection: { _id: 1 } }
      );
      // Only the owner, a caller holding an explicit document grant (the same
      // owner-or-grant predicate as the document GET route), or a tenant
      // manager may relabel a document: a classification grant alone must never
      // let a user who cannot read a document downgrade it to PUBLIC.
      const mayRelabel = current.ownerId === auth.userId
        || grant !== null
        || auth.permissions.includes('tenant:manage');
      if (!mayRelabel) {
        throw Errors.forbidden('DOCUMENT_RECLASSIFY_FORBIDDEN', 'Only the document owner, a granted collaborator, or a tenant manager can change its classification');
      }
      // The caller must be cleared for the document's CURRENT label as well as the new one.
      assertClassificationAllowed(auth.clearance, current.classification as Classification);
      // Downgrades require explicit confirmation so a single misclick can't declassify data.
      if (classificationRank(next) < classificationRank(current.classification as Classification) && parsedBody.data.confirm !== true) {
        throw Errors.conflict('CONFIRMATION_REQUIRED', 'Classification downgrade requires explicit confirmation', { from: current.classification, to: next });
      }
      const updated = await db.collection<DocumentDoc>('documents').findOneAndUpdate(
        {
          _id: parsedId.data.id,
          tenantId,
          deletedAt: null,
          status: { $nin: ['PENDING', 'PROCESSING'] },
        },
        { $set: { classification: next, status: 'PENDING', errorCode: null, updatedAt: new Date() } },
        { session, returnDocument: 'after' }
      );
      if (!updated) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
      await db.collection<{ _id: string; tenantId: string; documentId: string }>('document_chunks').deleteMany(
        { tenantId, documentId: parsedId.data.id },
        { session }
      );
      return { document: toDocumentApi(updated), previousClassification: current.classification };
    });
    // Fail-closed audit must not strand the document: capture an audit
    // failure, enqueue the ingestion job anyway (the document is PENDING and
    // needs a job), then rethrow so the client still sees the 503.
    let auditFailure: unknown;
    try {
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId,
        action: 'DOCUMENT_CLASSIFICATION_CHANGED', resource: 'document', resourceId: parsedId.data.id,
        classification: next, metadata: { previousClassification: reclassified.previousClassification } });
    } catch (error) {
      auditFailure = error;
    }
    // The ingestion job is enqueued only after the transaction commits, so a
    // worker can never observe PENDING status with the old chunks still present.
    const jobId = await enqueueIngestion({ documentId: parsedId.data.id, tenantId: auth.tenantId,
      requestedBy: auth.userId, requestId: req.requestId });
    if (auditFailure !== undefined) throw auditFailure;
    return reply.status(202).send({ document: reclassified.document, jobId });
  });

  fastify.delete('/documents/:id', { preHandler: [requireAuth, requirePermission('document:delete')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const db = await getDb();
    const document = await db.collection<DocumentDoc>('documents').findOne(
      { _id: parsed.data.id, tenantId: auth.tenantId, ownerId: auth.userId, deletedAt: null },
      { projection: { objectKey: 1 } }
    );
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await db.collection<DocumentDoc>('documents').updateOne(
      { _id: parsed.data.id, tenantId: auth.tenantId },
      { $set: { status: 'DELETED', deletedAt: new Date(), updatedAt: new Date() } }
    );
    await s3Storage.delete(document.objectKey).catch((error) => {
      req.log.error({ err: error, documentId: parsed.data.id }, 'Deleted document object cleanup failed');
    });
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'DOCUMENT_DELETE', resource: 'document', resourceId: parsed.data.id });
    return reply.status(204).send();
  });

  fastify.post('/rag/search', {
    preHandler: [requireAuth, requirePermission('document:read')],
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid retrieval request');
    const result = await retrieveAuthorizedContext(req.auth!, parsed.data.query, parsed.data.documentIds, parsed.data.topK);
    const denied = Boolean(parsed.data.documentIds?.length && result.results.length === 0);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.requestId,
      action: denied ? 'RAG_ACCESS_DENIED' : 'RAG_SEARCH', resource: 'documents', success: !denied,
      metadata: { resultCount: result.results.length } });
    return reply.send({ results: result.results });
  });
}
