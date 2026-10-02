/**
 * intake.ts — the single upload-intake path for the documents pipeline.
 *
 * Extracted verbatim from the `POST /documents` handler (documents/routes.ts)
 * so other product surfaces (e.g. the APS Planning Agent's
 * `POST /api/v1/aps/analyses`) can accept file uploads through the SAME
 * pipeline — malware scan, classification, S3 storage, ingestion queue —
 * instead of writing a second uploader.
 *
 * Behavior is identical to the original handler: filename sanitizing,
 * MIME detection, upload classification resolution, SHA-256 checksum,
 * S3 put, the atomic duplicate-check insert on UNIQUE
 * (tenantId, checksumSha256), audit, and ingestion enqueue.
 */

import { createHash, randomUUID } from 'node:crypto';
import { MongoServerError } from 'mongodb';
import type { AuthContext } from '../authz/permissions.js';
import { resolveUploadClassification } from './uploadClassification.js';
import { getDb } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import { s3Storage } from '../storage/storage.js';
import { detectMimeType, sanitizeFilename } from './fileValidation.js';
import { enqueueIngestion } from './queue.js';

/** Shape of the `documents` MongoDB documents (ADR-014). Mirrors routes.ts. */
export interface IntakeDocumentDoc {
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
  deletedAt: null;
}

export interface IntakeInput {
  /** Raw filename from the multipart part (sanitized inside). */
  filename: string;
  bytes: Buffer;
  /** Optional `classification` multipart field value. */
  requestedClassification?: string;
  /** Correlates audit + ingestion with the caller's request. */
  requestId: string;
  ip?: string;
}

export interface IntakeResult {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  checksumSha256: string;
  objectKey: string;
  classification: string;
  status: 'PENDING';
  errorCode: null;
  createdAt: Date;
}

function isChecksumDuplicate(error: unknown): boolean {
  return error instanceof MongoServerError
    && error.code === 11000
    && !!error.keyPattern
    && 'checksumSha256' in error.keyPattern;
}

/**
 * Run one file through the documents upload pipeline. Throws
 * FILE_REQUIRED/EMPTY_FILE/DUPLICATE_DOCUMENT like the route handler.
 */
export async function intakeUploadedDocument(
  auth: AuthContext,
  input: IntakeInput,
): Promise<IntakeResult> {
  const filename = sanitizeFilename(input.filename);
  const bytes = input.bytes;
  if (bytes.length === 0) throw Errors.badRequest('EMPTY_FILE', 'Document is empty');
  const mimeType = detectMimeType(filename, bytes);
  const classification = resolveUploadClassification(
    auth.clearance,
    input.requestedClassification,
    auth.permissions.includes('document:classify'),
  );
  const checksum = createHash('sha256').update(bytes).digest('hex');
  const id = randomUUID();
  const objectKey = `${auth.tenantId}/${id}`;
  await s3Storage.put(objectKey, bytes, mimeType);
  const now = new Date();
  const document: IntakeDocumentDoc = {
    _id: id,
    tenantId: auth.tenantId,
    ownerId: auth.userId,
    filename,
    mimeType,
    sizeBytes: bytes.length,
    checksumSha256: checksum,
    objectKey,
    classification,
    status: 'PENDING',
    errorCode: null,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
  let metadataCreated = false;
  try {
    const db = await getDb();
    // UNIQUE (tenantId, checksumSha256): the same file was already uploaded.
    // The unique index makes this insert the atomic duplicate check; a
    // duplicate-key error below maps to DUPLICATE_DOCUMENT.
    await db.collection<IntakeDocumentDoc>('documents').insertOne(document);
    metadataCreated = true;
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: input.requestId,
      ...(input.ip ? { ip: input.ip } : {}),
      action: 'DOCUMENT_UPLOAD',
      resource: 'document',
      resourceId: id,
      classification,
    });
    await enqueueIngestion({
      documentId: id,
      tenantId: auth.tenantId,
      requestedBy: auth.userId,
      requestId: input.requestId,
    });
    return {
      id,
      filename,
      mimeType,
      sizeBytes: bytes.length,
      checksumSha256: checksum,
      objectKey,
      classification,
      status: 'PENDING',
      errorCode: null,
      createdAt: now,
    };
  } catch (error) {
    if (isChecksumDuplicate(error)) {
      await s3Storage.delete(objectKey).catch(() => undefined);
      throw Errors.conflict('DUPLICATE_DOCUMENT', 'This file has already been uploaded');
    }
    if (metadataCreated) {
      const db = await getDb();
      await db.collection<IntakeDocumentDoc>('documents').updateOne(
        { _id: id, tenantId: auth.tenantId },
        { $set: { status: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE', updatedAt: new Date() } },
      );
    } else {
      await s3Storage.delete(objectKey).catch(() => undefined);
    }
    throw error;
  }
}
