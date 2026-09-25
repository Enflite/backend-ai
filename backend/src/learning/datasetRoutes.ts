/**
 * datasetRoutes.ts — dataset curation API (ADR-015, stage 2).
 *
 *   POST   /learning/datasets             → build a dataset from approved feedback
 *   GET    /learning/datasets             → list datasets (metadata, not examples)
 *   GET    /learning/datasets/:id         → dataset metadata
 *   GET    /learning/datasets/:id/export  → download JSONL (audited)
 *
 * Building and exporting require `finetune:manage`. Export is audited because
 * training data leaves the system here.
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { AuthContext } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { recordAudit } from '../audit/audit.js';
import {
  buildDataset,
  datasetToJsonl,
  getDataset,
  listDatasets,
} from './dataset.js';
import { FeedbackContext } from './feedbackStore.js';

const uuidSchema = z.string().uuid();
const buildSchema = z.object({ name: z.string().trim().min(1).max(120) }).strict();

function contextOf(auth: AuthContext): FeedbackContext {
  return { tenantId: auth.tenantId, userId: auth.userId, clearance: auth.clearance };
}

/** Metadata view: never ships the (potentially large) examples array. */
function toMetadata(doc: {
  _id: string; name: string; status: string; exampleCount: number;
  skippedCount: number; createdBy: string; createdAt: Date;
}) {
  return {
    id: doc._id, name: doc.name, status: doc.status,
    exampleCount: doc.exampleCount, skippedCount: doc.skippedCount,
    createdBy: doc.createdBy, createdAt: doc.createdAt,
  };
}

export async function datasetRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/learning/datasets', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const parsed = buildSchema.safeParse(req.body ?? {});
    if (!parsed.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid dataset parameters');
    const dataset = await buildDataset(contextOf(auth), parsed.data);
    await recordAudit({
      tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'DATASET_BUILD', resource: 'finetune_dataset', resourceId: dataset._id,
      classification: auth.clearance,
    });
    return reply.status(201).send({ dataset: toMetadata(dataset) });
  });

  fastify.get('/learning/datasets', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const datasets = await listDatasets(contextOf(auth));
    return reply.send({ datasets: datasets.map(toMetadata) });
  });

  fastify.get('/learning/datasets/:id', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid dataset id');
    const dataset = await getDataset(contextOf(auth), params.data.id);
    if (!dataset) throw Errors.notFound('DATASET_NOT_FOUND', 'Dataset not found');
    return reply.send({ dataset: toMetadata(dataset) });
  });

  fastify.get('/learning/datasets/:id/export', { preHandler: [requireAuth, requirePermission('finetune:manage')] }, async (req, reply) => {
    const auth = req.auth!;
    const params = z.object({ id: uuidSchema }).safeParse(req.params);
    if (!params.success) throw Errors.badRequest('INVALID_REQUEST', 'Invalid dataset id');
    const dataset = await getDataset(contextOf(auth), params.data.id);
    if (!dataset) throw Errors.notFound('DATASET_NOT_FOUND', 'Dataset not found');
    await recordAudit({
      tenantId: auth.tenantId, userId: auth.userId, requestId: req.requestId, ip: req.ip,
      action: 'DATASET_EXPORT', resource: 'finetune_dataset', resourceId: dataset._id,
      classification: auth.clearance,
    });
    const jsonl = datasetToJsonl(dataset);
    return reply
      .header('Content-Type', 'application/x-ndjson')
      .header('Content-Disposition', `attachment; filename="${dataset.name}.jsonl"`)
      .send(jsonl);
  });
}

// Re-export for the aggregated learning routes plugin.
export type { FeedbackContext };
