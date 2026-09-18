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
import { ingestDocument } from './ingestion.js';
import { retrieveAuthorizedContext } from '../rag/retrieval.js';

const idSchema = z.object({ id: z.string().uuid() });
const searchSchema = z.object({ query: z.string().min(1).max(8000), documentIds: z.array(z.string().uuid()).max(100).optional() });

function allowedClassifications(clearance: Classification): Classification[] {
  return CLASSIFICATIONS.filter((value) => value !== 'UNKNOWN' && canAccessClassification(clearance, value));
}

const selectDocument = `SELECT DISTINCT d.id, d.tenant_id, d.owner_id, d.filename, d.mime_type, d.size_bytes,
  d.checksum_sha256, d.classification, d.status, d.error_code, d.created_at, d.updated_at
  FROM documents d LEFT JOIN document_permissions dp ON dp.document_id = d.id AND dp.tenant_id = d.tenant_id`;

export async function documentRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/documents', { preHandler: [requireAuth, requirePermission('document:upload')] }, async (req, reply) => {
    const auth = req.auth!;
    const part = await req.file();
    if (!part) throw Errors.badRequest('FILE_REQUIRED', 'A document file is required');
    const filename = sanitizeFilename(part.filename);
    const bytes = await part.toBuffer();
    if (bytes.length === 0) throw Errors.badRequest('EMPTY_FILE', 'Document is empty');
    const mimeType = detectMimeType(filename, bytes);
    const classificationValue = part.fields.classification && 'value' in part.fields.classification
      ? String(part.fields.classification.value)
      : 'UNKNOWN';
    if (!CLASSIFICATIONS.includes(classificationValue as Classification)) {
      throw Errors.badRequest('INVALID_CLASSIFICATION', 'Invalid data classification');
    }
    const classification = classificationValue as Classification;
    if (classification !== 'UNKNOWN' && !canAccessClassification(auth.clearance, classification)) {
      throw Errors.forbidden('CLASSIFICATION_DENIED', 'Cannot upload above your clearance');
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const id = randomUUID();
    const objectKey = `${auth.tenantId}/${id}`;
    await s3Storage.put(objectKey, bytes, mimeType);
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
      await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip, action: 'DOCUMENT_UPLOAD', resource: 'document', resourceId: id, classification });
      void ingestDocument(id, auth.tenantId).catch((error) => req.log.error({ err: error, documentId: id }, 'Document ingestion failed'));
      return reply.status(201).send({ document });
    } catch (error) {
      await s3Storage.delete(objectKey).catch(() => undefined);
      throw error;
    }
  });

  fastify.get('/documents', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const auth = req.auth!;
    const result = await tenantQuery(
      auth.tenantId,
      `${selectDocument}
       WHERE d.tenant_id = $1 AND d.deleted_at IS NULL AND d.classification = ANY($2::text[])
         AND (d.owner_id = $3 OR (dp.can_read AND (dp.user_id = $3 OR dp.role_id = $4)))
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
           AND (d.owner_id = $4 OR (dp.can_read AND (dp.user_id = $4 OR dp.role_id = $5)))`,
        [parsed.data.id, auth.tenantId, allowedClassifications(auth.clearance), auth.userId, auth.roleId]
      )
    ).rows[0];
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'DOCUMENT_ACCESS', resource: 'document', resourceId: parsed.data.id });
    return reply.send({ document });
  });

  fastify.post('/documents/:id/ingest', { preHandler: [requireAuth, requirePermission('document:upload')] }, async (req, reply) => {
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const owned = await tenantQuery(req.auth!.tenantId, 'SELECT 1 FROM documents WHERE id = $1 AND owner_id = $2 AND deleted_at IS NULL', [parsed.data.id, req.auth!.userId]);
    if (owned.rowCount !== 1) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await ingestDocument(parsed.data.id, req.auth!.tenantId);
    return reply.status(202).send({ status: 'COMPLETED' });
  });

  fastify.delete('/documents/:id', { preHandler: [requireAuth, requirePermission('document:delete')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = idSchema.safeParse(req.params);
    if (!parsed.success) throw Errors.badRequest('INVALID_ID', 'Invalid document ID');
    const document = (
      await tenantQuery<{ object_key: string }>(auth.tenantId, 'SELECT object_key FROM documents WHERE id = $1 AND tenant_id = $2 AND owner_id = $3 AND deleted_at IS NULL', [parsed.data.id, auth.tenantId, auth.userId])
    ).rows[0];
    if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
    await s3Storage.delete(document.object_key);
    await tenantQuery(auth.tenantId, "UPDATE documents SET deleted_at = NOW(), updated_at = NOW() WHERE id = $1", [parsed.data.id]);
    await recordAudit({ tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, action: 'DOCUMENT_DELETE', resource: 'document', resourceId: parsed.data.id });
    return reply.status(204).send();
  });

  fastify.post('/rag/search', { preHandler: [requireAuth, requirePermission('document:read')] }, async (req, reply) => {
    const parsed = searchSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid retrieval request');
    const result = await retrieveAuthorizedContext(req.auth!, parsed.data.query, parsed.data.documentIds);
    await recordAudit({ tenantId: req.auth!.tenantId, userId: req.auth!.userId, requestId: req.requestId, action: 'RAG_RETRIEVAL', resource: 'documents', metadata: { resultCount: result.citations.length } });
    return reply.send({ citations: result.citations });
  });
}
