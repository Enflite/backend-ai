import { randomUUID } from 'node:crypto';
import { config } from '../config.js';
import { tenantOp } from '../db/mongo.js';
import { Errors } from '../errors.js';
import { ObjectStorage, s3Storage } from '../storage/storage.js';
import { ExtractedSection, extractDocument } from './extraction.js';
import { MalwareScanner, malwareScanner, scanMayProceed } from './malware.js';

import type { EmbeddingProvider } from '../ai/providers/types.js';
import { resolveEmbeddingProvider } from '../ai/providers/factory.js';
export type { EmbeddingProvider };

/**
 * The platform embedding provider, resolved once from server configuration
 * via the provider factory. Document ingestion and RAG retrieval share this
 * instance so embeddings are always computed by the same backend — there is
 * exactly one embedding call-site family, and it lives behind the factory.
 *
 * Resolved lazily (not at module load) so tests can stub configuration
 * before first use.
 */
let cachedProvider: EmbeddingProvider | null = null;
export function internalEmbeddingProvider(): EmbeddingProvider {
  if (!cachedProvider) cachedProvider = resolveEmbeddingProvider();
  return cachedProvider;
}

/** Test-only: reset the cached provider so config stubs take effect. */
export function resetEmbeddingProviderCache(): void {
  cachedProvider = null;
}

export interface DocumentChunk {
  text: string;
  page?: number;
  section?: string;
  sourceLocation?: string;
}

/** Minimal document shape for ingestion state transitions. */
interface IngestionDocumentState {
  _id: string;
  tenantId: string;
  objectKey: string;
  mimeType: string;
  classification: string;
  status: string;
  errorCode: string | null;
  updatedAt: Date;
  deletedAt?: Date | null;
}

/** Shape of the `document_chunks` MongoDB documents (ADR-014). */
interface ChunkDoc {
  _id: string;
  documentId: string;
  tenantId: string;
  chunkIndex: number;
  content: string;
  /** Plain number array (not a pgvector type); 1536 dims per the embedding contract. */
  embedding: number[];
  classification: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  page: number | null;
  section: string | null;
  sourceLocation: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export function chunkText(
  text: string,
  maxCharacters = config.RAG_CHUNK_MAX_CHARS,
  overlap = config.RAG_CHUNK_OVERLAP
): string[] {
  if (!Number.isInteger(maxCharacters) || maxCharacters < 64) {
    throw new Error('chunkText: maxCharacters must be an integer >= 64');
  }
  if (!Number.isInteger(overlap) || overlap < 0 || overlap >= maxCharacters) {
    throw new Error('chunkText: overlap must be an integer in [0, maxCharacters)');
  }
  const normalized = text.replace(/\r\n/g, '\n').replace(/\u0000/g, '').trim();
  if (!normalized) return [];
  const chunks: string[] = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(start + maxCharacters, normalized.length);
    if (end < normalized.length) {
      const boundary = Math.max(normalized.lastIndexOf('\n', end), normalized.lastIndexOf(' ', end));
      if (boundary > start + maxCharacters / 2) end = boundary;
    }
    // Never split a UTF-16 surrogate pair: a lone surrogate is invalid UTF-8
    // and the MongoDB driver would reject the chunk insert.
    if (end > start && end < normalized.length) {
      const prev = normalized.charCodeAt(end - 1);
      const next = normalized.charCodeAt(end);
      if (prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end -= 1;
    }
    chunks.push(normalized.slice(start, end).trim());
    if (end === normalized.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return chunks.filter(Boolean);
}

export function chunkSections(sections: ExtractedSection[]): DocumentChunk[] {
  return sections.flatMap((source) => chunkText(source.text).map((text) => ({
    text,
    ...(source.page ? { page: source.page } : {}),
    ...(source.section ? { section: source.section } : {}),
    ...(source.sourceLocation ? { sourceLocation: source.sourceLocation } : {}),
  })));
}

interface IngestionDependencies {
  storage: ObjectStorage;
  scanner: MalwareScanner;
  extractor: typeof extractDocument;
  embeddings: EmbeddingProvider;
}

/**
 * Cooperative cancellation hook for the ingestion pipeline.
 *
 * The worker pool (backend/src/documents/queue.ts) passes a `shouldCancel`
 * closure that reads the job's `cancel_requested` flag. It is polled between
 * pipeline stages (fetch -> scan -> extract -> embed -> store); a truthy
 * result aborts ingestion by throwing IngestionCanceledError. Chunks are only
 * written in the final store stage, so aborting at a boundary leaves no
 * partial state behind.
 */
export interface IngestionHooks {
  shouldCancel?: () => boolean | Promise<boolean>;
}

/** Thrown when a cancellation hook fires mid-pipeline. Carries a stable code. */
export class IngestionCanceledError extends Error {
  readonly code = 'INGESTION_CANCELED';
  constructor() {
    super('Document ingestion was canceled');
    this.name = 'IngestionCanceledError';
  }
}

const defaultDependencies: IngestionDependencies = {
  storage: s3Storage,
  scanner: malwareScanner,
  extractor: extractDocument,
  // Resolved on first access (not at module load) so importing this module
  // never throws when embeddings are unconfigured — the error surfaces only
  // when an embedding is actually attempted.
  get embeddings() {
    return internalEmbeddingProvider();
  },
};

function assertValidVectors(vectors: number[][], dimensions: number): void {
  if (
    vectors.some(
      (vector) => vector.length !== dimensions || !vector.every((value) => Number.isFinite(value))
    )
  ) {
    throw Errors.internal('Embedding provider returned invalid vectors', undefined, 'INVALID_EMBEDDING_RESPONSE');
  }
}

function errorCode(error: unknown): string {
  if (error instanceof Error && 'code' in error) return String((error as Error & { code: unknown }).code).slice(0, 100);
  return 'INGESTION_FAILED';
}

export async function ingestDocument(
  documentId: string,
  tenantId: string,
  dependencies: IngestionDependencies = defaultDependencies,
  hooks: IngestionHooks = {}
): Promise<'READY' | 'QUARANTINED'> {
  const document = await tenantOp(tenantId, (db) =>
    db.collection<IngestionDocumentState>('documents').findOneAndUpdate(
      { _id: documentId, tenantId, deletedAt: null },
      { $set: { status: 'PROCESSING', errorCode: null, updatedAt: new Date() } },
      { returnDocument: 'after', projection: { objectKey: 1, mimeType: 1, classification: 1 } }
    )
  );
  if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
  if (document.classification === 'UNKNOWN') {
    await tenantOp(tenantId, (db) =>
      db.collection<IngestionDocumentState>('documents').updateOne(
        { _id: documentId, tenantId },
        { $set: { status: 'FAILED', errorCode: 'CLASSIFICATION_REQUIRED', updatedAt: new Date() } }
      )
    );
    throw Errors.badRequest('CLASSIFICATION_REQUIRED', 'Document classification is required before ingestion');
  }

  // Cooperative cancellation: polled between pipeline stages below.
  const throwIfCanceled = async (): Promise<void> => {
    if (hooks.shouldCancel && await hooks.shouldCancel()) {
      throw new IngestionCanceledError();
    }
  };

  try {
    const bytes = await dependencies.storage.get(document.objectKey);
    await throwIfCanceled();
    const scan = await dependencies.scanner.scan(bytes, AbortSignal.timeout(30000));
    if (!scanMayProceed(scan, document.classification)) {
      const code = scan.verdict === 'INFECTED' ? 'MALWARE_DETECTED' : 'SCANNER_UNAVAILABLE';
      await tenantOp(tenantId, (db) =>
        db.collection<IngestionDocumentState>('documents').updateOne(
          { _id: documentId, tenantId },
          { $set: { status: 'QUARANTINED', errorCode: code, updatedAt: new Date() } }
        )
      );
      return 'QUARANTINED';
    }
    await throwIfCanceled();

    const chunks = chunkSections(await dependencies.extractor(bytes, document.mimeType));
    if (chunks.length === 0) throw Errors.badRequest('EMPTY_DOCUMENT', 'No extractable document text found');
    await throwIfCanceled();
    // Warn well before the hard cap so operators see oversized documents
    // coming; the cap itself stays fail-closed (TOO_MANY_CHUNKS).
    if (chunks.length >= Math.floor(config.MAX_DOCUMENT_CHUNKS * 0.75)) {
      console.warn(
        `ingestDocument: document ${documentId} produced ${chunks.length} chunks ` +
        `(cap ${config.MAX_DOCUMENT_CHUNKS}); consider raising MAX_DOCUMENT_CHUNKS ` +
        `or RAG_CHUNK_MAX_CHARS for this tenant`
      );
    }
    if (chunks.length > config.MAX_DOCUMENT_CHUNKS) {
      throw Errors.badRequest('TOO_MANY_CHUNKS', 'Document exceeds the configured chunk limit');
    }

    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += config.EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + config.EMBEDDING_BATCH_SIZE);
      vectors.push(...await dependencies.embeddings.embed(
        batch.map((chunk) => chunk.text),
        AbortSignal.timeout(config.AI_REQUEST_TIMEOUT_MS)
      ));
    }
    if (vectors.length !== chunks.length) {
      throw Errors.internal('Embedding provider returned a partial response', undefined, 'INVALID_EMBEDDING_RESPONSE');
    }
    assertValidVectors(vectors, dependencies.embeddings.dimensions);
    await throwIfCanceled();

    await tenantOp(tenantId, async (db) => {
      // Re-ingestion replaces prior chunks for this document; the previous
      // chunks are removed before the new ones are written.
      await db.collection<ChunkDoc>('document_chunks').deleteMany({ tenantId, documentId });
      const now = new Date();
      // insertMany replaces the old multi-row INSERT batches: a single
      // round-trip per batch instead of one transaction per chunk (2000
      // chunks previously issued BEGIN/COMMIT per row).
      const INSERT_BATCH_ROWS = 200;
      for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_ROWS) {
        const slice = chunks.slice(offset, offset + INSERT_BATCH_ROWS);
        const docs: ChunkDoc[] = slice.map((chunk, sliceIndex) => {
          const index = offset + sliceIndex;
          return {
            _id: randomUUID(),
            documentId,
            tenantId,
            chunkIndex: index,
            content: chunk.text,
            // Provenance: chunkIndex is the document-global chunk offset; page,
            // section, and sourceLocation come from the extractor when
            // available; embeddingModel/version/dimensions pin the vector to
            // the provider configuration that produced it (retrieval filters
            // on all three).
            embedding: vectors[index]!,
            classification: document.classification,
            embeddingModel: dependencies.embeddings.model,
            embeddingVersion: dependencies.embeddings.version,
            embeddingDimensions: dependencies.embeddings.dimensions,
            page: chunk.page ?? null,
            section: chunk.section ?? null,
            sourceLocation: chunk.sourceLocation ?? null,
            createdAt: now,
            updatedAt: now,
          };
        });
        await db.collection<ChunkDoc>('document_chunks').insertMany(docs);
      }
      await db.collection<IngestionDocumentState>('documents').updateOne(
        { _id: documentId, tenantId },
        { $set: { status: 'READY', updatedAt: new Date() } }
      );
    });
    return 'READY';
  } catch (error) {
    if (error instanceof IngestionCanceledError) {
      // A canceled job must not strand the document in PROCESSING and must
      // not look like a failure: FAILED + INGESTION_CANCELED keeps it visible
      // and retryable via POST /documents/:id/retry.
      await tenantOp(tenantId, (db) =>
        db.collection<IngestionDocumentState>('documents').updateOne(
          { _id: documentId, tenantId },
          { $set: { status: 'FAILED', errorCode: 'INGESTION_CANCELED', updatedAt: new Date() } }
        )
      );
      throw error;
    }
    await tenantOp(tenantId, (db) =>
      db.collection<IngestionDocumentState>('documents').updateOne(
        { _id: documentId, tenantId, status: { $ne: 'QUARANTINED' } },
        { $set: { status: 'FAILED', errorCode: errorCode(error), updatedAt: new Date() } }
      )
    );
    throw error;
  }
}
