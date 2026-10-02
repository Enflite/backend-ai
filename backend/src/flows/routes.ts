/**
 * routes.ts — Flows platform HTTP API (ADR-022), mounted at /api/v1.
 *
 * Definition management (flows:manage):
 *   POST   /flows                  create a draft flow
 *   GET    /flows                  list flows (summaries)
 *   GET    /flows/:name            get a flow (draft + versions metadata)
 *   PUT    /flows/:name            replace the draft
 *   DELETE /flows/:name            delete the flow (run history is kept)
 *   POST   /flows/:name/versions   publish the draft as a new version
 *   GET    /flows/:name/versions   list published versions
 *   POST   /flows/:name/alias      point the live alias (If-Match revision guard → 412)
 *   POST   /flows/ensure           converge flows/*.flow.json from the repo root
 *   GET    /flows/:name/pull       fetch the live version's frozen definition
 *
 * Runs (flows:run):
 *   POST   /flows/:name/runs       create a run (?sync executes inline)
 *   GET    /flows/runs             list runs (requester-scoped unless tenant:manage)
 *   GET    /flows/runs/:runId      get a run
 *   GET    /flows/runs/:runId/events  SSE stream of run progress
 *   POST   /flows/runs/:runId/cancel  cancel a queued/running run
 *
 * Everything is behind FLOWS_ENABLED (403 FEATURE_DISABLED when off).
 * All inputs are zod-validated; Errors.* codes throughout. Step logs and
 * audit metadata carry step ids, statuses, and output SHAPES only — never
 * values (template values may carry secrets).
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import type { AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { config } from '../config.js';
import { recordAudit } from '../audit/audit.js';
import { createSseSender, type SseRawSocket } from '../chat/routes.js';
import {
  assertRunVisible,
  cancelRun,
  claimRun,
  createFlow,
  createRun,
  definitionHash,
  deleteFlow,
  getFlow,
  getLiveDefinition,
  getRun,
  listFlows,
  listRuns,
  listVersions,
  publishVersion,
  setLiveAlias,
  updateFlowDraft,
} from './flowStore.js';
import { runFlow } from './flowRunner.js';
import { kickFlowRunner } from './flowScheduler.js';
import {
  createFlowRunInput,
  flowDefinitionSchema,
  flowNameSchema,
  listFlowRunsInput,
  setLiveAliasInput,
  updateFlowDraftInput,
  type FlowDoc,
  type FlowRunDoc,
} from './flowTypes.js';

function assertFlowsEnabled(): void {
  if (!config.FLOWS_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'Flows are disabled (FLOWS_ENABLED=false)',
    );
  }
}

/** Admins (tenant:manage) see the tenant's runs; everyone else sees only their own. */
function isFlowAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

function flowSummary(flow: FlowDoc): Record<string, unknown> {
  return {
    name: flow.name,
    title: flow.draft.title,
    description: flow.draft.description,
    revision: flow.revision,
    liveVersion: flow.liveVersion,
    versionCount: flow.versions.length,
    createdAt: flow.createdAt,
    updatedAt: flow.updatedAt,
  };
}

export function runSummary(run: FlowRunDoc): Record<string, unknown> {
  return {
    id: run._id,
    flowName: run.flowName,
    flowVersion: run.flowVersion,
    status: run.status,
    steps: run.steps.map((step) => ({
      stepId: step.stepId,
      kind: step.kind,
      status: step.status,
      outputShape: step.outputShape ?? null,
      errorCode: step.errorCode ?? null,
      startedAt: step.startedAt ?? null,
      completedAt: step.completedAt ?? null,
    })),
    resultSummary: run.resultSummary ?? null,
    blockedReason: run.blockedReason ?? null,
    idempotencyKey: run.idempotencyKey ?? null,
    confirmWrites: run.confirmWrites,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    startedAt: run.startedAt ?? null,
    completedAt: run.completedAt ?? null,
  };
}

async function auditFlowManagement(
  auth: AuthContext,
  action: string,
  success: boolean,
  metadata?: Record<string, unknown>,
): Promise<void> {
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    action,
    success,
    metadata,
  });
}

const nameParams = z.object({ name: flowNameSchema });
const runIdParams = z.object({ runId: z.string().min(1).max(128) });
const syncQuery = z.object({ sync: z.coerce.boolean().default(false) });

// ---------------------------------------------------------------------------
// SSE: run progress events (follows the chat SSE pattern)
// ---------------------------------------------------------------------------

interface ActiveFlowSseStream {
  end: () => void;
  abort: () => void;
}

const activeFlowSseStreams = new Set<ActiveFlowSseStream>();

/** End flow SSE streams explicitly on shutdown (mirrors chat's preClose handling). */
export function closeFlowSseStreams(): void {
  for (const stream of activeFlowSseStreams) {
    try {
      stream.abort();
      stream.end();
    } catch {
      // Shutdown path: never throw.
    }
  }
  activeFlowSseStreams.clear();
}

/** Poll interval for run-progress SSE; exported for tests. */
export const FLOW_SSE_POLL_MS = 500;

function runSnapshot(run: FlowRunDoc): Record<string, unknown> {
  return runSummary(run);
}

const TERMINAL = new Set(['completed', 'blocked', 'cancelled']);

export interface FlowRunEvent {
  type: 'snapshot' | 'done' | 'error';
  payload: unknown;
}

/**
 * Poll a run document and yield progress events: a `snapshot` whenever
 * the run state changes, then `done` at a terminal status (or `error`
 * when the run disappears). Pure polling — no pub/sub infrastructure —
 * so a client reconnecting mid-run just replays the current state.
 * Exported for tests.
 */
export async function* pollRunEvents(
  readRun: () => Promise<FlowRunDoc | null>,
  signal: AbortSignal,
  pollMs = FLOW_SSE_POLL_MS,
): AsyncGenerator<FlowRunEvent> {
  let lastSnapshot = '';
  while (!signal.aborted) {
    const run = await readRun();
    if (!run) {
      yield { type: 'error', payload: { code: 'FLOW_RUN_NOT_FOUND' } };
      return;
    }
    const snapshot = JSON.stringify(runSnapshot(run));
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      yield { type: 'snapshot', payload: JSON.parse(snapshot) };
    }
    if (TERMINAL.has(run.status)) {
      yield { type: 'done', payload: JSON.parse(snapshot) };
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      timer.unref?.();
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
}

async function streamRunEvents(
  req: any,
  reply: any,
  runId: string,
  auth: AuthContext,
): Promise<void> {
  const requestOrigin = req.headers.origin as string | undefined;
  const allowedOrigins = config.CORS_ORIGIN.split(',').map((origin) => origin.trim());
  const sseHeaders: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    Connection: 'keep-alive',
    'x-request-id': req.requestId,
  };
  if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
    sseHeaders['Access-Control-Allow-Origin'] = requestOrigin;
    sseHeaders['Access-Control-Allow-Credentials'] = 'true';
    sseHeaders['Access-Control-Expose-Headers'] = 'x-request-id, x-trace-id';
    sseHeaders.Vary = 'Origin';
  }
  reply.raw.writeHead(200, sseHeaders);
  const abortController = new AbortController();
  let doneDelivered = false;
  const onSocketClose = () => {
    if (!reply.raw.writableEnded && !doneDelivered) {
      abortController.abort();
    }
  };
  req.raw.socket.once('close', onSocketClose);
  const activeStream: ActiveFlowSseStream = {
    end: () => {
      if (!reply.raw.writableEnded) reply.raw.end();
    },
    abort: () => abortController.abort(),
  };
  activeFlowSseStreams.add(activeStream);
  const sse = createSseSender(reply.raw as unknown as SseRawSocket, {
    abortSignal: abortController.signal,
  });
  const heartbeat = setInterval(() => {
    if (reply.raw.writableEnded || reply.raw.destroyed) {
      clearInterval(heartbeat);
      return;
    }
    sse.ping();
  }, 15000);
  heartbeat.unref?.();

  try {
    for await (const event of pollRunEvents(
      () => getRun(auth.tenantId, runId),
      abortController.signal,
    )) {
      const delivered = await sse.send(event.type, event.payload);
      if (!delivered) break;
      if (event.type === 'done' || event.type === 'error') {
        if (event.type === 'done') doneDelivered = true;
        break;
      }
    }
  } finally {
    clearInterval(heartbeat);
    activeFlowSseStreams.delete(activeStream);
    if (!reply.raw.writableEnded) reply.raw.end();
  }
}

// ---------------------------------------------------------------------------
// Repo converge: POST /flows/ensure
// ---------------------------------------------------------------------------

/**
 * Candidate locations for the repo-root `flows/` directory (Windows-safe
 * via node:path). In dev the backend runs with cwd=backend/, in packaged
 * builds with cwd=repo root.
 */
function flowsRepoDirCandidates(): string[] {
  return [join(process.cwd(), 'flows'), join(process.cwd(), '..', 'flows')];
}

async function findFlowsDir(): Promise<string | null> {
  for (const dir of flowsRepoDirCandidates()) {
    try {
      const info = await stat(dir);
      if (info.isDirectory()) return dir;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

interface EnsureResult {
  created: string[];
  updated: string[];
  unchanged: string[];
  errors: Array<{ file: string; error: string }>;
}

async function ensureFlowsFromRepo(auth: AuthContext): Promise<EnsureResult> {
  const result: EnsureResult = { created: [], updated: [], unchanged: [], errors: [] };
  const dir = await findFlowsDir();
  if (!dir) {
    throw Errors.notFound('FLOWS_DIR_NOT_FOUND', 'No flows/ directory found at the repo root');
  }
  const entries = await readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.flow.json'))
    .map((entry) => entry.name)
    .sort();
  for (const file of files) {
    let parsed: z.infer<typeof flowDefinitionSchema>;
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const json: unknown = JSON.parse(raw);
      const check = flowDefinitionSchema.safeParse(json);
      if (!check.success) {
        throw new Error(check.error.issues.slice(0, 3).map((issue) => issue.message).join('; '));
      }
      parsed = check.data;
    } catch (error) {
      result.errors.push({
        file,
        error: error instanceof Error ? error.message : 'unreadable flow file',
      });
      continue;
    }
    const existing = await getFlow(auth.tenantId, parsed.name);
    if (!existing) {
      await createFlow(auth, parsed);
      result.created.push(parsed.name);
    } else if (definitionHash(existing.draft) !== definitionHash(parsed)) {
      await updateFlowDraft(auth.tenantId, parsed.name, parsed, auth.userId);
      result.updated.push(parsed.name);
    } else {
      result.unchanged.push(parsed.name);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export async function flowRoutes(fastify: FastifyInstance): Promise<void> {
  // -- Definition management (flows:manage) --------------------------------

  fastify.post(
    '/flows',
    { preHandler: [requireAuth, requirePermission('flows:manage')], bodyLimit: 256 * 1024 },
    async (req, reply) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const parsed = flowDefinitionSchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest(
          'INVALID_FLOW_DEFINITION',
          `Invalid flow definition: ${parsed.error.issues.slice(0, 3).map((issue: z.ZodIssue) => issue.message).join('; ')}`,
        );
      }
      const flow = await createFlow(auth, parsed.data);
      await auditFlowManagement(auth, 'FLOW_CREATED', true, { flowName: flow.name });
      return reply.status(201).send({ flow: flowSummary(flow) });
    },
  );

  fastify.get(
    '/flows',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const flows = await listFlows(req.auth!.tenantId);
      return { flows: flows.map(flowSummary) };
    },
  );

  fastify.get(
    '/flows/:name',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const flow = await getFlow(req.auth!.tenantId, params.data.name);
      if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', 'Flow not found');
      return { flow: { ...flowSummary(flow), draft: flow.draft } };
    },
  );

  fastify.put(
    '/flows/:name',
    { preHandler: [requireAuth, requirePermission('flows:manage')], bodyLimit: 256 * 1024 },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const body = updateFlowDraftInput.safeParse(req.body);
      if (!body.success) {
        throw Errors.badRequest(
          'INVALID_FLOW_DEFINITION',
          `Invalid flow draft: ${body.error.issues.slice(0, 3).map((issue: z.ZodIssue) => issue.message).join('; ')}`,
        );
      }
      const flow = await updateFlowDraft(auth.tenantId, params.data.name, body.data, auth.userId);
      await auditFlowManagement(auth, 'FLOW_DRAFT_UPDATED', true, {
        flowName: flow.name,
        revision: flow.revision,
      });
      return { flow: { ...flowSummary(flow), draft: flow.draft } };
    },
  );

  fastify.delete(
    '/flows/:name',
    { preHandler: [requireAuth, requirePermission('flows:manage')] },
    async (req, reply) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      await deleteFlow(auth.tenantId, params.data.name);
      await auditFlowManagement(auth, 'FLOW_DELETED', true, { flowName: params.data.name });
      return reply.status(204).send();
    },
  );

  fastify.post(
    '/flows/:name/versions',
    { preHandler: [requireAuth, requirePermission('flows:manage')] },
    async (req, reply) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const { flow, version } = await publishVersion(auth.tenantId, params.data.name, auth.userId);
      await auditFlowManagement(auth, 'FLOW_PUBLISHED', true, {
        flowName: flow.name,
        version: version.version,
        definitionHash: version.definitionHash,
      });
      return reply.status(201).send({
        version: {
          version: version.version,
          definitionHash: version.definitionHash,
          publishedBy: version.publishedBy,
          publishedAt: version.publishedAt,
        },
        revision: flow.revision,
      });
    },
  );

  fastify.get(
    '/flows/:name/versions',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const versions = await listVersions(req.auth!.tenantId, params.data.name);
      return {
        versions: versions.map((v) => ({
          version: v.version,
          definitionHash: v.definitionHash,
          publishedBy: v.publishedBy,
          publishedAt: v.publishedAt,
        })),
      };
    },
  );

  fastify.post(
    '/flows/:name/alias',
    { preHandler: [requireAuth, requirePermission('flows:manage')] },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const body = setLiveAliasInput.safeParse(req.body);
      if (!body.success) throw Errors.badRequest('INVALID_ALIAS_REQUEST', 'Invalid alias request');
      // 412 REVISION_MISMATCH on a stale expectedRevision (thrown by the store).
      const flow = await setLiveAlias(
        auth.tenantId,
        params.data.name,
        body.data.version,
        body.data.expectedRevision,
      );
      await auditFlowManagement(auth, 'FLOW_ALIAS_SET', true, {
        flowName: flow.name,
        liveVersion: flow.liveVersion,
        revision: flow.revision,
      });
      return { flow: flowSummary(flow) };
    },
  );

  fastify.post(
    '/flows/ensure',
    { preHandler: [requireAuth, requirePermission('flows:manage')] },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const result = await ensureFlowsFromRepo(auth);
      await auditFlowManagement(auth, 'FLOW_ENSURED', true, {
        created: result.created.length,
        updated: result.updated.length,
        unchanged: result.unchanged.length,
        errors: result.errors.length,
      });
      return result;
    },
  );

  fastify.get(
    '/flows/:name/pull',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const live = await getLiveDefinition(req.auth!.tenantId, params.data.name);
      if (!live) {
        const flow = await getFlow(req.auth!.tenantId, params.data.name);
        if (!flow) throw Errors.notFound('FLOW_NOT_FOUND', 'Flow not found');
        throw Errors.badRequest('NO_LIVE_VERSION', 'Flow has no live version');
      }
      return {
        name: params.data.name,
        version: live.version,
        definitionHash: definitionHash(live.definition),
        definition: live.definition,
      };
    },
  );

  // -- Runs (flows:run) ------------------------------------------------------

  fastify.post(
    '/flows/:name/runs',
    {
      preHandler: [requireAuth, requirePermission('flows:run')],
      bodyLimit: 256 * 1024,
    },
    async (req, reply) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_FLOW_REQUEST', 'Invalid flow name');
      const body = createFlowRunInput.safeParse(req.body);
      if (!body.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid run request');
      const query = syncQuery.safeParse(req.query);
      if (!query.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid query');
      const headerKey = req.headers['idempotency-key'];
      const idempotencyKey =
        (typeof headerKey === 'string' && headerKey.length > 0 ? headerKey : undefined) ??
        body.data.idempotencyKey;

      const { run, duplicate } = await createRun(
        auth,
        params.data.name,
        { ...body.data, idempotencyKey },
        auth.clearance,
      );
      await auditFlowManagement(auth, 'FLOW_RUN_CREATED', true, {
        flowName: run.flowName,
        flowVersion: run.flowVersion,
        runId: run._id,
        duplicate,
        confirmWrites: run.confirmWrites,
      });

      if (duplicate) {
        return reply.send({ run: runSummary(run), duplicate: true });
      }

      if (query.data.sync) {
        // Execute inline, bounded by FLOW_SYNC_TIMEOUT_MS. The atomic claim
        // keeps this safe if the scheduler raced us to the run.
        const claimed = await claimRun(auth.tenantId, run._id, `sync:${req.requestId}`);
        if (claimed) {
          const signal = AbortSignal.timeout(config.FLOW_SYNC_TIMEOUT_MS);
          await runFlow(claimed, { signal });
          const latest = await getRun(auth.tenantId, run._id);
          return reply.send({ run: runSummary(latest ?? claimed), duplicate: false });
        }
        // Lost the race: the scheduler owns it now; report async state.
      } else {
        kickFlowRunner();
      }
      return reply.status(202).send({ run: runSummary(run), duplicate: false });
    },
  );

  fastify.get(
    '/flows/runs',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const query = listFlowRunsInput.safeParse(req.query);
      if (!query.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid query');
      const runs = await listRuns(auth.tenantId, auth.userId, isFlowAdmin(auth), {
        flowName: query.data.flowName,
        status: query.data.status,
        limit: query.data.limit,
      });
      return { runs: runs.map(runSummary) };
    },
  );

  fastify.get(
    '/flows/runs/:runId',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = runIdParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid run id');
      const run = await getRun(auth.tenantId, params.data.runId);
      if (!run) throw Errors.notFound('FLOW_RUN_NOT_FOUND', 'Flow run not found');
      assertRunVisible(run, auth.userId, isFlowAdmin(auth));
      return { run: runSummary(run) };
    },
  );

  fastify.get(
    '/flows/runs/:runId/events',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req, reply) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = runIdParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid run id');
      const run = await getRun(auth.tenantId, params.data.runId);
      if (!run) throw Errors.notFound('FLOW_RUN_NOT_FOUND', 'Flow run not found');
      assertRunVisible(run, auth.userId, isFlowAdmin(auth));
      await streamRunEvents(req, reply, run._id, auth);
    },
  );

  fastify.post(
    '/flows/runs/:runId/cancel',
    { preHandler: [requireAuth, requirePermission('flows:run')] },
    async (req) => {
      assertFlowsEnabled();
      const auth = req.auth!;
      const params = runIdParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_RUN_REQUEST', 'Invalid run id');
      const run = await getRun(auth.tenantId, params.data.runId);
      if (!run) throw Errors.notFound('FLOW_RUN_NOT_FOUND', 'Flow run not found');
      assertRunVisible(run, auth.userId, isFlowAdmin(auth));
      const cancelled = await cancelRun(auth.tenantId, run._id);
      if (!cancelled) {
        throw Errors.conflict('FLOW_RUN_ALREADY_TERMINAL', 'Flow run is already terminal');
      }
      // A cancelled run that the scheduler already claimed stops promptly:
      // the runner re-reads state before every step.
      await auditFlowManagement(auth, 'FLOW_RUN_CANCELLED', true, {
        flowName: run.flowName,
        runId: run._id,
      });
      return { run: runSummary(cancelled) };
    },
  );
}
