/**
 * jobRoutes.ts — fine-tune job API (ADR-015, stage 3).
 *
 *   POST   /learning/jobs        → create a job from a dataset (submits to provider)
 *   GET    /learning/jobs        → list jobs
 *   GET    /learning/jobs/:id    → one job
 *   POST   /learning/jobs/:id/sync → poll provider, persist status
 *
 * All endpoints require `finetune:manage` and fail closed when
 * FINETUNE_PROVIDER=disabled. Every mutation is audited.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../../auth/middleware.js';
import { requirePermission } from '../../authz/middleware.js';
import { AuthContext } from '../../authz/permissions.js';
import { Errors } from '../../errors.js';
import { recordAudit } from '../../audit/audit.js';
import { createJob, getJob, listJobs, syncJob } from './jobs.js';
import { FeedbackContext } from '../feedbackStore.js';

const uuidSchema = z.string().uuid();
const createSchema = z.object({
  datasetId: uuidSchema,
  baseModel: z.string().trim().min(1).max(200).optional(),
  hyperparameters: z.record(z.string().max(64), z.union([z.number(), z.string().max(120)])).optional(),
}).strict();

function contextOf(auth: AuthContext): FeedbackContext {
  return { tenantId: auth.tenantId, userId: auth.userId, clearance: auth.clearance };
}

function toPublic(doc: {
  _id: string; datasetId: string; baseModel: string; providerJobId?: string;
  status: string; artifactRef?: string; error?: string; attempts: number;
  createdBy: string; createdAt: Date; updatedAt: Date;
}) {
  return {
    id: doc._id, datasetId: doc.datasetId, baseModel: doc.baseModel,
    providerJobId: doc.providerJobId, status: doc.status,
    artifactRef: doc.artifactRef, error: doc.error, attempts: doc.attempts,
    createdBy: doc.createdBy, createdAt: doc.createdAt, updatedAt: doc.updatedAt,
  };
}

export async function finetuneJobRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/learning/jobs', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid job parameters');
    const job = await createJob(contextOf(auth), parsed.data);
    await recordAudit({
      tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'FINETUNE_JOB_CREATE', resource: 'finetune_job', resourceId: job._id,
      classification: auth.clearance,
    });
    return reply.status(201).send({ job: toPublic(job) });
  });

  fastify.get('/learning/jobs', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const jobs = await listJobs(contextOf(auth));
    return reply.send({ jobs: jobs.map(toPublic) });
  });

  fastify.get('/learning/jobs/:id', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid job id');
    const job = await getJob(contextOf(auth), params.data.id);
    if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Fine-tune job not found');
    return reply.send({ job: toPublic(job) });
  });

  fastify.post('/learning/jobs/:id/sync', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid job id');
    const job = await syncJob(contextOf(auth), params.data.id);
    await recordAudit({
      tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'FINETUNE_JOB_SYNC', resource: 'finetune_job', resourceId: job._id,
      classification: auth.clearance,
    });
    return reply.send({ job: toPublic(job) });
  });
}
