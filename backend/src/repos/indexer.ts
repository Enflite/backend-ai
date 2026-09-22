import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import { chunkText, internalEmbeddingProvider } from '../documents/ingestion.js';
import { getRepo, getRepoByName, listRepos, replaceRepoIndex, setRepoSyncState, assertLocalPathAllowed, RepoRecord } from './registry.js';

const execFileAsync = promisify(execFile);

/**
 * Repository indexer: materializes a registered repo (git clone/pull or
 * local path), walks its text files, chunks and embeds them with the shared
 * internal embedding provider, and atomically swaps the repo's chunk set.
 *
 * Security posture:
 * - git_url hosts are restricted to REPO_GIT_HOST_ALLOWLIST (egress
 *   control); the URL comes from an admin-registered row, never from the
 *   user or the model.
 * - Private-clone credentials travel via git config *environment* (never a
 *   URL, per the repo's credential rules) and are scrubbed from any error
 *   text before it is persisted or logged.
 * - The file walk never follows symlinks, so a malicious or odd checkout
 *   cannot escape the repo root.
 * - git and file operations run via execFile (no shell) with validated
 *   arguments; branch names are constrained by the registry schema.
 * - All chunk writes are tenant-scoped and replaced atomically: a failed
 *   sync leaves the previous index untouched.
 */

const GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const GIT_FETCH_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Embedding dimension pinned by the Atlas Vector Search index on
 * `repo_code_chunks.embedding` (1536 dims, cosine — see migration 005),
 * matching `document_chunks`. The indexer refuses any other provider
 * dimension at sync time.
 */
export const REPO_EMBEDDING_DIMENSIONS = 1536;

// Directories that never contain indexable source (build output, vendored
// deps, editor state, VCS metadata).
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt',
  '__pycache__', '.venv', 'venv', 'vendor', 'target', 'bin', 'obj', '.idea', '.vscode',
]);

// Extensions skipped without sniffing: known binary/media artifacts. The
// null-byte sniff below is the real binary gate; this is a fast path.
const SKIP_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg',
  '.pdf', '.zip', '.tar', '.gz', '.7z', '.rar', '.exe', '.dll', '.so', '.dylib',
  '.mp3', '.mp4', '.mov', '.avi', '.wav', '.ttf', '.otf', '.woff', '.woff2',
  '.pyc', '.pyo', '.class', '.o', '.a', '.lib', '.pdb', '.sqlite', '.db',
]);

const BINARY_SNIFF_BYTES = 8192;

export interface RepoFile {
  /** Repo-relative path with forward slashes. */
  path: string;
  /** Absolute path on disk (never leaves the repo root). */
  absolutePath: string;
  sizeBytes: number;
}

export interface SyncStats {
  filesIndexed: number;
  filesSkipped: number;
  chunks: number;
  commitSha: string | null;
}

function scrubSecrets(message: string): string {
  const token = config.GITHUB_TOKEN;
  if (token && message.includes(token)) return message.split(token).join('[redacted]');
  return message;
}

function gitHostAllowed(gitUrl: string): boolean {
  let host: string;
  try {
    host = new URL(gitUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return config.REPO_GIT_HOST_ALLOWLIST.split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * Environment for git child processes: token auth without credentials in
 * URLs. Exported for tests. The token is scoped to GitHub hosts only — it
 * is never sent to a non-GitHub allowlist entry — and travels in the child
 * process environment, never the remote URL, command line, or logs.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const token = config.GITHUB_TOKEN;
  if (token) {
    const githubHosts = config.REPO_GIT_HOST_ALLOWLIST.split(',')
      .map((entry) => entry.trim().toLowerCase())
      .filter((host) => host === 'github.com' || host.endsWith('.github.com'));
    env.GIT_CONFIG_COUNT = String(githubHosts.length);
    githubHosts.forEach((host, index) => {
      env[`GIT_CONFIG_KEY_${index}`] = `http.https://${host}/.extraHeader`;
      env[`GIT_CONFIG_VALUE_${index}`] = `Authorization: Bearer ${token}`;
    });
  }
  return env;
}

async function runGit(args: string[], cwd: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd, env: gitEnv(), timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 });
    return stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`git ${args[0]} failed: ${scrubSecrets(message).slice(0, 500)}`);
  }
}

function repoWorkdir(tenantId: string, repoId: string): string {
  // tenantId/repoId are UUIDs from the registry — safe path segments.
  return path.join(config.REPO_WORKDIR, tenantId, repoId);
}

async function materializeGitRepo(repo: RepoRecord): Promise<{ dir: string; commitSha: string }> {
  const gitUrl = repo.gitUrl!;
  if (!gitHostAllowed(gitUrl)) {
    throw Errors.badRequest('REPO_GIT_HOST_DENIED', `Git host is not in the allowlist: ${new URL(gitUrl).hostname}`);
  }
  const dir = repoWorkdir(repo.tenantId, repo.id);
  await fs.mkdir(dir, { recursive: true });
  const gitDir = path.join(dir, '.git');
  const hasGit = await fs.stat(gitDir).then((st) => st.isDirectory()).catch(() => false);

  if (hasGit) {
    const originUrl = await runGit(['remote', 'get-url', 'origin'], dir, GIT_FETCH_TIMEOUT_MS).catch(() => '');
    if (originUrl !== gitUrl) {
      // Origin changed since last sync: wipe and clone fresh rather than
      // fetching from a stale remote.
      await fs.rm(dir, { recursive: true, force: true });
      await fs.mkdir(dir, { recursive: true });
    }
  }
  const fresh = !(await fs.stat(gitDir).then((st) => st.isDirectory()).catch(() => false));
  if (fresh) {
    // `--branch=` (not `--branch <name>`): the branch name can never be
    // parsed as a git option, even if validation were bypassed.
    await runGit(
      ['clone', '--depth', '1', `--branch=${repo.defaultBranch}`, '--single-branch', gitUrl, dir],
      path.dirname(dir),
      GIT_CLONE_TIMEOUT_MS
    );
  } else {
    await runGit(['fetch', '--depth', '1', 'origin', '--', repo.defaultBranch], dir, GIT_FETCH_TIMEOUT_MS);
    await runGit(['reset', '--hard', `origin/${repo.defaultBranch}`], dir, GIT_FETCH_TIMEOUT_MS);
    await runGit(['clean', '-fdq'], dir, GIT_FETCH_TIMEOUT_MS);
  }
  const commitSha = await runGit(['rev-parse', 'HEAD'], dir, GIT_FETCH_TIMEOUT_MS);
  if (!/^[0-9a-f]{40}$/.test(commitSha)) throw new Error('git rev-parse returned an invalid SHA');
  return { dir, commitSha };
}

async function materializeLocalRepo(repo: RepoRecord): Promise<{ dir: string; commitSha: null }> {
  // Re-check confinement at sync time: the path may have been swapped for a
  // symlink (or the root moved) after registration.
  const dir = await assertLocalPathAllowed(repo.localPath!);
  return { dir, commitSha: null };
}

/**
 * Recursively collect indexable files. Never follows symlinks; skips VCS
 * metadata, build output, vendored dependencies, binaries, and oversized
 * files. Returns repo-relative forward-slash paths.
 */
export async function walkRepoFiles(rootDir: string): Promise<{ files: RepoFile[]; skipped: number }> {
  const files: RepoFile[] = [];
  let skipped = 0;
  const maxFiles = config.REPO_MAX_FILES;

  async function walk(currentDir: string, relativeDir: string): Promise<void> {
    const entries = await fs.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDir, entry.name);
      const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) {
        skipped += 1;
        continue;
      }
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) {
          skipped += 1;
          continue;
        }
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) {
        skipped += 1;
        continue;
      }
      if (SKIP_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        skipped += 1;
        continue;
      }
      const stat = await fs.stat(absolutePath);
      if (stat.size > config.REPO_MAX_FILE_BYTES || stat.size === 0) {
        skipped += 1;
        continue;
      }
      if (await isBinary(absolutePath)) {
        skipped += 1;
        continue;
      }
      files.push({ path: relativePath, absolutePath, sizeBytes: stat.size });
      if (files.length > maxFiles) {
        throw Errors.badRequest('REPO_TOO_MANY_FILES', `Repository exceeds the configured file limit (${maxFiles})`);
      }
    }
  }

  await walk(rootDir, '');
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files, skipped };
}

async function isBinary(absolutePath: string): Promise<boolean> {
  const handle = await fs.open(absolutePath, 'r');
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function assertValidVectors(vectors: number[][], dimensions: number): void {
  for (const vector of vectors) {
    if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(Number.isFinite)) {
      throw new Error('Embedding provider returned an invalid code vector');
    }
  }
}

// One in-process mutex per repo so overlapping sync triggers (admin clicks,
// overlapping sync-all runs) serialize instead of interleaving chunk writes.
const syncLocks = new Map<string, Promise<SyncStats>>();

export function isSyncing(tenantId: string, repoId: string): boolean {
  return syncLocks.has(`${tenantId}:${repoId}`);
}

/**
 * Full re-index of one repo: materialize, walk, chunk, embed, atomically
 * swap chunks, mark READY. Concurrent callers for the same repo share the
 * in-flight sync instead of starting a second one.
 */
export function syncRepo(tenantId: string, repoId: string): Promise<SyncStats> {
  const key = `${tenantId}:${repoId}`;
  const inFlight = syncLocks.get(key);
  if (inFlight) return inFlight;
  const run = runSyncRepo(tenantId, repoId).finally(() => {
    syncLocks.delete(key);
  });
  syncLocks.set(key, run);
  return run;
}

async function runSyncRepo(tenantId: string, repoId: string): Promise<SyncStats> {
  const repo = await getRepo(tenantId, repoId);
  await setRepoSyncState(tenantId, repo.id, { status: 'SYNCING', lastError: null });
  try {
    const { dir, commitSha } = repo.gitUrl
      ? await materializeGitRepo(repo)
      : await materializeLocalRepo(repo);

    let { files, skipped } = await walkRepoFiles(dir);

    const indexedFiles: Array<{ path: string; content: string }> = [];
    const chunks: Array<{ path: string; chunkIndex: number; content: string }> = [];
    for (const file of files) {
      const text = await fs.readFile(file.absolutePath, 'utf8');
      if (!text.trim()) continue;
      // Backstop for files that grew between the walk's size check and the
      // read (TOCTOU): never buffer an unbounded file into memory.
      if (text.length > config.REPO_MAX_FILE_BYTES * 4) {
        skipped += 1;
        continue;
      }
      // Exact content goes to repo_files; chunks (overlapping) go to the
      // vector index. repo.readFile reads repo_files, never re-stitched chunks.
      indexedFiles.push({ path: file.path, content: text });
      const parts = chunkText(text, config.REPO_CHUNK_MAX_CHARS, config.REPO_CHUNK_OVERLAP);
      parts.forEach((content, chunkIndex) => chunks.push({ path: file.path, chunkIndex, content }));
    }
    if (chunks.length === 0) {
      throw Errors.badRequest('REPO_NO_INDEXABLE_CONTENT', 'No indexable text files found in the repository');
    }
    if (chunks.length > config.REPO_MAX_CHUNKS_PER_REPO) {
      throw Errors.badRequest(
        'REPO_TOO_MANY_CHUNKS',
        `Repository produced ${chunks.length} chunks (cap ${config.REPO_MAX_CHUNKS_PER_REPO})`
      );
    }

    const embeddings = internalEmbeddingProvider();
    // The repo_code_chunks.embedding field is a plain 1536-dimensional
    // number array (migration 005, matching document_chunks): the Atlas
    // Vector Search index requires a declared dimension, so a
    // non-1536-dimensional embedding provider fails fast here with a clear
    // error instead of a document insert failure mid-sync.
    if (embeddings.dimensions !== REPO_EMBEDDING_DIMENSIONS) {
      throw Errors.internal(
        `Repo indexing requires a ${REPO_EMBEDDING_DIMENSIONS}-dimensional embedding provider ` +
          `(configured: ${embeddings.dimensions})`,
        undefined,
        'REPO_EMBEDDING_DIMENSIONS_UNSUPPORTED'
      );
    }
    const vectors: number[][] = [];
    for (let offset = 0; offset < chunks.length; offset += config.EMBEDDING_BATCH_SIZE) {
      const batch = chunks.slice(offset, offset + config.EMBEDDING_BATCH_SIZE);
      vectors.push(
        ...(await embeddings.embed(
          batch.map((chunk) => chunk.content),
          AbortSignal.timeout(config.EMBEDDING_TIMEOUT_MS)
        ))
      );
    }
    if (vectors.length !== chunks.length) {
      throw new Error('Embedding provider returned a partial response');
    }
    assertValidVectors(vectors, embeddings.dimensions);

    await replaceRepoIndex(
      tenantId,
      repo.id,
      repo.classification,
      indexedFiles.map((file) => ({ ...file, commitSha })),
      chunks.map((chunk, index) => ({ ...chunk, embedding: vectors[index]!, commitSha })),
      embeddings.model,
      embeddings.version,
      embeddings.dimensions
    );
    await setRepoSyncState(tenantId, repo.id, {
      status: 'READY',
      commitSha,
      chunkCount: chunks.length,
      lastError: null,
    });
    return { filesIndexed: files.length, filesSkipped: skipped, chunks: chunks.length, commitSha };
  } catch (error) {
    const message = scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 1000);
    await setRepoSyncState(tenantId, repo.id, { status: 'FAILED', lastError: message });
    throw error;
  }
}

/** Sync every registered repo in sequence (bounded resource use). */
export async function syncAllRepos(
  tenantId: string,
  repoName?: string
): Promise<Array<{ repo: string; ok: boolean; stats?: SyncStats; error?: string }>> {
  const repos = repoName ? [await getRepoByName(tenantId, repoName)] : await listRepos(tenantId);
  const results: Array<{ repo: string; ok: boolean; stats?: SyncStats; error?: string }> = [];
  for (const repo of repos) {
    try {
      const stats = await syncRepo(tenantId, repo.id);
      results.push({ repo: repo.name, ok: true, stats });
    } catch (error) {
      results.push({
        repo: repo.name,
        ok: false,
        error: scrubSecrets(error instanceof Error ? error.message : String(error)).slice(0, 300),
      });
    }
  }
  return results;
}
