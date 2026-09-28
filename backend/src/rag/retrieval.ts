import { config } from '../config.js';
import { AuthContext, CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { Db, Document } from 'mongodb';
import { getDb } from '../db/mongo.js';
import { internalEmbeddingProvider } from '../documents/ingestion.js';
import { createCrossEncoderReranker } from './crossEncoderReranker.js';
import { grantPrincipalOr } from './grants.js';

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

/**
 * Name of the Atlas Vector Search index on `document_chunks.embedding`
 * (1536 dims, cosine). IMPORTANT: Atlas Search / Vector Search indexes
 * CANNOT be created through the ordinary MongoDB driver index operations —
 * the driver has no API for them. This index must be provisioned via the
 * Atlas UI or the Atlas Admin API; see `backend/src/db/createVectorIndexes.ts`
 * and migration 003 for the exact definition.
 */
const VECTOR_SEARCH_INDEX = 'idx_document_chunks_embedding_vector';

/**
 * Bound for the application-side brute-force fallback (see below): the
 * maximum number of chunk documents pulled into memory when $vectorSearch
 * is unavailable. 2000 chunks x 1536 dims is ~25MB of vectors — large but
 * bounded, and this path only runs when Atlas Vector Search is missing.
 */
const VECTOR_FALLBACK_MAX_CANDIDATES = 2000;

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

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  return denominator === 0 ? 0 : dot / denominator;
}

function escapeUntrusted(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Light, deterministic query normalization before embedding: trim, collapse
 * internal whitespace runs, and cap length. No LLM query rewriting — the
 * embedding model sees the user's literal question.
 */
export function normalizeQuery(queryText: string): string {
  return queryText.trim().replace(/\s+/g, ' ').slice(0, config.RAG_QUERY_MAX_CHARS);
}

/**
 * Maximal-marginal-relevance-lite diversity pass over the hybrid-scored
 * candidates. Greedily selects up to topK chunks; a chunk from an already
 * represented document is discounted by `lambda`, so when the top results all
 * come from one document, the best chunk from a second document is blended in
 * instead of a near-duplicate sibling — provided it is competitive. lambda = 0
 * preserves strict top-K order. Deterministic: ties break by chunkId.
 */
export function applyDiversity(
  candidates: AuthorizedChunk[],
  topK: number,
  lambda: number
): AuthorizedChunk[] {
  if (lambda <= 0 || candidates.length <= topK) return candidates.slice(0, topK);
  const effective = (chunk: AuthorizedChunk, represented: Set<string>): number =>
    represented.has(chunk.documentId) ? chunk.score * (1 - lambda) : chunk.score;
  const selected: AuthorizedChunk[] = [];
  const represented = new Set<string>();
  const remaining = [...candidates];
  while (selected.length < topK && remaining.length > 0) {
    let best = 0;
    for (let i = 1; i < remaining.length; i += 1) {
      const contender = remaining[i]!;
      const incumbent = remaining[best]!;
      const contenderValue = effective(contender, represented);
      const incumbentValue = effective(incumbent, represented);
      if (
        contenderValue > incumbentValue ||
        (contenderValue === incumbentValue && contender.chunkId < incumbent.chunkId)
      ) {
        best = i;
      }
    }
    const picked = remaining.splice(best, 1)[0]!;
    selected.push(picked);
    represented.add(picked.documentId);
  }
  return selected;
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

let activeReranker: Reranker = config.RERANKER_ENABLED
  ? // The cross-encoder reranker is installed through the same setReranker()
    // hook point, so the untrusted-output reconstruction below (after
    // authorization filtering) applies unchanged: reranking can only reorder
    // authorized chunks and propose scores, never widen access. Default is
    // the passthrough preserving hybrid order (RERANKER_ENABLED=false).
    createCrossEncoderReranker()
  : {
      name: 'hybrid-score',
      rerank: (_queryText, chunks) => chunks,
    };

export function setReranker(reranker: Reranker): void {
  activeReranker = reranker;
}

export function getReranker(): Reranker {
  return activeReranker;
}

interface VectorCandidate {
  chunkId: string;
  content: string;
  documentId: string;
  classification: string;
  page: number | null;
  section: string | null;
  sourceLocation: string | null;
  /** Cosine similarity in [0,1]; pgvector's `1 - (embedding <=> query)` equivalent. */
  vectorScore: number;
}

interface AuthorizedDocument {
  _id: string;
  filename: string;
  classification: string;
}

/**
 * Owner-or-grant principal conditions for `document_permissions` (same
 * predicate as the documents routes: exactly one principal field per grant —
 * absent fields are omitted, never null — so the role/department/group
 * clauses are only added when the caller actually has that principal).
 *
 * Shared with the chat image path (chat/imageAttachments.ts), which mirrors
 * document authorization exactly. Re-exported here so existing importers of
 * `rag/retrieval.js` keep working.
 */
export { grantPrincipalOr };

/**
 * Resolve the documents the caller may read BEFORE any vector work runs:
 * tenant-scoped, READY, not deleted, classification within clearance, and
 * owner-or-grant authorized. Both the $vectorSearch path and the brute-force
 * fallback only ever see chunks of these documents, so neither path can widen
 * access.
 */
async function resolveAuthorizedDocuments(
  db: Db,
  auth: AuthContext,
  allowed: Classification[],
  documentIds?: string[]
): Promise<AuthorizedDocument[]> {
  const grants = await db.collection<{ documentId: string }>('document_permissions')
    .find(
      { tenantId: auth.tenantId, canRead: true, $or: await grantPrincipalOr(db, auth) },
      { projection: { documentId: 1 } }
    ).toArray();
  const grantedIds = [...new Set(grants.map((grant) => grant.documentId))];
  const or: Record<string, unknown>[] = [{ ownerId: auth.userId }];
  if (grantedIds.length > 0) or.push({ _id: { $in: grantedIds } });
  return db.collection<AuthorizedDocument>('documents').find(
    {
      tenantId: auth.tenantId,
      status: 'READY',
      deletedAt: null,
      classification: { $in: allowed },
      ...(documentIds?.length ? { _id: { $in: documentIds } } : {}),
      $or: or,
    },
    { projection: { filename: 1, classification: 1 } }
  ).toArray();
}

/**
 * Primary path: Atlas $vectorSearch over `document_chunks.embedding`. The
 * tenant / classification / embedding-provenance / ACL predicates that the old
 * pgvector query applied around the `<=>` ordering move into
 * `$vectorSearch.filter`; the ACL is enforced inside the vector search via
 * the pre-resolved authorized document IDs, so no post-filter can widen
 * access. Oversampling (limit topK*4) is preserved for the diversity pass.
 */
async function vectorSearchCandidates(
  db: Db,
  tenantId: string,
  embedding: number[],
  authorizedDocIds: string[],
  allowed: Classification[],
  model: string,
  version: string,
  dimensions: number,
  limit: number
): Promise<VectorCandidate[]> {
  const pipeline: Document[] = [
    {
      $vectorSearch: {
        index: VECTOR_SEARCH_INDEX,
        path: 'embedding',
        queryVector: embedding,
        numCandidates: limit,
        limit,
        filter: {
          tenantId,
          documentId: { $in: authorizedDocIds },
          classification: { $in: allowed },
          embeddingModel: model,
          embeddingVersion: version,
          embeddingDimensions: dimensions,
        },
      },
    },
    {
      $project: {
        content: 1,
        documentId: 1,
        classification: 1,
        page: 1,
        section: 1,
        sourceLocation: 1,
        vectorScore: { $meta: 'vectorSearchScore' },
      },
    },
  ];
  const rows = await db.collection('document_chunks').aggregate(pipeline).toArray();
  return rows.map((row) => ({
    chunkId: String(row._id),
    content: String(row.content ?? ''),
    documentId: String(row.documentId),
    classification: String(row.classification),
    page: typeof row.page === 'number' ? row.page : null,
    section: typeof row.section === 'string' ? row.section : null,
    sourceLocation: typeof row.sourceLocation === 'string' ? row.sourceLocation : null,
    vectorScore: typeof row.vectorScore === 'number' ? row.vectorScore : 0,
  }));
}

/**
 * Bounded fallback when Atlas Vector Search is unavailable (index not
 * provisioned, or running against a mongod without Atlas Search): fetch a
 * capped, tenant-scoped candidate set — already restricted to authorized
 * documents — validate each vector, and compute cosine similarity in
 * JavaScript. The candidate cap bounds memory/CPU; only finite scores flow
 * through, sorted deterministically with chunkId tie-breaks.
 */
async function bruteForceCandidates(
  db: Db,
  tenantId: string,
  embedding: number[],
  authorizedDocIds: string[],
  allowed: Classification[],
  model: string,
  version: string,
  dimensions: number,
  limit: number
): Promise<VectorCandidate[]> {
  const rows = await db.collection<{
    _id: string; content: string; documentId: string; classification: string;
    embedding: unknown; page: number | null; section: string | null; sourceLocation: string | null;
  }>('document_chunks').find(
    {
      tenantId,
      documentId: { $in: authorizedDocIds },
      classification: { $in: allowed },
      embeddingModel: model,
      embeddingVersion: version,
      embeddingDimensions: dimensions,
    },
    {
      projection: {
        content: 1, documentId: 1, classification: 1, embedding: 1,
        page: 1, section: 1, sourceLocation: 1,
      },
      sort: { createdAt: -1 },
      limit: VECTOR_FALLBACK_MAX_CANDIDATES,
    }
  ).toArray();
  const scored: VectorCandidate[] = [];
  for (const row of rows) {
    const vector = row.embedding;
    if (!Array.isArray(vector) || vector.length !== embedding.length) continue;
    if (!vector.every((value) => typeof value === 'number' && Number.isFinite(value))) continue;
    const similarity = cosineSimilarity(embedding, vector as number[]);
    if (!Number.isFinite(similarity)) continue;
    scored.push({
      chunkId: row._id,
      content: row.content,
      documentId: row.documentId,
      classification: row.classification,
      page: row.page,
      section: row.section,
      sourceLocation: row.sourceLocation,
      vectorScore: similarity,
    });
  }
  scored.sort((a, b) => b.vectorScore - a.vectorScore || (a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0));
  return scored.slice(0, limit);
}

/** True when the error signals $vectorSearch itself is unavailable (as opposed to a query bug). */
function isVectorSearchUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message = (error as { message?: unknown }).message;
  return typeof message === 'string' && /\$vectorSearch/i.test(message);
}

export async function retrieveAuthorizedContext(
  auth: AuthContext,
  queryText: string,
  documentIds?: string[],
  requestedTopK = 8
): Promise<RetrievalResult> {
  const topK = Math.min(Math.max(1, requestedTopK), config.RAG_TOP_K_MAX);
  const query = normalizeQuery(queryText);
  // An empty query has no retrievable meaning: return the empty retrieval
  // shape instead of embedding a meaningless vector.
  if (!query) return { context: '', citations: [], results: [] };
  const embeddingProvider = internalEmbeddingProvider();
  const [embedding] = await embeddingProvider.embed([query], { timeoutMs: config.EMBEDDING_TIMEOUT_MS });
  if (!embedding || embedding.length !== embeddingProvider.dimensions || !embedding.every(Number.isFinite)) {
    throw new Error('Embedding provider returned an invalid query vector');
  }
  const allowed = CLASSIFICATIONS.filter(
    (classification) => classification !== 'UNKNOWN' && canAccessClassification(auth.clearance, classification)
  ) as Classification[];
  const db = await getDb();
  // Authorization first: resolve the readable documents before any vector
  // work, so both the $vectorSearch path and the brute-force fallback only
  // ever score chunks of documents this caller may read.
  const authorizedDocs = await resolveAuthorizedDocuments(db, auth, allowed, documentIds);
  if (authorizedDocs.length === 0) return { context: '', citations: [], results: [] };
  const docById = new Map(authorizedDocs.map((doc) => [doc._id, doc]));
  const authorizedDocIds = authorizedDocs.map((doc) => doc._id);
  const candidateLimit = topK * 4;

  let candidates: VectorCandidate[];
  try {
    candidates = await vectorSearchCandidates(
      db, auth.tenantId, embedding, authorizedDocIds, allowed,
      embeddingProvider.model, embeddingProvider.version, embeddingProvider.dimensions, candidateLimit
    );
  } catch (error) {
    if (!isVectorSearchUnavailable(error)) throw error;
    // Atlas Vector Search is not provisioned here (or this mongod has no
    // Atlas Search): degrade to bounded application-side cosine scoring
    // over the same authorized document set — never a wider one.
    console.warn(`retrieveAuthorizedContext: $vectorSearch unavailable, using bounded brute-force fallback (${VECTOR_FALLBACK_MAX_CANDIDATES} candidates max)`);
    candidates = await bruteForceCandidates(
      db, auth.tenantId, embedding, authorizedDocIds, allowed,
      embeddingProvider.model, embeddingProvider.version, embeddingProvider.dimensions, candidateLimit
    );
  }

  const scored = candidates
    // The old query required dc.classification = d.classification with both
    // non-UNKNOWN: enforce the equality here for both vector paths, since
    // $vectorSearch.filter can only carry the $in predicate.
    .filter((candidate) => docById.get(candidate.documentId)?.classification === candidate.classification)
    .map((candidate) => {
      const doc = docById.get(candidate.documentId)!;
      const vectorScore = Math.max(0, Math.min(1, candidate.vectorScore));
      const score = (vectorScore * 0.85) + (lexicalScore(query, candidate.content) * 0.15);
      // Citations are populated exclusively from authorized data — never synthesized.
      // Every citation field (documentId/documentName/chunkId/page/section)
      // must trace back to an authorized document and candidate chunk.
      const citation: Citation = {
        documentId: candidate.documentId,
        documentName: doc.filename,
        chunkId: candidate.chunkId,
        ...(candidate.page ? { page: candidate.page } : {}),
        ...(candidate.section ? { section: candidate.section } : {}),
        ...(candidate.sourceLocation ? { sourceLocation: candidate.sourceLocation } : {}),
      };
      return { documentId: candidate.documentId, documentName: doc.filename, chunkId: candidate.chunkId,
        text: candidate.content, score, citation };
    }).sort((a, b) => b.score - a.score);

  // MMR-lite diversity pass: when the top hybrid hits all come from one
  // document, blend in the best chunk from another document so a single long
  // document cannot monopolize every topK slot.
  const selected = applyDiversity(scored, topK, config.RAG_DIVERSITY_LAMBDA);

  // Optional similarity floor (RAG_SIMILARITY_THRESHOLD, default 0 = disabled).
  // Applied after the hybrid rerank so low-relevance authorized chunks never
  // reach model context even when topK slots are unfilled.
  const reranked = await activeReranker.rerank(query, selected);
  // Reranker output is untrusted: reconstruct every result from the canonical
  // authorized candidate map instead of accepting the reranker's object. A
  // compromised reranker can therefore only reorder candidates and propose a
  // validated score — text, document, and citation fields are rebuilt from the
  // canonical candidate, so mutated content injected alongside a known chunkId
  // is discarded. Unknown or duplicated chunk IDs are dropped so only the
  // authorized set can flow through, in the reranker's order.
  const canonical = new Map(selected.map((result) => [result.chunkId, result]));
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
