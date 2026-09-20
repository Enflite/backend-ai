import { z } from 'zod';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { tenantQuery, withTenantTx } from '../db/pool.js';
import { Errors } from '../errors.js';
import { CLASSIFICATIONS, Classification } from '../authz/permissions.js';
import { config } from '../config.js';

/**
 * Registry for indexed source-code repositories (multi-repo code search).
 *
 * A repo is registered per tenant with exactly one source:
 * - `gitUrl`: cloned/updated by the indexer (private hosts authenticate with
 *   the GITHUB_TOKEN server secret — never stored on the repo row), or
 * - `localPath`: read directly from the backend host filesystem.
 *
 * Index state lives on the row (`status`, `commitSha`, `chunkCount`,
 * `lastSyncedAt`, `lastError`) so operators can see freshness per repo.
 * Chunks are namespaced by repo_id, so identically-named files in different
 * repos never collide at retrieval time.
 */

export const REPO_STATUSES = ['PENDING', 'SYNCING', 'READY', 'FAILED'] as const;
export type RepoStatus = (typeof REPO_STATUSES)[number];

export interface RepoRecord {
  id: string;
  tenantId: string;
  name: string;
  gitUrl: string | null;
  localPath: string | null;
  defaultBranch: string;
  classification: Classification;
  status: RepoStatus;
  commitSha: string | null;
  chunkCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export const repoNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, 'Repo name may contain letters, digits, dot, underscore, and hyphen');

const gitUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/\S+$/, 'gitUrl must be an http(s) URL');

const localPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .regex(/^\//, 'localPath must be an absolute path');

export const createRepoSchema = z
  .object({
    name: repoNameSchema,
    gitUrl: gitUrlSchema.optional(),
    localPath: localPathSchema.optional(),
    // Branch names are passed to `git clone --branch` / `fetch` / `reset`
    // via execFile (no shell), but a leading dash would still be parsed as
    // a git option — reject it, along with `..` and stray slashes.
    defaultBranch: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._/-]+$/)
      .refine((branch) => !branch.startsWith('-') && !branch.startsWith('/') && !branch.endsWith('/') && !branch.includes('..'), {
        message: 'Invalid default branch name',
      })
      .default('main'),
    classification: z.enum(CLASSIFICATIONS).default('INTERNAL'),
  })
  .strict()
  .refine((value) => Boolean(value.gitUrl) !== Boolean(value.localPath), {
    message: 'Exactly one of gitUrl or localPath must be provided',
  });

export type CreateRepoInput = z.infer<typeof createRepoSchema>;

const ROW_COLUMNS = `
  id, tenant_id AS "tenantId", name,
  git_url AS "gitUrl", local_path AS "localPath",
  default_branch AS "defaultBranch", classification, status,
  commit_sha AS "commitSha", chunk_count AS "chunkCount",
  last_synced_at AS "lastSyncedAt", last_error AS "lastError",
  created_at AS "createdAt", updated_at AS "updatedAt"
`;

/**
 * Confinement for localPath registrations: the resolved path must be a
 * directory inside REPO_LOCAL_ROOT. Symlinks are resolved (realpath) so a
 * link pointing outside the root is rejected. Checked at registration and
 * again at every sync, so a path swapped after registration cannot escape.
 * Returns the resolved directory.
 */
export async function assertLocalPathAllowed(localPath: string): Promise<string> {
  const root = path.resolve(config.REPO_LOCAL_ROOT);
  let resolved: string;
  try {
    resolved = await fs.realpath(localPath);
  } catch {
    throw Errors.badRequest('REPO_LOCAL_PATH_INVALID', 'Configured localPath is not a readable directory');
  }
  const stat = await fs.stat(resolved).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw Errors.badRequest('REPO_LOCAL_PATH_INVALID', 'Configured localPath is not a readable directory');
  }
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw Errors.badRequest(
      'REPO_LOCAL_PATH_DENIED',
      `localPath must be inside REPO_LOCAL_ROOT (${root})`
    );
  }
  return resolved;
}

function toRepoRecord(row: Record<string, unknown>): RepoRecord {
  return {
    id: String(row.id),
    tenantId: String(row.tenantId),
    name: String(row.name),
    gitUrl: row.gitUrl === null ? null : String(row.gitUrl),
    localPath: row.localPath === null ? null : String(row.localPath),
    defaultBranch: String(row.defaultBranch),
    classification: row.classification as Classification,
    status: row.status as RepoStatus,
    commitSha: row.commitSha === null ? null : String(row.commitSha),
    chunkCount: Number(row.chunkCount),
    lastSyncedAt: row.lastSyncedAt === null ? null : String(row.lastSyncedAt),
    lastError: row.lastError === null ? null : String(row.lastError),
    createdAt: String(row.createdAt),
    updatedAt: String(row.updatedAt),
  };
}

export async function listRepos(tenantId: string): Promise<RepoRecord[]> {
  const result = await tenantQuery<Record<string, unknown>>(
    tenantId,
    `SELECT ${ROW_COLUMNS} FROM repos WHERE tenant_id = $1 ORDER BY name ASC`,
    [tenantId]
  );
  return result.rows.map(toRepoRecord);
}

export async function getRepo(tenantId: string, id: string): Promise<RepoRecord> {
  const result = await tenantQuery<Record<string, unknown>>(
    tenantId,
    `SELECT ${ROW_COLUMNS} FROM repos WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  const row = result.rows[0];
  if (!row) throw Errors.notFound('REPO_NOT_FOUND', 'Repository not found');
  return toRepoRecord(row);
}

export async function getRepoByName(tenantId: string, name: string): Promise<RepoRecord> {
  const parsed = repoNameSchema.safeParse(name);
  if (!parsed.success) throw Errors.badRequest('INVALID_REPO_NAME', 'Invalid repository name');
  const result = await tenantQuery<Record<string, unknown>>(
    tenantId,
    `SELECT ${ROW_COLUMNS} FROM repos WHERE tenant_id = $1 AND name = $2`,
    [tenantId, parsed.data]
  );
  const row = result.rows[0];
  if (!row) throw Errors.notFound('REPO_NOT_FOUND', 'Repository not found');
  return toRepoRecord(row);
}

export async function createRepo(tenantId: string, input: CreateRepoInput): Promise<RepoRecord> {
  // localPath registration is confined to REPO_LOCAL_ROOT: an admin API
  // credential must never become a read primitive for arbitrary server
  // paths (e.g. /etc), because indexed content is then readable through
  // repo.search/repo.readFile by any repo:read holder.
  if (input.localPath) {
    await assertLocalPathAllowed(input.localPath);
  }
  try {
    const result = await tenantQuery<Record<string, unknown>>(
      tenantId,
      `INSERT INTO repos (tenant_id, name, git_url, local_path, default_branch, classification)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING ${ROW_COLUMNS}`,
      [tenantId, input.name, input.gitUrl ?? null, input.localPath ?? null, input.defaultBranch, input.classification]
    );
    return toRepoRecord(result.rows[0]!);
  } catch (error) {
    // Unique violation on (tenant_id, name): report a clean 409, not a 500.
    if (error instanceof Error && 'code' in error && (error as { code?: string }).code === '23505') {
      throw Errors.conflict('REPO_ALREADY_EXISTS', 'A repository with this name is already registered');
    }
    throw error;
  }
}

export async function deleteRepo(tenantId: string, id: string): Promise<void> {
  const result = await tenantQuery(tenantId, 'DELETE FROM repos WHERE tenant_id = $1 AND id = $2', [tenantId, id]);
  if (result.rowCount === 0) throw Errors.notFound('REPO_NOT_FOUND', 'Repository not found');
  // repo_code_chunks rows cascade via the foreign key.
}

export async function setRepoSyncState(
  tenantId: string,
  id: string,
  state: { status: RepoStatus; commitSha?: string | null; chunkCount?: number; lastError?: string | null }
): Promise<void> {
  await tenantQuery(
    tenantId,
    `UPDATE repos
     SET status = $3,
         commit_sha = COALESCE($4, commit_sha),
         chunk_count = COALESCE($5, chunk_count),
         last_error = $6,
         last_synced_at = CASE WHEN $3 = 'READY' THEN NOW() ELSE last_synced_at END,
         updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id, state.status, state.commitSha ?? null, state.chunkCount ?? null, state.lastError ?? null]
  );
}

/**
 * Atomically replace a repo's index set after a successful sync: the exact
 * file rows and the chunk rows are swapped in one transaction, so a failed
 * sync never leaves the repo with a half-built or empty index. The file
 * rows hold the exact indexed content, so repo.readFile never re-stitches
 * overlapping chunks.
 */
export async function replaceRepoIndex(
  tenantId: string,
  repoId: string,
  classification: Classification,
  files: Array<{ path: string; content: string; commitSha: string | null }>,
  chunks: Array<{ path: string; chunkIndex: number; content: string; embedding: number[]; commitSha: string | null }>,
  embeddingModel: string,
  embeddingVersion: string,
  embeddingDimensions: number
): Promise<void> {
  await withTenantTx(tenantId, async (client) => {
    await client.query('DELETE FROM repo_code_chunks WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);
    await client.query('DELETE FROM repo_files WHERE tenant_id = $1 AND repo_id = $2', [tenantId, repoId]);

    const FILE_BATCH_ROWS = 200;
    const FILE_COLUMNS = 6;
    for (let offset = 0; offset < files.length; offset += FILE_BATCH_ROWS) {
      const slice = files.slice(offset, offset + FILE_BATCH_ROWS);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      slice.forEach((file, sliceIndex) => {
        const base = sliceIndex * FILE_COLUMNS;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6})`
        );
        params.push(repoId, tenantId, file.path, file.content, classification, file.commitSha);
      });
      await client.query(
        `INSERT INTO repo_files
           (repo_id, tenant_id, path, content, classification, commit_sha)
         VALUES ${placeholders.join(',')}`,
        params
      );
    }

    const INSERT_BATCH_ROWS = 200;
    const INSERT_COLUMNS = 11;
    for (let offset = 0; offset < chunks.length; offset += INSERT_BATCH_ROWS) {
      const slice = chunks.slice(offset, offset + INSERT_BATCH_ROWS);
      const placeholders: string[] = [];
      const params: unknown[] = [];
      slice.forEach((chunk, sliceIndex) => {
        const base = sliceIndex * INSERT_COLUMNS;
        placeholders.push(
          `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6}::vector,$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`
        );
        params.push(
          repoId,
          tenantId,
          chunk.path,
          chunk.chunkIndex,
          chunk.content,
          `[${chunk.embedding.join(',')}]`,
          classification,
          embeddingModel,
          embeddingVersion,
          embeddingDimensions,
          chunk.commitSha
        );
      });
      await client.query(
        `INSERT INTO repo_code_chunks
           (repo_id, tenant_id, path, chunk_index, content, embedding, classification,
            embedding_model, embedding_version, embedding_dimensions, commit_sha)
         VALUES ${placeholders.join(',')}`,
        params
      );
    }
  });
}
