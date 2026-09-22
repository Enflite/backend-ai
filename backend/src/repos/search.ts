import { z } from 'zod';
import { AuthContext, CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { Filter } from 'mongodb';
import { getDb } from '../db/mongo.js';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { internalEmbeddingProvider } from '../documents/ingestion.js';
import { repoNameSchema } from './registry.js';

/**
 * Semantic search over indexed repository code.
 *
 * Tenant-scoped, classification-filtered, and pinned to the embedding
 * model/version/dimensions that produced the vectors — a reconfigured
 * embedding provider never silently matches stale vectors. Results carry
 * repo + path provenance so the model can cite real locations and chain
 * into repo.readFile.
 *
 * Vector search runs as an Atlas `$vectorSearch` aggregation on
 * `repo_code_chunks.embedding`. The vector search index
 * (`idx_repo_code_chunks_embedding_vector`, 1536 dims, cosine) CANNOT be
 * created through the MongoDB driver — provision it via the Atlas UI/API or
 * `backend/src/db/createVectorIndexes.ts` (see migration 005). When the
 * index is unavailable, search falls back to application-side brute-force
 * cosine over a bounded candidate set.
 */

export const searchCodeSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    repo: repoNameSchema.optional(),
    topK: z.number().int().min(1).max(50).default(8),
  })
  .strict();

export type SearchCodeInput = z.infer<typeof searchCodeSchema>;

export interface CodeSearchHit {
  repo: string;
  path: string;
  chunkIndex: number;
  score: number;
  /** Chunk text, capped for model context; the full file is one repo.readFile away. */
  snippet: string;
  commitSha: string | null;
}

const SNIPPET_MAX_CHARS = 3000;

/** Document shape for the `repos` collection (only the fields this module reads). */
interface RepoDoc {
  _id: string;
  tenantId: string;
  name: string;
  status: string;
}

/** Document shape for the `repo_files` collection (only the fields this module reads). */
interface RepoFileDoc {
  _id: string;
  tenantId: string;
  repoId: string;
  path: string;
  content: string;
  classification: string;
  commitSha: string | null;
}

/** Document shape for the `repo_code_chunks` collection (only the fields this module reads). */
interface RepoChunkDoc {
  _id: string;
  tenantId: string;
  repoId: string;
  path: string;
  chunkIndex: number;
  content: string;
  embedding: number[];
  classification: string;
  embeddingModel: string;
  embeddingVersion: string;
  embeddingDimensions: number;
  commitSha: string | null;
}

/** Name of the Atlas Vector Search index on repo_code_chunks.embedding. */
const REPO_VECTOR_INDEX = 'idx_repo_code_chunks_embedding_vector';

/** Bounded candidate set for the application-side brute-force fallback. */
const BRUTE_FORCE_CANDIDATE_LIMIT = 2000;

interface ChunkCandidate {
  repoId: string;
  path: string;
  chunkIndex: number;
  content: string;
  commitSha: string | null;
  embedding?: number[];
  vectorScore?: number;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Resolve the tenant's READY repos (optionally narrowed to one name) to an
 * id → name map. Repo status lives on the `repos` collection, not on the
 * chunks, so status=READY is enforced by restricting the vector search to
 * these repoIds — the application-level equivalent of the old SQL join.
 */
async function readyRepoMap(
  db: Awaited<ReturnType<typeof getDb>>,
  tenantId: string,
  repoName?: string
): Promise<Map<string, string>> {
  const filter: Filter<RepoDoc> = { tenantId, status: 'READY' };
  if (repoName) filter.name = repoName;
  const repos = await db
    .collection<RepoDoc>('repos')
    .find(filter)
    .project({ _id: 1, name: 1 })
    .toArray();
  return new Map(repos.map((repo) => [String(repo._id), String(repo.name)]));
}

export async function searchIndexedCode(auth: AuthContext, input: SearchCodeInput): Promise<CodeSearchHit[]> {
  const topK = Math.min(input.topK, config.REPO_SEARCH_TOP_K_MAX);
  const provider = internalEmbeddingProvider();
  const [embedding] = await provider.embed([input.query], { timeoutMs: config.EMBEDDING_TIMEOUT_MS });
  if (!embedding || embedding.length !== provider.dimensions || !embedding.every(Number.isFinite)) {
    throw new Error('Embedding provider returned an invalid query vector');
  }
  const allowed = CLASSIFICATIONS.filter(
    (classification) => classification !== 'UNKNOWN' && canAccessClassification(auth.clearance, classification)
  ) as Classification[];
  if (allowed.length === 0) return [];

  const db = await getDb();
  const repoMap = await readyRepoMap(db, auth.tenantId, input.repo);
  if (repoMap.size === 0) return [];
  const repoIds = [...repoMap.keys()];

  // Provenance pins: a reconfigured embedding provider never silently
  // matches stale vectors.
  const provenance = {
    embeddingModel: provider.model,
    embeddingVersion: provider.version,
    embeddingDimensions: provider.dimensions,
  };

  let candidates: ChunkCandidate[];
  try {
    // Atlas $vectorSearch: tenant, repo (READY-only, via repoIds),
    // classification, and embedding provenance all ride in the filter.
    // NOTE: the vector search index must be created via the Atlas UI/API
    // (or backend/src/db/createVectorIndexes.ts) — the driver cannot
    // create Atlas Search indexes.
    const pipeline = [
      {
        $vectorSearch: {
          index: REPO_VECTOR_INDEX,
          path: 'embedding',
          queryVector: embedding,
          numCandidates: Math.min(topK * 20, 1000),
          limit: topK,
          filter: {
            tenantId: auth.tenantId,
            repoId: { $in: repoIds },
            classification: { $in: allowed },
            ...provenance,
          },
        },
      },
      {
        $project: {
          _id: 0,
          repoId: 1,
          path: 1,
          chunkIndex: 1,
          content: 1,
          commitSha: 1,
          vectorScore: { $meta: 'vectorSearchScore' },
        },
      },
    ];
    candidates = (await db.collection<RepoChunkDoc>('repo_code_chunks').aggregate(pipeline).toArray()) as ChunkCandidate[];
  } catch {
    // Atlas Search unavailable (index not provisioned, non-Atlas mongod):
    // application-side brute-force cosine over a bounded candidate set.
    // Slower, but keeps code search functional without Atlas Search.
    const docs = await db
      .collection<RepoChunkDoc>('repo_code_chunks')
      .find({
        tenantId: auth.tenantId,
        repoId: { $in: repoIds },
        classification: { $in: allowed },
        ...provenance,
      })
      .project({ repoId: 1, path: 1, chunkIndex: 1, content: 1, commitSha: 1, embedding: 1 })
      .limit(BRUTE_FORCE_CANDIDATE_LIMIT)
      .toArray();
    candidates = (docs as unknown as ChunkCandidate[])
      .filter((doc) => Array.isArray(doc.embedding) && doc.embedding.length === embedding.length)
      .map((doc) => ({ ...doc, vectorScore: cosineSimilarity(embedding, doc.embedding!) }))
      .sort((a, b) => (b.vectorScore ?? 0) - (a.vectorScore ?? 0))
      .slice(0, topK);
  }

  return candidates.map((candidate) => {
    const vectorScore = Math.max(0, Math.min(1, Number(candidate.vectorScore ?? 0)));
    const content =
      candidate.content.length > SNIPPET_MAX_CHARS
        ? `${candidate.content.slice(0, SNIPPET_MAX_CHARS)}\n… [truncated]`
        : candidate.content;
    return {
      repo: repoMap.get(candidate.repoId) ?? candidate.repoId,
      path: candidate.path,
      chunkIndex: candidate.chunkIndex,
      score: Math.round(vectorScore * 1000) / 1000,
      snippet: content,
      commitSha: candidate.commitSha ?? null,
    };
  });
}

/**
 * Read a file from a synced repo. Content comes from the exact indexed file
 * row (`repo_files`), not from re-stitched chunks, so the tool returns
 * byte-exact content as indexed at the pinned commit. The path is confined
 * to the repo: absolute paths and `..` escapes are rejected, matching the
 * codeFiles path discipline in chat/codeContext.ts.
 */
export async function readRepoFile(
  auth: AuthContext,
  repoName: string,
  filePath: string
): Promise<{ repo: string; path: string; content: string; truncated: boolean; commitSha: string | null }> {
  const name = repoNameSchema.parse(repoName);
  const normalized = normalizeRepoPath(filePath);
  const db = await getDb();
  // READY status is enforced by resolving the repo first (status lives on
  // the repos collection, not the file rows).
  const repo = await db.collection<RepoDoc>('repos').findOne({ tenantId: auth.tenantId, name, status: 'READY' });
  if (!repo) throw Errors.notFound('REPO_FILE_NOT_FOUND', 'File not found in the indexed repository');
  const file = await db.collection<RepoFileDoc>('repo_files').findOne({
    tenantId: auth.tenantId,
    repoId: String(repo._id),
    path: normalized,
  });
  if (!file) throw Errors.notFound('REPO_FILE_NOT_FOUND', 'File not found in the indexed repository');
  const classification = file.classification as Classification;
  if (!canAccessClassification(auth.clearance, classification) || classification === 'UNKNOWN') {
    throw Errors.forbidden('REPO_FILE_CLASSIFICATION_DENIED', 'Clearance does not cover this file');
  }
  const MAX_READ_CHARS = 100_000;
  const full = String(file.content);
  const truncated = full.length > MAX_READ_CHARS;
  return {
    repo: name,
    path: normalized,
    content: truncated ? `${full.slice(0, MAX_READ_CHARS)}\n… [truncated at ${MAX_READ_CHARS} chars]` : full,
    truncated,
    commitSha: (file.commitSha as string | null) ?? null,
  };
}

/** Repo-relative path normalization: no absolute paths, no `..` escapes. Exported for tests. */
export function normalizeRepoPath(filePath: string): string {
  const trimmed = filePath.trim().replace(/\\/g, '/');
  if (!trimmed || trimmed.length > 500) {
    throw Errors.badRequest('INVALID_REPO_PATH', 'Repo path must be 1-500 characters');
  }
  const segments = trimmed.split('/').filter((segment) => segment.length > 0 && segment !== '.');
  if (segments.length === 0 || segments.some((segment) => segment === '..')) {
    throw Errors.badRequest('INVALID_REPO_PATH', 'Repo path must be relative and may not escape the repository');
  }
  if (trimmed.startsWith('/')) {
    throw Errors.badRequest('INVALID_REPO_PATH', 'Repo path must be relative, not absolute');
  }
  return segments.join('/');
}
