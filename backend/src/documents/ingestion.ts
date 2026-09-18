import { config } from '../config.js';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { ObjectStorage, s3Storage } from '../storage/storage.js';
import { ExtractedSection, extractDocument } from './extraction.js';
import { MalwareScanner, malwareScanner, scanMayProceed } from './malware.js';

export interface EmbeddingProvider {
  readonly model: string;
  readonly version: string;
  readonly dimensions: number;
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

/**
 * Embeddings are idempotent (same input -> same output, no side effects), so a
 * small bounded retry with jitter is safe here — unlike streaming inference,
 * which the gateway never retries and instead fails over to another model.
 */
async function fetchWithRetry(input: string, init: RequestInit, attempts = 3): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Never retry after cancellation: an aborted job must stop immediately.
    if (init.signal?.aborted) throw new Error('Embedding request aborted');
    try {
      const response = await fetch(input, init);
      // Retry transient 5xx/429; 4xx is deterministic (bad request) and surfaces.
      if ((response.status >= 500 || response.status === 429) && attempt < attempts) {
        await response.arrayBuffer().catch(() => undefined);
      } else {
        return response;
      }
    } catch (error) {
      lastError = error;
      // AbortError (cancellation/timeout) is not transient: rethrow at once.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      if (attempt === attempts) throw error;
    }
    const backoffMs = Math.min(2000, 150 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 100);
    // Abort-aware sleep: a cancelled job must not linger in backoff.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new Error('Embedding request aborted'));
      };
      const timer = setTimeout(() => {
        init.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, backoffMs);
      init.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
  throw lastError instanceof Error ? lastError : new Error('Embedding provider request failed');
}

export const internalEmbeddingProvider: EmbeddingProvider = {
  model: config.EMBEDDING_MODEL ?? '',
  version: config.EMBEDDING_MODEL_VERSION,
  dimensions: config.EMBEDDING_DIMENSIONS,
  async embed(texts, signal) {
    if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
      throw Errors.internal('Internal embedding provider is not configured', undefined, 'EMBEDDING_NOT_CONFIGURED');
    }
    const response = await fetchWithRetry(`${config.EMBEDDING_BASE_URL.replace(/\/+$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.EMBEDDING_API_KEY ? { authorization: `Bearer ${config.EMBEDDING_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model: config.EMBEDDING_MODEL, input: texts }),
      signal,
    });
    if (!response.ok) throw Errors.internal('Embedding provider request failed', { status: response.status }, 'EMBEDDING_PROVIDER_ERROR');
    const payload = await response.json() as { data?: Array<{ embedding?: number[]; index?: number }> };
    const ordered = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (ordered.length !== texts.length || ordered.some((item) => !Array.isArray(item.embedding) || item.embedding.length !== config.EMBEDDING_DIMENSIONS)) {
      throw Errors.internal('Embedding provider returned invalid dimensions', undefined, 'INVALID_EMBEDDING_RESPONSE');
    }
    return ordered.map((item) => item.embedding!);
  },
};

export interface DocumentChunk {
  text: string;
  page?: number;
  section?: string;
  sourceLocation?: string;
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
    // and PostgreSQL would reject the chunk insert.
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

const defaultDependencies: IngestionDependencies = {
  storage: s3Storage,
  scanner: malwareScanner,
  extractor: extractDocument,
  embeddings: internalEmbeddingProvider,
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
  dependencies: IngestionDependencies = defaultDependencies
): Promise<'READY' | 'QUARANTINED'> {
  const document = (
    await tenantQuery<{ object_key: string; mime_type: string; classification: string }>(
      tenantId,
      `UPDATE documents SET status = 'PROCESSING', error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING object_key, mime_type, classification`,
      [documentId, tenantId]
    )
  ).rows[0];
  if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
  if (document.classification === 'UNKNOWN') {
    await tenantQuery(tenantId, "UPDATE documents SET status = 'FAILED', error_code = 'CLASSIFICATION_REQUIRED', updated_at = NOW() WHERE id = $1", [documentId]);
    throw Errors.badRequest('CLASSIFICATION_REQUIRED', 'Document classification is required before ingestion');
  }

  try {
    const bytes = await dependencies.storage.get(document.object_key);
    const scan = await dependencies.scanner.scan(bytes, AbortSignal.timeout(30000));
    if (!scanMayProceed(scan, document.classification)) {
      const code = scan.verdict === 'INFECTED' ? 'MALWARE_DETECTED' : 'SCANNER_UNAVAILABLE';
      await tenantQuery(tenantId, "UPDATE documents SET status = 'QUARANTINED', error_code = $2, updated_at = NOW() WHERE id = $1", [documentId, code]);
      return 'QUARANTINED';
    }

    const chunks = chunkSections(await dependencies.extractor(bytes, document.mime_type));
    if (chunks.length === 0) throw Errors.badRequest('EMPTY_DOCUMENT', 'No extractable document text found');
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

    await tenantQuery(tenantId, 'DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
    // Multi-row inserts keep large documents from issuing one transaction per
    // chunk (2000 chunks x BEGIN/COMMIT round-trips previously).
    const INSERT_BATCH_ROWS = 200;
    const INSERT_COLUMNS = 12;
    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_ROWS) {
      const slice = chunks.slice(offset, offset + INSERT_BATCH_ROWS);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      slice.forEach((chunk, sliceIndex) => {
        const index = offset + sliceIndex;
        const base = sliceIndex * INSERT_COLUMNS;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5}::vector,$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`
        );
        params.push(
          documentId, tenantId, index, chunk.text, `[${vectors[index]!.join(',')}]`, document.classification,
          dependencies.embeddings.model, dependencies.embeddings.version, dependencies.embeddings.dimensions,
          chunk.page ?? null, chunk.section ?? null, chunk.sourceLocation ?? null
        );
      });
      await tenantQuery(
        tenantId,
        // Provenance: chunk_index is the document-global chunk offset; page,
        // section, and source_location come from the extractor when available;
        // embedding_model/version/dimensions pin the vector to the provider
        // configuration that produced it (retrieval filters on all three).
        `INSERT INTO document_chunks (
          document_id, tenant_id, chunk_index, content, embedding, classification,
          embedding_model, embedding_version, embedding_dimensions, page, section, source_location
        ) VALUES ${placeholders.join(',')}`,
        params
      );
    }
    await tenantQuery(tenantId, "UPDATE documents SET status = 'READY', updated_at = NOW() WHERE id = $1", [documentId]);
    return 'READY';
  } catch (error) {
    await tenantQuery(tenantId, "UPDATE documents SET status = 'FAILED', error_code = $2, updated_at = NOW() WHERE id = $1 AND status <> 'QUARANTINED'", [documentId, errorCode(error)]);
    throw error;
  }
}
