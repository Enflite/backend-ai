/**
 * routes.ts — Studio automation HTTP API (`/api/v1/studio/automations`,
 * `/api/v1/studio/runs`, `/api/v1/studio/hooks/:token`).
 *
 * - GET    /studio/automations                 list (studio:run)
 * - POST   /studio/automations                 create (studio:manage)
 * - GET    /studio/automations/:id             one automation (studio:run)
 * - PATCH  /studio/automations/:id            update (studio:manage)
 * - DELETE /studio/automations/:id            delete + trigger/flow teardown (studio:manage)
 * - POST   /studio/automations/:id/test        dry run: real reads, destructive steps skipped (studio:run)
 * - POST   /studio/automations/:id/run         manual fire (studio:run)
 * - POST   /studio/automations/:id/deploy      compile + publish + wire trigger (studio:manage)
 * - POST   /studio/automations/:id/undeploy    pause/remove trigger (studio:manage)
 * - POST   /studio/automations/:id/webhook/rotate  rotate the webhook token (studio:manage)
 * - GET    /studio/runs                        flow runs for studio automations (studio:run)
 * - GET    /studio/runs/:id                    one studio run with per-step log (studio:run)
 * - POST   /studio/hooks/:token                webhook fire (token-gated, no session auth)
 *
 * Everything here requires FLOWS_ENABLED (403 FEATURE_DISABLED when off) —
 * automations are flow definitions plus triggers, and neither means
 * anything without the Flows platform. Writes and deploys need
 * `studio:manage`; test and manual runs need `studio:run`.
 *
 * The webhook hook route is the one unauthenticated route: the unguessable
 * token IS the credential. It is rate-limited, the token is looked up by
 * hash, and the raw token never appears in logs, audit, or responses.
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import { getCatalogAction } from '../catalog/catalog.js';
import { generateAutomationDraft, generateAutomationInput } from '../ai/generate.js';
import { explainAutomation } from '../ai/explain.js';
import { suggestNextSteps } from '../ai/suggest.js';
import {
  automationIdParam,
  createAutomationInput,
  deployAutomationInput,
  listAutomationsInput,
  listStudioRunsInput,
  runAutomationInput,
  testAutomationInput,
  updateAutomationInput,
  type AutomationStep,
} from './types.js';
import {
  createAutomation,
  deleteAutomation,
  getAutomation,
  getStudioRun,
  listAutomations,
  listStudioRuns,
  toAutomationView,
  updateAutomation,
} from './store.js';
import {
  assertStudioAutomationsEnabled,
  deployAutomation,
  fireWebhook,
  rotateWebhookToken,
  runAutomationNow,
  teardownAutomation,
  undeployAutomation,
} from './deploy.js';
import { dryRunAutomation } from './test.js';

const webhookTokenParam = z.object({ token: z.string().min(1).max(256) });

const managePre = [requireAuth, requirePermission('studio:manage')];
const runPre = [requireAuth, requirePermission('studio:run')];

function automationRoutesEnabled(): void {
  assertStudioAutomationsEnabled();
}

/** Authoring-time check: every action/verify step must name a real catalog
 *  action. Connection existence needs the tenant and is checked at
 *  compile time (deploy/test/run). */
function assertKnownActions(steps: AutomationStep[]): void {
  for (const step of steps) {
    if (step.kind !== 'action' && step.kind !== 'verify') continue;
    if (!getCatalogAction(step.actionId)) {
      throw Errors.badRequest(
        'STUDIO_AUTOMATION_BAD_STEP',
        `Step '${step.id}': unknown catalog action '${step.actionId}'`,
      );
    }
  }
}

export async function automationRoutes(fastify: FastifyInstance): Promise<void> {
  // ------------------------------------------------------------------
  // AI generation (Wave 3): NL -> draft, explanations, step suggestions.
  //
  // POST /studio/automations/generate creates a NEW automation as `draft`
  // (never deployed, no trigger wired). The destructive-confirm gate on
  // POST /:id/deploy is the only path to a live automation.
  // ------------------------------------------------------------------

  fastify.post(
    '/studio/automations/generate',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const parsed = generateAutomationInput.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid generate request', parsed.error.flatten());
      }
      // Abort model generation if the client disconnects.
      const controller = new AbortController();
      (req.raw as unknown as NodeJS.EventEmitter).on('close', () => controller.abort());
      // Fail-closed: schema/model failures throw 502 before any draft exists.
      const view = await generateAutomationDraft(auth, parsed.data, controller.signal, req.requestId);
      return reply.status(201).send(view);
    }
  );

  // ------------------------------------------------------------------
  // Automations CRUD
  // ------------------------------------------------------------------

  fastify.get('/studio/automations', { preHandler: runPre }, async (req, reply) => {
    automationRoutesEnabled();
    const auth = req.auth!;
    const query = listAutomationsInput.safeParse(req.query);
    if (!query.success) {
      throw Errors.badRequest('VALIDATION_ERROR', 'Invalid query', query.error.flatten());
    }
    const docs = await listAutomations(auth.tenantId, query.data);
    return reply.send({ items: docs.map(toAutomationView) });
  });

  fastify.post(
    '/studio/automations',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const parsed = createAutomationInput.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation', parsed.error.flatten());
      }
      assertKnownActions(parsed.data.steps);
      const doc = await createAutomation(auth, parsed.data);
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'STUDIO_AUTOMATION_CREATED',
        success: true,
        metadata: { automationId: doc._id, name: doc.name, triggerKind: doc.trigger.kind },
      });
      return reply.status(201).send(toAutomationView(doc));
    }
  );

  fastify.get('/studio/automations/:id', { preHandler: runPre }, async (req, reply) => {
    automationRoutesEnabled();
    const auth = req.auth!;
    const params = automationIdParam.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
    const doc = await getAutomation(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
    return reply.send(toAutomationView(doc));
  });

  fastify.patch(
    '/studio/automations/:id',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 20, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const body = updateAutomationInput.safeParse(req.body);
      if (!body.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation', body.error.flatten());
      }
      if (body.data.steps) assertKnownActions(body.data.steps);
      const doc = await updateAutomation(auth.tenantId, params.data.id, body.data, auth.userId);
      await recordAudit({
        tenantId: auth.tenantId,
        userId: auth.userId,
        requestId: req.requestId,
        action: 'STUDIO_AUTOMATION_UPDATED',
        success: true,
        metadata: { automationId: doc._id, name: doc.name, status: doc.status },
      });
      return reply.send(toAutomationView(doc));
    }
  );

  fastify.delete('/studio/automations/:id', { preHandler: managePre }, async (req, reply) => {
    automationRoutesEnabled();
    const auth = req.auth!;
    const params = automationIdParam.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
    const doc = await getAutomation(auth.tenantId, params.data.id);
    if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
    // Tear down triggers and studio-managed flows BEFORE deleting the doc:
    // a deleted automation must never keep firing.
    await teardownAutomation(auth.tenantId, doc);
    await deleteAutomation(auth.tenantId, params.data.id);
    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      action: 'STUDIO_AUTOMATION_DELETED',
      success: true,
      metadata: { automationId: params.data.id, name: doc.name },
    });
    return reply.status(204).send();
  });

  // ------------------------------------------------------------------
  // Explain & suggest (Wave 3): deterministic, derived from the stored
  // definition and the real catalog. Never invents steps; suggestions are
  // returned only, never applied automatically.
  // ------------------------------------------------------------------

  fastify.post(
    '/studio/automations/:id/explain',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const doc = await getAutomation(auth.tenantId, params.data.id);
      if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
      return reply.send(explainAutomation(doc));
    }
  );

  fastify.post(
    '/studio/automations/:id/suggest',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const doc = await getAutomation(auth.tenantId, params.data.id);
      if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
      return reply.send({ automationId: doc._id, suggestions: suggestNextSteps(doc) });
    }
  );

  // ------------------------------------------------------------------
  // Test (dry run), manual run, deploy, undeploy
  // ------------------------------------------------------------------

  fastify.post(
    '/studio/automations/:id/test',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const body = testAutomationInput.safeParse(req.body ?? {});
      if (!body.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid test input', body.error.flatten());
      }
      const doc = await getAutomation(auth.tenantId, params.data.id);
      if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
      const report = await dryRunAutomation(auth, doc, body.data.inputs);
      return reply.send(report);
    }
  );

  fastify.post(
    '/studio/automations/:id/run',
    {
      preHandler: runPre,
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const body = runAutomationInput.safeParse(req.body ?? {});
      if (!body.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid run input', body.error.flatten());
      }
      const result = await runAutomationNow(auth, params.data.id, body.data, req.requestId);
      return reply.status(202).send(result);
    }
  );

  fastify.post(
    '/studio/automations/:id/deploy',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const body = deployAutomationInput.safeParse(req.body ?? {});
      if (!body.success) {
        throw Errors.badRequest('VALIDATION_ERROR', 'Invalid deploy input', body.error.flatten());
      }
      const result = await deployAutomation(auth, params.data.id, body.data, req.requestId);
      // The raw webhook token is returned EXACTLY once, here, when issued.
      // It is never persisted, logged, or returned again.
      return reply.send({
        ...toAutomationView(result.automation),
        ...(result.webhookToken
          ? {
              webhookToken: result.webhookToken,
              webhookTokenRotated: result.webhookTokenRotated,
              webhookUrl: `/api/v1/studio/hooks/${result.webhookToken}`,
            }
          : {}),
      });
    }
  );

  fastify.post(
    '/studio/automations/:id/undeploy',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const doc = await undeployAutomation(auth, params.data.id, req.requestId);
      return reply.send(toAutomationView(doc));
    }
  );

  fastify.post(
    '/studio/automations/:id/webhook/rotate',
    {
      preHandler: managePre,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const auth = req.auth!;
      const params = automationIdParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid automation id');
      const result = await rotateWebhookToken(auth, params.data.id, req.requestId);
      return reply.send({
        ...toAutomationView(result.automation),
        webhookToken: result.webhookToken,
        webhookUrl: `/api/v1/studio/hooks/${result.webhookToken}`,
      });
    }
  );

  // ------------------------------------------------------------------
  // Runs
  // ------------------------------------------------------------------

  fastify.get('/studio/runs', { preHandler: runPre }, async (req, reply) => {
    automationRoutesEnabled();
    const auth = req.auth!;
    const query = listStudioRunsInput.safeParse(req.query);
    if (!query.success) {
      throw Errors.badRequest('VALIDATION_ERROR', 'Invalid query', query.error.flatten());
    }
    if (query.data.automationId) {
      const doc = await getAutomation(auth.tenantId, query.data.automationId);
      if (!doc) throw Errors.notFound('STUDIO_AUTOMATION_NOT_FOUND', 'Automation not found');
    }
    return reply.send({ items: await listStudioRuns(auth.tenantId, query.data) });
  });

  fastify.get('/studio/runs/:id', { preHandler: runPre }, async (req, reply) => {
    automationRoutesEnabled();
    const auth = req.auth!;
    const params = automationIdParam.safeParse(req.params);
    if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid run id');
    const run = await getStudioRun(auth.tenantId, params.data.id);
    if (!run) throw Errors.notFound('STUDIO_RUN_NOT_FOUND', 'Studio run not found');
    // Step logs carry output SHAPES, never values (Flows platform design,
    // ADR-004): per-step results are status + timing + shape + error code.
    // Inputs are omitted like the platform's own run detail — they may
    // carry caller-supplied values the run was invoked with.
    return reply.send({
      id: run._id,
      automationId: run.automationId,
      kind: run.kind,
      flowName: run.flowName,
      flowVersion: run.flowVersion,
      status: run.status,
      steps: run.steps,
      resultSummary: run.resultSummary,
      blockedReason: run.blockedReason,
      scheduleRef: run.scheduleRef,
      confirmWrites: run.confirmWrites,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
      ...(run.startedAt ? { startedAt: run.startedAt.toISOString() } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt.toISOString() } : {}),
    });
  });

  // ------------------------------------------------------------------
  // Webhook ingress (token-gated; no session auth)
  // ------------------------------------------------------------------

  fastify.post(
    '/studio/hooks/:token',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      automationRoutesEnabled();
      const params = webhookTokenParam.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid webhook token');
      // An absent body fires with empty inputs; anything else must be a
      // JSON object (it becomes the run's inputs).
      const payload = req.body === undefined || req.body === null ? {} : req.body;
      const result = await fireWebhook(params.data.token, payload);
      return reply.status(202).send(result);
    }
  );
}
