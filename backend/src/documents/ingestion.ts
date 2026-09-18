import { config } from '../config.js';
import { tenantQuery } from '../db/pool.js';
import { Errors } from '../errors.js';
import { s3Storage } from '../storage/storage.js';

export interface EmbeddingProvider {
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>;
}

export const internalEmbeddingProvider: EmbeddingProvider = {
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

async function scan(bytes: Uint8Array): Promise<boolean> {
  if (!config.MALWARE_SCANNER_ENDPOINT) return !config.MALWARE_SCAN_REQUIRED;
  const response = await fetch(config.MALWARE_SCANNER_ENDPOINT, {
    method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bytes,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) return false;
  const result = await response.json() as { clean?: boolean };
  return result.clean === true;
}

async function extract(bytes: Uint8Array, mimeType: string, filename: string): Promise<string> {
  if (mimeType.startsWith('text/')) return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!config.DOCUMENT_EXTRACTOR_ENDPOINT) {
    throw Errors.internal('Binary document extractor is not configured', undefined, 'EXTRACTOR_NOT_CONFIGURED');
  }
  const response = await fetch(config.DOCUMENT_EXTRACTOR_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': mimeType, 'x-document-filename': encodeURIComponent(filename) },
    body: bytes,
    signal: AbortSignal.timeout(120000),
  });
  if (!response.ok) throw Errors.internal('Document extraction failed', { status: response.status }, 'EXTRACTION_FAILED');
  const result = await response.json() as { text?: string };
  if (!result.text) throw Errors.internal('Document extractor returned no text', undefined, 'EXTRACTION_FAILED');
  return result.text;
}

export async function ingestDocument(documentId: string, tenantId: string): Promise<void> {
  const document = (
    await tenantQuery<{ object_key: string; mime_type: string; filename: string; classification: string }>(
      tenantId,
      `UPDATE documents SET status = 'PROCESSING', error_code = NULL, updated_at = NOW()
       WHERE id = $1 AND tenant_id = $2 AND deleted_at IS NULL
       RETURNING object_key, mime_type, filename, classification`,
      [documentId, tenantId]
    )
  ).rows[0];
  if (!document) throw Errors.notFound('DOCUMENT_NOT_FOUND', 'Document not found');
  if (document.classification === 'UNKNOWN') {
    await tenantQuery(tenantId, "UPDATE documents SET status = 'FAILED', error_code = 'CLASSIFICATION_REQUIRED', updated_at = NOW() WHERE id = $1", [documentId]);
    return;
  }
  try {
    const bytes = await s3Storage.get(document.object_key);
    if (!(await scan(bytes))) {
      await tenantQuery(tenantId, "UPDATE documents SET status = 'QUARANTINED', error_code = 'MALWARE_SCAN_FAILED', updated_at = NOW() WHERE id = $1", [documentId]);
      return;
    }
    const chunks = chunkText(await extract(bytes, document.mime_type, document.filename));
    if (chunks.length === 0) throw Errors.badRequest('EMPTY_DOCUMENT', 'No extractable document text found');
    const embeddings = await internalEmbeddingProvider.embed(chunks, AbortSignal.timeout(config.AI_REQUEST_TIMEOUT_MS));
    await tenantQuery(tenantId, 'DELETE FROM document_chunks WHERE document_id = $1', [documentId]);
    for (let index = 0; index < chunks.length; index += 1) {
      await tenantQuery(
        tenantId,
        `INSERT INTO document_chunks (document_id, tenant_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [documentId, tenantId, index, chunks[index], `[${embeddings[index]!.join(',')}]`]
      );
    }
    await tenantQuery(tenantId, "UPDATE documents SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1", [documentId]);
  } catch (error) {
    const code = error instanceof Error && 'code' in error ? String((error as any).code) : 'INGESTION_FAILED';
    await tenantQuery(tenantId, "UPDATE documents SET status = 'FAILED', error_code = $2, updated_at = NOW() WHERE id = $1", [documentId, code]);
    throw error;
  }
}
