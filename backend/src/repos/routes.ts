import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  createRepo,
  createRepoSchema,
  deleteRepo,
  getRepo,
  listRepos,
  RepoRecord,
} from './registry.js';
import { isSyncing, syncAllRepos, syncRepo } from './indexer.js';
import { listOrgRepos } from './github.js';
import { config } from '../config.js';

/**
 * Admin API for the multi-repo code index.
 *
 * - `repo:manage` governs registration and sync; `repo:read` governs the
 *   chat-time tools (repo.search / repo.readFile).
 * - Syncs run in the background: POST returns 202 with the repo's current
 *   state, and GET shows live progress (SYNCING) plus freshness
 *   (lastSyncedAt, commitSha, chunkCount) when done.
 */

const idParamSchema = z.object({ id: z.string().uuid() }).strict();

function toPublicRepo(repo: RepoRecord) {
  return {
    id: repo.id,
    name: repo.name,
    gitUrl: repo.gitUrl,
    localPath: repo.localPath,
    defaultBranch: repo.defaultBranch,
    classification: repo.classification,
    status: repo.status,
    commitSha: repo.commitSha,
    chunkCount: repo.chunkCount,
    lastSyncedAt: repo.lastSyncedAt,
    lastError: repo.lastError,
    syncing: isSyncing(repo.tenantId, repo.id),
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

export async function repoRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/repos', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const repos = await listRepos(auth.tenantId);
    return reply.send({ repos: repos.map(toPublicRepo) });
  });

  fastify.post('/repos', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = createRepoSchema.safeParse(req.body);
    if (!parsed.success) throw Errors.badRequest('INVALID_REPO', 'Invalid repository registration', parsed.error.format());
    const repo = await createRepo(auth.tenantId, parsed.data);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'REPO_REGISTER',
      resource: `repo:${repo.id}`,
      classification: repo.classification,
      metadata: { name: repo.name, source: repo.gitUrl ? 'git' : 'local' },
    });
    return reply.code(201).send({ repo: toPublicRepo(repo) });
  });

  // Organization discovery ("use all of my existing repos"): list the repos
  // GITHUB_TOKEN can see in GITHUB_ORG, flagged with whether each is already
  // registered for this tenant. Static routes are declared before /:id.
  fastify.get('/repos/discover', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const orgRepos = await listOrgRepos();
    const registered = await listRepos(auth.tenantId);
    const registeredNames = new Set(registered.map((repo) => repo.name));
    const registeredUrls = new Set(registered.map((repo) => repo.gitUrl).filter((url): url is string => url !== null));
    return reply.send({
      org: config.GITHUB_ORG,
      repos: orgRepos.map((repo) => ({
        name: repo.name,
        private: repo.private,
        defaultBranch: repo.defaultBranch,
        cloneUrl: repo.cloneUrl,
        registered: registeredNames.has(repo.name) || registeredUrls.has(repo.cloneUrl),
      })),
    });
  });

  // Import every not-yet-registered org repo in one call. Each import goes
  // through createRepoSchema validation; failures are per-repo (a name
  // collision never aborts the batch). Sync afterwards with POST
  // /repos/sync — import alone does not clone.
  fastify.post('/repos/import', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const orgRepos = await listOrgRepos();
    const registered = await listRepos(auth.tenantId);
    const registeredNames = new Set(registered.map((repo) => repo.name));
    const registeredUrls = new Set(registered.map((repo) => repo.gitUrl).filter((url): url is string => url !== null));
    const imported: Array<{ name: string; id: string }> = [];
    const skipped: string[] = [];
    const failed: Array<{ name: string; error: string }> = [];
    for (const orgRepo of orgRepos) {
      if (registeredNames.has(orgRepo.name) || registeredUrls.has(orgRepo.cloneUrl)) {
        skipped.push(orgRepo.name);
        continue;
      }
      try {
        const repo = await createRepo(auth.tenantId, {
          name: orgRepo.name,
          gitUrl: orgRepo.cloneUrl,
          defaultBranch: orgRepo.defaultBranch,
          // Imported org code is INTERNAL by default; an admin can
          // reclassify individual repos afterwards via the registry.
          classification: 'INTERNAL',
        });
        imported.push({ name: repo.name, id: repo.id });
      } catch (error) {
        failed.push({ name: orgRepo.name, error: error instanceof Error ? error.message : String(error) });
      }
    }
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'REPO_IMPORT',
      classification: 'INTERNAL',
      metadata: { org: config.GITHUB_ORG, imported: imported.map((repo) => repo.name), skipped, failed: failed.map((repo) => repo.name) },
    });
    return reply.code(201).send({ org: config.GITHUB_ORG, imported, skipped, failed });
  });

  fastify.get('/repos/:id', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REPO_ID', 'Invalid repository id');
    const repo = await getRepo(auth.tenantId, params.data.id);
    return reply.send({ repo: toPublicRepo(repo) });
  });

  fastify.delete('/repos/:id', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REPO_ID', 'Invalid repository id');
    const repo = await getRepo(auth.tenantId, params.data.id);
    await deleteRepo(auth.tenantId, params.data.id);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'REPO_DELETE',
      resource: `repo:${repo.id}`,
      classification: repo.classification,
      metadata: { name: repo.name },
    });
    return reply.code(204).send();
  });

  // Sync one repo in the background. 202 + current state; poll GET /repos/:id
  // for completion. A sync already in flight is shared, not duplicated.
  fastify.post('/repos/:id/sync', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = idParamSchema.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REPO_ID', 'Invalid repository id');
    const repo = await getRepo(auth.tenantId, params.data.id);
    const alreadyRunning = isSyncing(auth.tenantId, repo.id);
    syncRepo(auth.tenantId, repo.id).then(
      () => recordAudit({
        tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId,
        action: 'REPO_SYNC', resource: `repo:${repo.id}`, classification: repo.classification,
        metadata: { name: repo.name, status: 'READY' },
      }).catch(() => undefined),
      () => undefined
    );
    return reply.code(202).send({ repo: toPublicRepo(repo), syncStarted: !alreadyRunning });
  });

  // Sync all registered repos in sequence (optionally one by name).
  const syncAllBodySchema = z.object({ repo: z.string().trim().min(1).max(100).optional() }).strict();
  fastify.post('/repos/sync', { preHandler: [requireAuth, requirePermission('repo:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const body = syncAllBodySchema.safeParse(req.body ?? {});
    if (!body.success) throw Errors.badRequest('INVALID_SYNC_REQUEST', 'Invalid sync request');
    // Fire and forget: each repo's outcome lands on its row (status /
    // lastError); the response lists what was queued.
    const queued = body.data.repo ? [body.data.repo] : (await listRepos(auth.tenantId)).map((repo) => repo.name);
    void (async () => {
      try {
        await syncAllRepos(auth.tenantId, body.data.repo);
      } finally {
        await recordAudit({
          tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId,
          action: 'REPO_SYNC_ALL', classification: 'INTERNAL', metadata: { repos: queued },
        }).catch(() => undefined);
      }
    })();
    return reply.code(202).send({ queued });
  });
}
