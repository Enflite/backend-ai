/**
 * routes.ts — REST API for SyteLine task-agent runs (`/api/v1/syteline-tasks`).
 *
 * Task CRUD stays on the `syteline.task.*` tools; this module serves what
 * tools cannot: binary evidence. Per-step screenshot evidence is captured
 * server-side (tenant-scoped) and referenced by id in the step log; the
 * model only ever sees ids. This endpoint lets the frontend render the
 * actual pixels behind the evidence chips.
 *
 * - GET /syteline-tasks/:id/evidence/:evidenceId — stream the PNG bytes.
 *
 * Access: auth + `syteline:ui` permission, fail-fast 403 FEATURE_DISABLED
 * while SYTELINE_UI_ENABLED=false (same posture as every other
 * syteline.ui surface). Visibility follows the task rules: the requester
 * or an admin (tenant:manage). Anything else is 404 — never 403 — so
 * task existence never leaks to unauthorized callers. Evidence bytes are
 * never logged; the access audit carries identifiers only.
 *
 * Browser screenshots here REQUIRE REAL SYTELINE; the route logic is
 * VALIDATED IN CI.
 */

import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import type { AuthContext } from '../../authz/permissions.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import { recordAudit } from '../../audit/audit.js';
import { readScreenshotEvidence } from '../../tools/sytelineUi.js';
import { assertTaskVisible, getTask } from './taskStore.js';
import { taskIdParam } from './taskTypes.js';

/** Evidence ids are randomUUIDs at store time — strict shape, no traversal. */
const evidenceIdParam = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    'evidenceId must be a UUID',
  );

const evidenceParams = z
  .object({ id: taskIdParam, evidenceId: evidenceIdParam })
  .strict();

/** Admins (tenant:manage) see the tenant's tasks; others see only their own. */
function isTaskAdmin(auth: AuthContext): boolean {
  return auth.permissions.includes('tenant:manage');
}

function validationError(message: string, details?: unknown): never {
  throw Errors.badRequest('VALIDATION_ERROR', message, details);
}

async function requireUiEnabled(_req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!config.SYTELINE_UI_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'SyteLine UI automation is disabled (SYTELINE_UI_ENABLED=false)',
    );
  }
}

export async function sytelineTaskRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/syteline-tasks/:id/evidence/:evidenceId', {
    preHandler: [requireAuth, requirePermission('syteline:ui'), requireUiEnabled],
  }, async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = req.auth!;
    const parsed = evidenceParams.safeParse(req.params);
    if (!parsed.success) {
      validationError('Invalid task or evidence id', parsed.error.issues);
    }
    const { id: taskId, evidenceId } = parsed.data;

    // Tenant-scoped fetch first; missing or foreign tasks are 404.
    const task = await getTask(auth.tenantId, taskId);
    if (!task) {
      throw Errors.notFound('TASK_NOT_FOUND', 'Task not found');
    }
    // Requester or admin — anything else is 404, never 403 (no existence leak).
    assertTaskVisible(task, auth.userId, isTaskAdmin(auth));

    // Defense in depth: the evidence must actually belong to this task, so
    // a UUID can never be used to probe another task's (or tenant's) files.
    const onTask = task.steps.some((step) => step.evidenceIds.includes(evidenceId));
    if (!onTask) {
      throw Errors.notFound('EVIDENCE_NOT_FOUND', 'Evidence not found');
    }

    const bytes = await readScreenshotEvidence(auth.tenantId, evidenceId);
    if (!bytes) {
      throw Errors.notFound('EVIDENCE_NOT_FOUND', 'Evidence not found');
    }

    await recordAudit({
      tenantId: auth.tenantId,
      userId: auth.userId,
      requestId: req.requestId,
      ip: req.ip,
      action: 'SYTELINE_TASK_EVIDENCE_READ',
      success: true,
      // Identifiers only — never evidence bytes.
      metadata: { taskId, evidenceId, bytes: bytes.length },
    });

    reply.header('content-type', 'image/png');
    reply.header('content-length', bytes.length);
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(bytes);
  });
}
