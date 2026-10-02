/**
 * routes.ts — SyteLine Automation Studio HTTP API (`/api/v1/studio`).
 *
 * The backend foundation for the automation builder: named SyteLine
 * connections (encrypted tokens, capability probes), the typed action
 * catalog bound to real operations, and single-action test execution
 * against the real upstream.
 *
 * Endpoints:
 * - GET    /studio/connections            list (env-backed 'default' first)
 * - POST   /studio/connections            create + probe → 201
 * - GET    /studio/connections/:id        one connection (no secrets)
 * - PATCH  /studio/connections/:id       update + re-probe
 * - DELETE /studio/connections/:id       delete → 204
 * - POST   /studio/connections/:id/test  connectivity check + probe → 200
 * - GET    /studio/actions               catalog (?connectionId evaluates support)
 * - POST   /studio/actions/test          execute one action against the real upstream
 *
 * Permissions: studio:manage for connection writes, studio:run for reads
 * and test execution. Every connection create/update/delete and every
 * action test is audited; tokens never appear in audit, logs, or responses.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  createConnection,
  deleteConnection,
  getConnection,
  getConnectionView,
  listConnections,
  recordProbeResult,
  resolveConnectionTarget,
  updateConnection,
} from './connections/store.js';
import { probeConnection, PROBE_CANDIDATES, type ConnectionProbeResult } from './connections/probe.js';
import {
  connectionCreateSchema,
  connectionIdParam,
  connectionUpdateSchema,
  testActionInputSchema,
  type StudioConnectionDoc,
} from './types.js';
import { getCatalogAction, listCatalog } from './catalog/catalog.js';
import { testAction } from './execution/testAction.js';

function validationError(message: string, details?: unknown): never {
  throw Errors.badRequest('VALIDATION_ERROR', message, details);
}

const managePre = [requireAuth, requirePermission('studio:manage')];
const runPre = [requireAuth, requirePermission('studio:run')];

interface ProbeSummary {
  probedAt: string;
  reachable: boolean;
  ok: number;
  unsupported: number;
  errors: number;
  detail: Array<{ operationId: string; status: string; detail?: string }>;
}

/** Convert a live probe result into the stored connection-doc shape. */
function toStoredProbe(result: ConnectionProbeResult): NonNullable<StudioConnectionDoc['probe']> {
  return {
    probedAt: result.probedAt,
    reachable: result.reachable,
    operations: PROBE_CANDIDATES.map((candidate) => {
      const op = result.operations.find((o) => o.operationId === candidate.operationId)!;
      return {
        operationId: op.operationId,
        probedMethod: op.probedMethod,
        probedPath: op.probedPath,
        status: op.status,
        ...(op.httpStatus !== undefined ? { httpStatus: op.httpStatus } : {}),
        ...(op.detail ? { detail: op.detail } : {}),
        probedAt: op.probedAt,
      };
    }),
  };
}

/** Persist probe results on stored connections; the env-backed 'default'
 *  is probed live and never persisted. */
async function persistProbe(
  tenantId: string,
  connectionId: string,
  probe: ConnectionProbeResult
): Promise<void> {
  await recordProbeResult(tenantId, connectionId, toStoredProbe(probe));
}

export async function studioRoutes(fastify: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // Connections
  // ------------------------------------------------------------------

  fastify.get('/studio/connections', { preHandler: runPre }, async (req, reply) => {
    const auth = req.auth!;
    return reply.send({ items: await listConnections(auth) });
  });

  fastify.post(
    '/studio/connections',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = connectionCreateSchema.safeParse(req.body);
      if (!parsed.success) validationError('Invalid connection input', parsed.error.flatten());
      const created = await createConnection(auth, parsed.data);
      // Probe on save: the connection's capability record starts honest.
      let probe: ProbeSummary | undefined;
      try {
        const resolved = await resolveConnectionTarget(auth.tenantId, created.id);
        const live = await probeConnection(resolved.baseUrl, resolved.token);
        resolved.token.fill(0);
        probe = {
          probedAt: live.probedAt,
          reachable: live.reachable,
          ok: live.operations.filter((o) => o.status === 'ok').length,
          unsupported: live.operations.filter((o) => o.status === 'unsupported').length,
          errors: live.operations.filter((o) => o.status === 'error').length,
          detail: live.operations.map((o) => ({
            operationId: o.operationId,
            status: o.status,
            ...(o.detail ? { detail: o.detail } : {}),
          })),
        };
        await persistProbe(auth.tenantId, created.id, live);
      } catch (error) {
        // A probe that cannot even start (DNS, TLS) is recorded as
        // unreachable rather than failing the save.
        if (!(error instanceof Error) || !/STUDIO_CONNECTION/.test(String((error as { code?: string }).code))) throw error;
      }
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'STUDIO_CONNECTION_CREATED',
        success: true,
        metadata: { connectionId: created.id, name: created.name, environment: created.environment, reachable: probe?.reachable },
      });
      const view = await getConnectionView(auth.tenantId, created.id);
      return reply.status(201).send({ ...view, probeSummary: probe });
    }
  );

  fastify.get('/studio/connections/:id', { preHandler: runPre }, async (req, reply) => {
    const auth = req.auth!;
    const params = connectionIdParam.safeParse(req.params);
    if (!params.success) validationError('Invalid connection id', params.error.flatten());
    const view = await getConnectionView(auth.tenantId, params.data.id);
    if (!view) throw Errors.notFound('NOT_FOUND', 'Connection not found');
    return reply.send(view);
  });

  fastify.patch(
    '/studio/connections/:id',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = connectionIdParam.safeParse(req.params);
      if (!params.success) validationError('Invalid connection id', params.error.flatten());
      const body = connectionUpdateSchema.safeParse(req.body);
      if (!body.success) validationError('Invalid connection input', body.error.flatten());
      const updated = await updateConnection(auth, params.data.id, body.data);
      if (!updated) throw Errors.notFound('NOT_FOUND', 'Connection not found');
      // Re-probe on save (baseUrl or token may have changed).
      let probe: ProbeSummary | undefined;
      try {
        const resolved = await resolveConnectionTarget(auth.tenantId, updated.id);
        const live = await probeConnection(resolved.baseUrl, resolved.token);
        resolved.token.fill(0);
        probe = {
          probedAt: live.probedAt,
          reachable: live.reachable,
          ok: live.operations.filter((o) => o.status === 'ok').length,
          unsupported: live.operations.filter((o) => o.status === 'unsupported').length,
          errors: live.operations.filter((o) => o.status === 'error').length,
          detail: live.operations.map((o) => ({
            operationId: o.operationId,
            status: o.status,
            ...(o.detail ? { detail: o.detail } : {}),
          })),
        };
        await persistProbe(auth.tenantId, updated.id, live);
      } catch (error) {
        if (!(error instanceof Error) || !/STUDIO_CONNECTION/.test(String((error as { code?: string }).code))) throw error;
      }
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'STUDIO_CONNECTION_UPDATED',
        success: true,
        metadata: { connectionId: updated.id, name: updated.name, reachable: probe?.reachable },
      });
      const view = await getConnectionView(auth.tenantId, updated.id);
      return reply.send({ ...view, probeSummary: probe });
    }
  );

  fastify.delete('/studio/connections/:id', { preHandler: managePre }, async (req, reply) => {
    const auth = req.auth!;
    const params = connectionIdParam.safeParse(req.params);
    if (!params.success) validationError('Invalid connection id', params.error.flatten());
    const doc = await getConnection(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('NOT_FOUND', 'Connection not found');
    const deleted = await deleteConnection(auth, params.data.id);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'STUDIO_CONNECTION_DELETED',
      success: deleted,
      metadata: { connectionId: params.data.id, name: doc.name },
    });
    return reply.status(204).send();
  });

  fastify.post(
    '/studio/connections/:id/test',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const params = connectionIdParam.safeParse(req.params);
      if (!params.success) validationError('Invalid connection id', params.error.flatten());
      const target = await resolveConnectionTarget(auth.tenantId, params.data.id);
      const live = await probeConnection(target.baseUrl, target.token);
      target.token.fill(0);
      // Persist probe results on stored connections so the catalog can
      // gate actions on them; the env-backed default is probed live.
      await persistProbe(auth.tenantId, params.data.id, live);
      const probe: ProbeSummary = {
        probedAt: live.probedAt,
        reachable: live.reachable,
        ok: live.operations.filter((o) => o.status === 'ok').length,
        unsupported: live.operations.filter((o) => o.status === 'unsupported').length,
        errors: live.operations.filter((o) => o.status === 'error').length,
        detail: live.operations.map((o) => ({
          operationId: o.operationId,
          status: o.status,
          ...(o.detail ? { detail: o.detail } : {}),
        })),
      };
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'STUDIO_CONNECTION_TESTED',
        success: probe.reachable,
        reason: probe.reachable ? undefined : 'Upstream did not answer any probe',
        metadata: {
          connectionId: params.data.id,
          reachable: probe.reachable,
          ok: probe.ok,
          unsupported: probe.unsupported,
          errors: probe.errors,
        },
      });
      const view = await getConnectionView(auth.tenantId, params.data.id);
      return reply.send({ ...view, probeSummary: probe });
    }
  );

  // ------------------------------------------------------------------
  // Action catalog
  // ------------------------------------------------------------------

  fastify.get('/studio/actions', { preHandler: runPre }, async (req, reply) => {
    const auth = req.auth!;
    const query = (req.query ?? {}) as { connectionId?: string };
    let operations: Awaited<ReturnType<typeof probeConnection>>['operations'] | undefined;
    if (typeof query.connectionId === 'string' && query.connectionId.length > 0) {
      if (query.connectionId === 'default') {
        // The env-backed default carries no stored probe: probe it live so
        // the catalog is honest about the default connection too.
        try {
          const target = await resolveConnectionTarget(auth.tenantId, 'default');
          try {
            operations = (await probeConnection(target.baseUrl, target.token)).operations;
          } finally {
            target.token.fill(0);
          }
        } catch {
          operations = undefined;
        }
      } else {
        const doc = await getConnection(auth.tenantId, query.connectionId);
        if (!doc) throw Errors.notFound('NOT_FOUND', 'Connection not found');
        operations = doc.probe?.operations;
      }
    }
    return reply.send({ items: listCatalog(operations) });
  });

  // ------------------------------------------------------------------
  // Single-action test execution
  // ------------------------------------------------------------------

  fastify.post(
    '/studio/actions/test',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = testActionInputSchema.safeParse(req.body);
      if (!parsed.success) validationError('Invalid test input', parsed.error.flatten());
      const { connectionId, actionId, params } = parsed.data;
      const entry = getCatalogAction(actionId);
      if (!entry) throw Errors.notFound('STUDIO_ACTION_NOT_FOUND', `Unknown action '${actionId}'`);

      // Resolve probe results for availability gating. Stored connections
      // carry their last probe; the env-backed default is probed live
      // (its probe is never persisted).
      let probeOperations;
      if (connectionId === 'default') {
        const target = await resolveConnectionTarget(auth.tenantId, connectionId);
        try {
          probeOperations = (await probeConnection(target.baseUrl, target.token)).operations;
        } finally {
          target.token.fill(0);
        }
      } else {
        const doc = await getConnection(auth.tenantId, connectionId);
        if (!doc) {
          throw Errors.conflict(
            'STUDIO_CONNECTION_NOT_FOUND',
            `Connection '${connectionId}' does not exist in this tenant. Create it under /api/v1/studio/connections first.`
          );
        }
        probeOperations = doc.probe?.operations;
      }
      const result = await testAction(auth, connectionId, actionId, params, probeOperations, {
        requestId: req.requestId,
      });
      return reply.send(result);
    }
  );

}
