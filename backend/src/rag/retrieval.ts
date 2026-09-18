import { config } from '../config.js';
import { AuthContext, CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { tenantQuery, withTenant } from '../db/pool.js';
import { internalEmbeddingProvider } from '../documents/ingestion.js';

export interface Citation {
  documentId: string;
  documentName: string;
  chunkId: string;
  page?: number;
  section?: string;
  sourceLocation?: string;
}

export interface AuthorizedChunk {
  documentId: string;
  documentName: string;
  chunkId: string;
  text: string;
  score: number;
  citation: Citation;
}

export interface RetrievalResult {
  context: string;
  citations: Citation[];
  results: AuthorizedChunk[];
}

function terms(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);
}

function lexicalScore(query: string, content: string): number {
  const wanted = terms(query);
  if (wanted.size === 0) return 0;
  const found = terms(content);
  let matches = 0;
  for (const term of wanted) if (found.has(term)) matches += 1;
  return matches / wanted.size;
}

function escapeUntrusted(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Reranker hook point. Retrieval always applies the in-process hybrid score
 * (85% vector cosine + 15% lexical overlap) over already-authorized candidates;
 * an operator may inject an external reranker (e.g. a cross-encoder service) via
 * setReranker(). The default is a passthrough that preserves hybrid order.
 *
 * The hook runs AFTER authorization filtering and BEFORE the similarity
 * threshold, so a reranker can reorder but never widen access. The reranker's
 * output is untrusted: every returned result is reconstructed from the
 * canonical authorized candidate map (matched by chunkId), so a compromised
 * or buggy reranker can only reorder candidates and propose a validated score —
 * its text, document, and citation fields are always discarded.
 */
export interface Reranker {
  name: string;
  rerank(queryText: string, chunks: AuthorizedChunk[]): Promise<AuthorizedChunk[]> | AuthorizedChunk[];
}

let activeReranker: Reranker = {
  name: 'hybrid-score',
  rerank: (_queryText, chunks) => chunks,
};

export function setReranker(reranker: Reranker): void {
  activeReranker = reranker;
}

export function getReranker(): Reranker {
  return activeReranker;
}

export async function retrieveAuthorizedContext(
  auth: AuthContext,
  queryText: string,
  documentIds?: string[],
  requestedTopK = 8
): Promise<RetrievalResult> {
  const topK = Math.min(Math.max(1, requestedTopK), config.RAG_TOP_K_MAX);
  const [embedding] = await internalEmbeddingProvider.embed([queryText], AbortSignal.timeout(30000));
  if (!embedding || embedding.length !== internalEmbeddingProvider.dimensions || !embedding.every(Number.isFinite)) {
    throw new Error('Embedding provider returned an invalid query vector');
  }
  const allowed = CLASSIFICATIONS.filter(
    (classification) => classification !== 'UNKNOWN' && canAccessClassification(auth.clearance, classification)
  ) as Classification[];
  const rows = await withTenant(auth.tenantId, async (client) => {
    // The ANN traversal runs under selective tenant/ACL filters, so the
    // default ef_search (40) under-recalls. Raise it for this retrieval
    // transaction only (SET LOCAL dies with the transaction).
    await client.query('SET LOCAL hnsw.ef_search = 200');
    return (
      await client.query<{
        chunk_id: string; content: string; page: number | null; section: string | null;
        source_location: string | null; document_id: string; filename: string; vector_score: string;
      }>(
      `SELECT dc.id AS chunk_id, dc.content, dc.page, dc.section, dc.source_location,
              d.id AS document_id, d.filename, (1 - (dc.embedding <=> $6::vector)) AS vector_score
       FROM document_chunks dc
       JOIN documents d ON d.id = dc.document_id AND d.tenant_id = dc.tenant_id
       WHERE dc.tenant_id = $1 AND d.status = 'READY' AND d.deleted_at IS NULL
         AND d.classification = ANY($2::text[]) AND dc.classification = d.classification
         AND dc.embedding_model = $7 AND dc.embedding_version = $8 AND dc.embedding_dimensions = $9
         AND ($3::uuid[] IS NULL OR d.id = ANY($3::uuid[]))
         AND (
           d.owner_id = $4 OR EXISTS (
             SELECT 1 FROM document_permissions dp
             WHERE dp.document_id = d.id AND dp.tenant_id = $1 AND dp.can_read
               AND (
                 dp.user_id = $4 OR dp.role_id = $5
                 OR (dp.department_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM department_memberships dm
                   WHERE dm.tenant_id = $1 AND dm.department_id = dp.department_id AND dm.user_id = $4
                 ))
                 OR (dp.group_id IS NOT NULL AND EXISTS (
                   SELECT 1 FROM security_group_memberships gm
                   WHERE gm.tenant_id = $1 AND gm.group_id = dp.group_id AND gm.user_id = $4
                 ))
               )
           )
         )
       ORDER BY dc.embedding <=> $6::vector
       LIMIT $10`,
      [auth.tenantId, allowed, documentIds?.length ? documentIds : null, auth.userId, auth.roleId,
        `[${embedding!.join(',')}]`, internalEmbeddingProvider.model, internalEmbeddingProvider.version,
        internalEmbeddingProvider.dimensions, topK * 4]
      )
    ).rows;
  });

  const results = rows.map((row) => {
    const vectorScore = Math.max(0, Math.min(1, Number(row.vector_score)));
    const score = (vectorScore * 0.85) + (lexicalScore(queryText, row.content) * 0.15);
    const citation: Citation = {
      documentId: row.document_id,
      documentName: row.filename,
      chunkId: row.chunk_id,
      ...(row.page ? { page: row.page } : {}),
      ...(row.section ? { section: row.section } : {}),
      ...(row.source_location ? { sourceLocation: row.source_location } : {}),
    };
    return { documentId: row.document_id, documentName: row.filename, chunkId: row.chunk_id,
      text: row.content, score, citation };
  }).sort((a, b) => b.score - a.score).slice(0, topK);

  // Optional similarity floor (RAG_SIMILARITY_THRESHOLD, default 0 = disabled).
  // Applied after the hybrid rerank so low-relevance authorized chunks never
  // reach model context even when topK slots are unfilled.
  const reranked = await activeReranker.rerank(queryText, results);
  // Reranker output is untrusted: reconstruct every result from the canonical
  // authorized candidate map instead of accepting the reranker's object. A
  // compromised reranker can therefore only reorder candidates and propose a
  // validated score — text, document, and citation fields are rebuilt from the
  // canonical candidate, so mutated content injected alongside a known chunkId
  // is discarded. Unknown or duplicated chunk IDs are dropped so only the
  // SQL-authorized set can flow through, in the reranker's order.
  const canonical = new Map(results.map((result) => [result.chunkId, result]));
  const seen = new Set<string>();
  const sanitized: AuthorizedChunk[] = [];
  for (const chunk of reranked) {
    if (!chunk || typeof chunk !== 'object') continue;
    const id = (chunk as { chunkId?: unknown }).chunkId;
    const base = typeof id === 'string' ? canonical.get(id) : undefined;
    if (!base || seen.has(base.chunkId)) continue;
    seen.add(base.chunkId);
    // The reranker may propose a new score, but only a finite number is
    // accepted, clamped to the [0,1] hybrid-score contract; a non-finite or
    // missing score keeps the canonical one.
    const proposed = Number((chunk as AuthorizedChunk).score);
    const score = Number.isFinite(proposed)
      ? Math.max(0, Math.min(1, proposed))
      : base.score;
    sanitized.push({
      documentId: base.documentId,
      documentName: base.documentName,
      chunkId: base.chunkId,
      text: base.text,
      score,
      citation: { ...base.citation },
    });
  }
  const threshold = config.RAG_SIMILARITY_THRESHOLD;
  const qualified = threshold > 0 ? sanitized.filter((result) => result.score >= threshold) : sanitized;

  const included: AuthorizedChunk[] = [];
  let characters = 0;
  for (const result of qualified) {
    if (characters + result.text.length > config.MAX_RAG_CONTEXT_CHARACTERS) break;
    included.push(result);
    characters += result.text.length;
  }
  const context = included.map((result, index) =>
    `<untrusted_document citation="${index + 1}" document_id="${result.documentId}" chunk_id="${result.chunkId}">\n${escapeUntrusted(result.text)}\n</untrusted_document>`
  ).join('\n\n');
  return { context, citations: included.map((result) => result.citation), results: included };
}
