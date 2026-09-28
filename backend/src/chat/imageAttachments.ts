/**
 * imageAttachments.ts — authorized vision-input loading for chat turns.
 *
 * When a chat turn carries selected document IDs, this module splits them
 * into (a) image documents, whose raw bytes are loaded from object storage
 * and attached to the outgoing provider message as vision inputs, and (b)
 * every other selected ID, which continues down the RAG text path unchanged.
 *
 * Authorization mirrors the RAG retrieval path exactly: tenant-scoped,
 * READY, not deleted, classification within the caller's clearance, and
 * owner-or-grant. IDs that fail any check simply are not images — they fall
 * through to RAG, which enforces its own authorization (fail-closed
 * selection, same as retrieval.ts). The image path never widens access: a
 * turn never sees image bytes it may not.
 *
 * Size is bounded before any provider call: at most
 * CHAT_MAX_IMAGES_PER_TURN images, each image under CHAT_MAX_IMAGE_BYTES,
 * and the turn's images under CHAT_MAX_IMAGE_TOTAL_BYTES in total. An
 * oversize image fails the turn with a clear error rather than blowing up
 * base64 memory or the model's context window.
 */
import { Buffer } from 'node:buffer';
import { config } from '../config.js';
import { AuthContext, CLASSIFICATIONS, canAccessClassification } from '../authz/permissions.js';
import { getDb } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { ObjectStorage, s3Storage } from '../storage/storage.js';
import type { ChatImage } from '../ai/providers/types.js';
import { grantPrincipalOr } from '../rag/grants.js';

/** One authorized image attachment, bytes already loaded as base64. */
export interface AttachedImage {
  documentId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  image: ChatImage;
}

/** Split of a turn's selected document IDs into vision and text inputs. */
export interface ResolvedChatDocuments {
  images: AttachedImage[];
  /**
   * Selected IDs that did not resolve to authorized images — the RAG text
   * path. Includes IDs that are not images, are not READY, are deleted,
   * exceed the caller's clearance, or are otherwise unauthorized: RAG
   * enforces its own authorization on these exactly as before.
   */
  textDocumentIds: string[];
}

interface ImageCandidateDoc {
  _id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  objectKey: string;
  classification: string;
}

export interface ImageAttachmentDependencies {
  storage: Pick<ObjectStorage, 'get'>;
}

const defaultDependencies: ImageAttachmentDependencies = { storage: s3Storage };

export async function resolveChatDocuments(
  auth: AuthContext,
  documentIds: string[] | undefined,
  dependencies: ImageAttachmentDependencies = defaultDependencies
): Promise<ResolvedChatDocuments> {
  if (!documentIds || documentIds.length === 0) return { images: [], textDocumentIds: [] };
  // UNKNOWN fails closed here exactly as in the RAG path.
  const allowed = CLASSIFICATIONS.filter(
    (classification) => classification !== 'UNKNOWN' && canAccessClassification(auth.clearance, classification)
  );
  const db = await getDb();

  // Same authorization as the RAG path: tenant-scoped, READY, not deleted,
  // classification within clearance, owner-or-grant.
  const grants = await db
    .collection<{ documentId: string }>('document_permissions')
    .find(
      { tenantId: auth.tenantId, canRead: true, $or: await grantPrincipalOr(db, auth) },
      { projection: { documentId: 1 } }
    )
    .toArray();
  const grantedIds = [...new Set(grants.map((grant) => grant.documentId))];
  const ownerOrGrant: Record<string, unknown>[] = [{ ownerId: auth.userId }];
  if (grantedIds.length > 0) ownerOrGrant.push({ _id: { $in: grantedIds } });

  const docs = await db
    .collection<ImageCandidateDoc>('documents')
    .find(
      {
        tenantId: auth.tenantId,
        _id: { $in: documentIds },
        status: 'READY',
        deletedAt: null,
        classification: { $in: allowed },
        $or: ownerOrGrant,
      },
      { projection: { filename: 1, mimeType: 1, sizeBytes: 1, objectKey: 1, classification: 1 } }
    )
    .toArray();

  const imageDocs: ImageCandidateDoc[] = [];
  for (const doc of docs) {
    if (typeof doc.mimeType === 'string' && doc.mimeType.startsWith('image/')) imageDocs.push(doc);
  }
  // Every selected ID that did not resolve to an authorized image keeps its
  // old behavior: it goes to the RAG text path, which enforces its own
  // authorization. The image split must never remove IDs from RAG.
  const imageIds = new Set(imageDocs.map((doc) => doc._id));
  const textDocumentIds = documentIds.filter((id) => !imageIds.has(id));

  // Bound the count before touching bytes; bound each image's bytes and the
  // turn's total bytes before base64-encoding (which inflates ~33%).
  const capped = imageDocs.slice(0, config.CHAT_MAX_IMAGES_PER_TURN);
  const images: AttachedImage[] = [];
  let totalBytes = 0;
  for (const doc of capped) {
    if (doc.sizeBytes > config.CHAT_MAX_IMAGE_BYTES) {
      throw Errors.badRequest(
        'IMAGE_TOO_LARGE',
        `Image "${doc.filename}" exceeds the per-image size limit for chat turns`
      );
    }
    totalBytes += doc.sizeBytes;
    if (totalBytes > config.CHAT_MAX_IMAGE_TOTAL_BYTES) {
      throw Errors.badRequest(
        'IMAGES_TOO_LARGE',
        'Attached images exceed the total size limit for a chat turn — attach fewer or smaller images'
      );
    }
    const bytes = await dependencies.storage.get(doc.objectKey);
    images.push({
      documentId: doc._id,
      filename: doc.filename,
      mimeType: doc.mimeType,
      sizeBytes: doc.sizeBytes,
      image: { data: Buffer.from(bytes).toString('base64'), mimeType: doc.mimeType },
    });
  }
  return { images, textDocumentIds };
}
