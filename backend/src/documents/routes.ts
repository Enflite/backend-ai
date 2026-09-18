import { createHash, randomUUID } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
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
    let classification: Classification = auth.clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL';
    if (auth.permissions.includes('document:classify') && requestedClassification) {
      if (!CLASSIFICATIONS.includes(requestedClassification as Classification) || requestedClassification === 'UNKNOWN') {
        throw Errors.badRequest('INVALID_CLASSIFICATION', 'Invalid data classification');
      }
      classification = requestedClassification as Classification;
    }
    if (classification !== 'UNKNOWN' && !canAccessClassification(auth.clearance, classification)) {
      throw Errors.forbidden('CLASSIFICATION_DENIED', 'Cannot upload above your clearance');
    }
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
       ORDER BY d.created_at DESC`,
      [auth.tenantId, allowedClassifications(auth.clearance), auth.userId, auth.roleId]
    );
    return reply.send({ documents: result.rows });
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
  }, async (req, reply) => {
    const auth = req.auth!;
    const parsedId = idSchema.safeParse(req.params);
    const parsedBody = classificationSchema.safeParse(req.body);
    if (!parsedId.success || !parsedBody.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid classification request');
    if (!canAccessClassification(auth.clearance, parsedBody.data.classification)) {
      throw Errors.forbidden('CLASSIFICATION_DENIED', 'Cannot classify above your clearance');
    }
    const updated = await tenantQuery(auth.tenantId,
      `UPDATE documents SET classification = $3, status = 'PENDING', error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL AND status NOT IN ('PENDING', 'PROCESSING')
       RETURNING id, classification, status`,
      [parsedId.data.id, auth.tenantId, parsedBody.data.classification]);
    if (updated.rowCount !== 1) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await tenantQuery(auth.tenantId, 'DELETE FROM document_chunks WHERE document_id = $1', [parsedId.data.id]);
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId,
      action: 'DOCUMENT_CLASSIFICATION_CHANGED', resource: 'document', resourceId: parsedId.data.id,
      classification: parsedBody.data.classification });
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
