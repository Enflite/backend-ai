import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification, canAccessClassification, classificationRank } from '../authz/permissions.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { resolveUploadClassification } from './uploadClassification.js';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import { s3Storage } from '../storage/storage.js';
import { detectMimeType, sanitizeFilename } from './fileValidation.js';
import { retrieveAuthorizedContext } from '../rag/retrieval.js';
import { enqueueIngestion } from './queue.js';
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

const selectDocument = `SELECT DISTINCT d.id, d.tenant_id, d.owner_id, d.filename, d.mime_type, d.size_bytes,
  d.checksum_sha256, d.classification, d.status, d.error_code, d.created_at, d.updated_at
  FROM documents d LEFT JOIN document_permissions dp ON dp.document_id = d.id AND dp.tenant_id = d.tenant_id`;

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/documents', {
    preHandler: [requireAuth, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const auth = req.auth!;
    const part = await req.file();
    if (!part) throw Errors.badRequest('FILE_REQUIRED', 'A document file is required');
    const filename = sanitizeFilename(part.filename);
    const bytes = await part.toBuffer();
    if (bytes.length === 0) throw Errors.badRequest('EMPTY_FILE', 'Document is empty');
    const mimeType = detectMimeType(filename, bytes);
    const requestedClassification = part.fields.classification && 'value' in part.fields.classification
      ? String(part.fields.classification.value)
      : undefined;
    const classification = resolveUploadClassification(
      auth.clearance,
      requestedClassification,
      auth.permissions.includes('document:classify')
    );
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const id = randomUUID();
    const objectKey = `${auth.tenantId}/${id}`;
    await s3Storage.put(objectKey, bytes, mimeType);
    let metadataCreated = false;
    try {
      const document = (
        await tenantQuery(
          auth.tenantId,
          `INSERT INTO documents (id, tenant_id, owner_id, filename, mime_type, size_bytes, checksum_sha256, object_key, classification)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           RETURNING id, tenant_id, owner_id, filename, mime_type, size_bytes, checksum_sha256, classification, status, created_at, updated_at`,
          [id, auth.tenantId, auth.userId, filename, mimeType, bytes.length, checksum, objectKey, classification]
        )
      ).rows[0];
      metadataCreated = true;
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip, action: 'DOCUMENT_UPLOAD', resource: 'document', resourceId: id, classification });
      await enqueueIngestion({ documentId: id, tenantId: auth.tenantId, requestedBy: auth.userId, requestId: req.requestId });
      return reply.status(201).send({ document });
    } catch (error) {
      if (error && typeof error === 'object' && (error as { code?: string }).code === '23505'
        && typeof (error as { constraint?: string }).constraint === 'string'
        && (error as { constraint?: string }).constraint!.includes('checksum')) {
        // UNIQUE (tenant_id, checksum_sha256): the same file was already uploaded.
        await s3Storage.delete(objectKey).catch(() => undefined);
        throw Errors.conflict('DUPLICATE_DOCUMENT', 'This file has already been uploaded');
      }
      if (metadataCreated) {
        await tenantQuery(auth.tenantId,
          "UPDATE documents SET status = 'FAILED', error_code = 'QUEUE_UNAVAILABLE', updated_at = NOW() WHERE id = $1",
          [id]);
      } else {
        await s3Storage.delete(objectKey).catch(() => undefined);
      }
      throw error;
    }
  });

  fastify.get('/documents', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const pagination = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!pagination.success) throw Errors.badRequest('INVALID_PAGINATION', 'Invalid pagination parameters');
    const result = await tenantQuery(
      auth.tenantId,
      `${selectDocument}
       WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND d.classification = ANY($2::text[])
         AND (d.owner_id = $3 OR (dp.can_read AND (
           dp.user_id = $3 OR dp.role_id = $4
           OR (dp.department_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM department_memberships dm WHERE dm.tenant_id = $1 AND dm.department_id = dp.department_id AND dm.user_id = $3
           ))
           OR (dp.group_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM security_group_memberships gm WHERE gm.tenant_id = $1 AND gm.group_id = dp.group_id AND gm.user_id = $3
           ))
         )))
       ORDER BY d.created_at DESC LIMIT $5 OFFSET $6`,
      [auth.tenantId, allowedClassifications(auth.clearance), auth.userId, auth.roleId, pagination.data.limit, pagination.data.offset]
    );
    return reply.send({ documents: result.rows, pagination: pagination.data });
  });

  fastify.get('/documents/:id', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const document = (
      await tenantQuery(
        auth.tenantId,
        `${selectDocument}
         WHERE d.id = $1 AND d.tenant_id = $2 AND d.deleted_at IS NULL AND d.classification = ANY($3::text[])
           AND (d.owner_id = $4 OR (dp.can_read AND (
             dp.user_id = $4 OR dp.role_id = $5
             OR (dp.department_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM department_memberships dm WHERE dm.tenant_id = $2 AND dm.department_id = dp.department_id AND dm.user_id = $4
             ))
             OR (dp.group_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM security_group_memberships gm WHERE gm.tenant_id = $2 AND gm.group_id = dp.group_id AND gm.user_id = $4
             ))
           )))`,
        [parsed.data.id, auth.tenantId, allowedClassifications(auth.clearance), auth.userId, auth.roleId]
      )
    ).rows[0];
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'DOCUMENT_ACCESS', resource: 'document', resourceId: parsed.data.id });
    return reply.send({ document });
  });

  fastify.post('/documents/:id/retry', {
    preHandler: [requireAuth, requirePermission('document:upload')],
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const owned = await tenantQuery(req.auth!.tenantId,
      "SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL AND status IN ('FAILED', 'QUARANTINED') AND classification <> 'UNKNOWN'",
      [parsed.data.id, req.auth!.userId]);
    if (owned.rowCount !== 1) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await tenantQuery(req.auth!.tenantId, "UPDATE documents SET status = 'PENDING', error_code = NULL, updated_at = NOW() WHERE id = $1", [parsed.data.id]);
    const jobId = await enqueueIngestion({ documentId: parsed.data.id, tenantId: req.auth!.tenantId,
      requestedBy: req.auth!.userId, requestId: req.requestId });
    return reply.status(202).send({ status: 'PENDING', jobId });
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
    const current = (
      await tenantQuery<{ classification: Classification; owner_id: string; has_grant: boolean }>(auth.tenantId,
        `SELECT d.classification, d.owner_id,
           EXISTS (
             SELECT 1 FROM document_permissions dp
             WHERE dp.document_id = d.id AND dp.tenant_id = d.tenant_id AND dp.can_read AND (
               dp.user_id = $3 OR dp.role_id = $4
               OR (dp.department_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM department_memberships dm WHERE dm.tenant_id = $2 AND dm.department_id = dp.department_id AND dm.user_id = $3
               ))
               OR (dp.group_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM security_group_memberships gm WHERE gm.tenant_id = $2 AND gm.group_id = dp.group_id AND gm.user_id = $3
               ))
             )
           ) AS has_grant
         FROM documents d
         WHERE d.id = $1 AND d.tenant_id = $2 AND d.deleted_at IS NULL AND d.status NOT IN ('PENDING', 'PROCESSING')`,
        [parsedId.data.id, auth.tenantId, auth.userId, auth.roleId])
    ).rows[0];
    if (!current) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    // Only the owner, a caller holding an explicit document grant (the same
    // owner-or-grant predicate as the document GET route), or a tenant
    // manager may relabel a document: a classification grant alone must never
    // let a user who cannot read a document downgrade it to PUBLIC.
    const mayRelabel = current.owner_id === auth.userId
      || current.has_grant
      || auth.permissions.includes('tenant:manage');
    if (!mayRelabel) {
      throw Errors.forbidden('DOCUMENT_RECLASSIFY_FORBIDDEN', 'Only the document owner, a granted collaborator, or a tenant manager can change its classification');
    }
    // The caller must be cleared for the document's CURRENT label as well as the new one.
    assertClassificationAllowed(auth.clearance, current.classification);
    // Downgrades require explicit confirmation so a single misclick can't declassify data.
    if (classificationRank(next) < classificationRank(current.classification) && parsedBody.data.confirm !== true) {
      throw Errors.conflict('CONFIRMATION_REQUIRED', 'Classification downgrade requires explicit confirmation', { from: current.classification, to: next });
    }
    const updated = await tenantQuery(auth.tenantId,
      `UPDATE documents SET classification = $3, status = 'PENDING', error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status NOT IN ('PENDING', 'PROCESSING')
       RETURNING id, classification, status`,
      [parsedId.data.id, auth.tenantId, next]);
    if (updated.rowCount !== 1) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await tenantQuery(auth.tenantId, 'DELETE FROM document_chunks WHERE document_id = $1', [parsedId.data.id]);
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId,
      action: 'DOCUMENT_CLASSIFICATION_CHANGED', resource: 'document', resourceId: parsedId.data.id,
      classification: next, metadata: { previousClassification: current.classification } });
    const jobId = await enqueueIngestion({ documentId: parsedId.data.id, tenantId: auth.tenantId,
      requestedBy: auth.userId, requestId: req.requestId });
    return reply.status(202).send({ document: updated.rows[0], jobId });
  });

  fastify.delete('/documents/:id', { preHandler: [requireAuth, requirePermission('document:delete')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const document = (
      await tenantQuery<{ object_key: string }>(auth.tenantId, 'SELECT object_key FROM documents WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 AND deleted_at IS NULL', [parsed.data.id, auth.tenantId, auth.userId])
    ).rows[0];
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await tenantQuery(auth.tenantId, "UPDATE documents SET status = 'DELETED', deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [parsed.data.id]);
    await s3Storage.delete(document.object_key).catch((error) => {
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
