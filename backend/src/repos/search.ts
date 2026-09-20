import { z } from 'zod';
import { AuthContext, CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { withTenant } from '../db/pool.js';
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

  const rows = await withTenant(auth.tenantId, async (client) => {
    await client.query('SET LOCAL hnsw.ef_search = 200');
    return (
      await client.query<{
        repo: string;
        path: string;
        chunk_index: number;
        content: string;
        commit_sha: string | null;
        vector_score: string;
      }>(
        `SELECT r.name AS repo, c.path, c.chunk_index, c.content, c.commit_sha,
                (1 - (c.embedding <=> $5::vector)) AS vector_score
         FROM repo_code_chunks c
         JOIN repos r ON r.id = c.repo_id AND r.tenant_id = c.tenant_id
         WHERE c.tenant_id = $1
           AND r.status = 'READY'
           AND c.classification = ANY($2::text[])
           AND c.embedding_model = $6 AND c.embedding_version = $7 AND c.embedding_dimensions = $8
           AND ($3::text IS NULL OR r.name = $3)
         ORDER BY c.embedding <=> $5::vector
         LIMIT $4`,
        [
          auth.tenantId,
          allowed,
          input.repo ?? null,
          topK,
          `[${embedding!.join(',')}]`,
          provider.model,
          provider.version,
          provider.dimensions,
        ]
      )
    ).rows;
  });

  return rows.map((row) => {
    const vectorScore = Math.max(0, Math.min(1, Number(row.vector_score)));
    const content = row.content.length > SNIPPET_MAX_CHARS ? `${row.content.slice(0, SNIPPET_MAX_CHARS)}\n… [truncated]` : row.content;
    return {
      repo: row.repo,
      path: row.path,
      chunkIndex: row.chunk_index,
      score: Math.round(vectorScore * 1000) / 1000,
      snippet: content,
      commitSha: row.commit_sha,
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
  const rows = await withTenant(auth.tenantId, async (client) => {
    return (
      await client.query<{ content: string; commit_sha: string | null; classification: Classification }>(
        `SELECT f.content, f.commit_sha, f.classification
         FROM repo_files f
         JOIN repos r ON r.id = f.repo_id AND r.tenant_id = f.tenant_id
         WHERE f.tenant_id = $1 AND r.name = $2 AND r.status = 'READY' AND f.path = $3`,
        [auth.tenantId, name, normalized]
      )
    ).rows;
  });
  if (rows.length === 0) throw Errors.notFound('REPO_FILE_NOT_FOUND', 'File not found in the indexed repository');
  const row = rows[0]!;
  if (!canAccessClassification(auth.clearance, row.classification) || row.classification === 'UNKNOWN') {
    throw Errors.forbidden('REPO_FILE_CLASSIFICATION_DENIED', 'Clearance does not cover this file');
  }
  const MAX_READ_CHARS = 100_000;
  const full = row.content;
  const truncated = full.length > MAX_READ_CHARS;
  return {
    repo: name,
    path: normalized,
    content: truncated ? `${full.slice(0, MAX_READ_CHARS)}\n… [truncated at ${MAX_READ_CHARS} chars]` : full,
    truncated,
    commitSha: row.commit_sha,
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
