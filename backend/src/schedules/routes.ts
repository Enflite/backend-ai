/**
 * routes.ts — Schedules platform HTTP API (ADR-023), mounted at /api/v1.
 *
 * Schedule management (schedules:manage):
 *   POST   /schedules                  create a schedule
 *   PUT    /schedules/:name            update a schedule
 *   DELETE /schedules/:name            delete a schedule
 *   POST   /schedules/:name/pause      disable a schedule
 *   POST   /schedules/:name/resume     re-enable a schedule
 *
 * Inspection and manual firing (schedules:run):
 *   GET    /schedules                  list schedules (summaries)
 *   GET    /schedules/:name            get a schedule (full document)
 *   POST   /schedules/:name/run-now    fire the schedule immediately
 *   GET    /schedules/:name/runs       flow runs fired by this schedule
 *   GET    /schedules/:name/stats      per-status run counts
 *
 * Everything is behind SCHEDULES_ENABLED (403 FEATURE_DISABLED when off).
 * All inputs are zod-validated; Errors.* codes throughout. Audit metadata
 * carries names and ids only — never input values (inputs may carry
 * secrets).
 *
 * STORE CONTRACT (`scheduleStore.ts`):
 * - createSchedule(auth, input): Promise<ScheduleDoc>
 *   Throws SCHEDULE_NAME_CONFLICT (409) on a duplicate name,
 *   FLOW_NOT_FOUND (404) when the target flow does not exist,
 *   INVALID_RUN_AS_USER (400) for a non-member runAs user, and
 *   CRON_HAS_NO_OCCURRENCE (400) when the trigger has no occurrence.
 * - listSchedules(tenantId, { enabled?, limit }): Promise<ScheduleDoc[]>
 * - getSchedule(tenantId, name): Promise<ScheduleDoc | null>
 * - updateSchedule(tenantId, name, patch, userId): Promise<ScheduleDoc>
 *   (throws SCHEDULE_NOT_FOUND; same validation as create)
 * - deleteSchedule(tenantId, name): Promise<void>
 *   (throws SCHEDULE_NOT_FOUND)
 * - pauseSchedule(tenantId, name) / resumeSchedule(tenantId, name):
 *   Promise<ScheduleDoc> (throws SCHEDULE_NOT_FOUND; resume recomputes
 *   nextRunAt from now — no stale-tick bursts)
 * - getScheduleStats(tenantId, scheduleId): Promise<ScheduleStats>
 *   (throws SCHEDULE_NOT_FOUND)
 *
 * GET /schedules/:name/runs reads flow_runs directly (tenantId +
 * 'scheduleRef.scheduleId', newest first).
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import type { AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { config } from '../config.js';
import { recordAudit } from '../audit/audit.js';
import { getDb } from '../db/mongo.js';
import { runSummary } from '../flows/routes.js';
import type { FlowRunDoc } from '../flows/flowTypes.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  getScheduleStats,
  listSchedules,
  pauseSchedule,
  resumeSchedule,
  updateSchedule,
} from './scheduleStore.js';
import { fireScheduleNow } from './scheduleRunner.js';
import {
  createScheduleInput,
  listScheduleRunsInput,
  listSchedulesInput,
  runNowInput,
  scheduleNameSchema,
  updateScheduleInput,
  type ScheduleDoc,
} from './scheduleTypes.js';

// The schedules:* permissions live in authz/permissions.ts (PERMISSIONS).
const SCHEDULES_MANAGE = 'schedules:manage' as const;
const SCHEDULES_RUN = 'schedules:run' as const;

function assertSchedulesEnabled(): void {
  if (!config.SCHEDULES_ENABLED) {
    throw Errors.forbidden(
      'FEATURE_DISABLED',
      'Schedules are disabled (SCHEDULES_ENABLED=false)',
    );
  }
}

function scheduleSummary(schedule: ScheduleDoc): Record<string, unknown> {
  return {
    id: schedule._id,
    name: schedule.name,
    title: schedule.title,
    description: schedule.description,
    target: schedule.target,
    trigger: schedule.trigger,
    enabled: schedule.enabled,
    confirmWrites: schedule.confirmWrites,
    runAsUserId: schedule.runAsUserId,
    nextRunAt: schedule.nextRunAt?.toISOString() ?? null,
    lastRunAt: schedule.lastRunAt?.toISOString() ?? null,
    lastRunId: schedule.lastRunId ?? null,
    lastTickStatus: schedule.lastTickStatus ?? null,
    createdBy: schedule.createdBy,
    createdAt: schedule.createdAt.toISOString(),
    updatedAt: schedule.updatedAt.toISOString(),
  };
}

function scheduleDetail(schedule: ScheduleDoc): Record<string, unknown> {
  return { ...scheduleSummary(schedule), inputs: schedule.inputs };
}

async function auditSchedule(
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

const nameParams = z.object({ name: scheduleNameSchema });

export async function scheduleRoutes(fastify: FastifyInstance): Promise<void> {
  // -- Management (schedules:manage) ----------------------------------------

  fastify.post(
    '/schedules',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_MANAGE)], bodyLimit: 256 * 1024 },
    async (req, reply) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const parsed = createScheduleInput.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE',
          `Invalid schedule: ${parsed.error.issues.slice(0, 3).map((issue: z.ZodIssue) => issue.message).join('; ')}`,
        );
      }
      const schedule = await createSchedule(auth, parsed.data);
      await auditSchedule(auth, 'SCHEDULE_CREATED', true, {
        scheduleName: schedule.name,
        flowName: schedule.target.flowName,
      });
      return reply.status(201).send({ schedule: scheduleSummary(schedule) });
    },
  );

  fastify.put(
    '/schedules/:name',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_MANAGE)], bodyLimit: 256 * 1024 },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const body = updateScheduleInput.safeParse(req.body);
      if (!body.success) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE',
          `Invalid schedule update: ${body.error.issues.slice(0, 3).map((issue: z.ZodIssue) => issue.message).join('; ')}`,
        );
      }
      const schedule = await updateSchedule(auth.tenantId, params.data.name, body.data);
      await auditSchedule(auth, 'SCHEDULE_UPDATED', true, { scheduleName: schedule.name });
      return { schedule: scheduleDetail(schedule) };
    },
  );

  fastify.delete(
    '/schedules/:name',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_MANAGE)] },
    async (req, reply) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      await deleteSchedule(auth.tenantId, params.data.name);
      await auditSchedule(auth, 'SCHEDULE_DELETED', true, { scheduleName: params.data.name });
      return reply.status(204).send();
    },
  );

  fastify.post(
    '/schedules/:name/pause',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_MANAGE)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const schedule = await pauseSchedule(auth.tenantId, params.data.name);
      await auditSchedule(auth, 'SCHEDULE_PAUSED', true, { scheduleName: schedule.name });
      return { schedule: scheduleSummary(schedule) };
    },
  );

  fastify.post(
    '/schedules/:name/resume',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_MANAGE)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const schedule = await resumeSchedule(auth.tenantId, params.data.name);
      await auditSchedule(auth, 'SCHEDULE_RESUMED', true, { scheduleName: schedule.name });
      return { schedule: scheduleSummary(schedule) };
    },
  );

  // -- Inspection and manual firing (schedules:run) -------------------------

  fastify.get(
    '/schedules',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_RUN)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const query = listSchedulesInput.safeParse(req.query);
      if (!query.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid query');
      const schedules = await listSchedules(auth.tenantId, query.data);
      return { schedules: schedules.map(scheduleSummary) };
    },
  );

  fastify.get(
    '/schedules/:name',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_RUN)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const schedule = await getSchedule(auth.tenantId, params.data.name);
      if (!schedule) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
      return { schedule: scheduleDetail(schedule) };
    },
  );

  fastify.post(
    '/schedules/:name/run-now',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_RUN)], bodyLimit: 256 * 1024 },
    async (req, reply) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const body = runNowInput.safeParse(req.body);
      if (!body.success) {
        throw Errors.badRequest(
          'INVALID_SCHEDULE_REQUEST',
          `Invalid run-now request: ${body.error.issues.slice(0, 3).map((issue: z.ZodIssue) => issue.message).join('; ')}`,
        );
      }
      const schedule = await getSchedule(auth.tenantId, params.data.name);
      if (!schedule) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
      // fireScheduleNow owns the SCHEDULE_RUN_NOW audit (caller identity).
      const run = await fireScheduleNow(auth, schedule, body.data);
      return reply.status(202).send({ run: runSummary(run), manual: true });
    },
  );

  fastify.get(
    '/schedules/:name/runs',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_RUN)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const query = listScheduleRunsInput.safeParse(req.query);
      if (!query.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid query');
      const schedule = await getSchedule(auth.tenantId, params.data.name);
      if (!schedule) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
      const db = await getDb();
      const filter: Record<string, unknown> = {
        tenantId: auth.tenantId,
        'scheduleRef.scheduleId': schedule._id,
      };
      if (query.data.status) filter.status = query.data.status;
      const runs = await db
        .collection<FlowRunDoc>('flow_runs')
        .find(filter)
        .sort({ createdAt: -1 })
        .limit(query.data.limit)
        .toArray();
      return { runs: runs.map(runSummary) };
    },
  );

  fastify.get(
    '/schedules/:name/stats',
    { preHandler: [requireAuth, requirePermission(SCHEDULES_RUN)] },
    async (req) => {
      assertSchedulesEnabled();
      const auth = req.auth!;
      const params = nameParams.safeParse(req.params);
      if (!params.success) throw Errors.badRequest('INVALID_SCHEDULE_REQUEST', 'Invalid schedule name');
      const schedule = await getSchedule(auth.tenantId, params.data.name);
      if (!schedule) throw Errors.notFound('SCHEDULE_NOT_FOUND', 'Schedule not found');
      const stats = await getScheduleStats(auth.tenantId, schedule._id);
      return {
        stats: {
          ...stats,
          nextRunAt: stats.nextRunAt?.toISOString() ?? null,
          lastRunAt: stats.lastRunAt?.toISOString() ?? null,
        },
      };
    },
  );
}
