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

export const internalEmbeddingProvider: EmbeddingProvider = {
  model: config.EMBEDDING_MODEL ?? '',
  version: config.EMBEDDING_MODEL_VERSION,
  dimensions: config.EMBEDDING_DIMENSIONS,
  async embed(texts, signal) {
    if (!config.EMBEDDING_BASE_URL || !config.EMBEDDING_MODEL) {
      throw Errors.internal('Internal embedding provider is not configured', undefined, 'EMBEDDING_NOT_CONFIGURED');
    }
    const response = await fetch(`${config.EMBEDDING_BASE_URL.replace(/\/+$/, '')}/embeddings`, {
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

export function chunkText(text: string, maxCharacters = 1600, overlap = 200): string[] {
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
