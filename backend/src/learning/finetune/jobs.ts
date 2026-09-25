/**
 * finetune/jobs.ts — fine-tune job orchestration (ADR-015, stage 3).
 *
 * Lifecycle: queued → running → succeeded | failed | cancelled.
 *
 * - `external`: the provider reports status; `syncJob` polls and persists.
 * - `local`: self-hosted workers own transitions via the queue; `syncJob`
 *   re-reads the document, and `requeueStaleJobs` recovers jobs whose worker
 *   died holding the lock.
 *
 * A succeeded job registers the artifact in `models` with status DRAFT and
 * enabled=false — it can NEVER serve traffic until the eval-gated promotion
 * flow (ADR-008) approves it. Training never auto-promotes.
 */
import { randomUUID } from 'node:crypto';
import { tenantOp } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { getDataset, datasetToJsonl } from '../dataset.js';
import { FeedbackContext } from '../feedbackStore.js';
import { isFineTuningEnabled, resolveFineTuneProvider } from './factory.js';
import type { FinetuneJobDoc, FinetuneJobStatus } from './types.js';

/** A worker holding a job longer than this is presumed dead. */
export const WORKER_STALE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export interface CreateJobInput {
  datasetId: string;
  baseModel?: string;
  hyperparameters?: Record<string, number | string>;
}

const DEFAULT_BASE_MODEL = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

function defaultBaseModel(): string {
  // Keep in sync with the migration-002 seed model; override per job.
  return DEFAULT_BASE_MODEL;
}

function sanitizeHyperparameters(
  raw: Record<string, number | string> | undefined
): Record<string, number | string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, number | string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof k !== 'string' || k.length > 64) continue;
    if (typeof v !== 'number' && typeof v !== 'string') continue;
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export async function createJob(
  ctx: FeedbackContext,
  input: CreateJobInput
): Promise<FinetuneJobDoc> {
  if (!isFineTuningEnabled()) {
    throw Errors.forbidden('FINETUNE_DISABLED', 'Fine-tuning is disabled on this server');
  }
  const dataset = await getDataset(ctx, input.datasetId);
  if (!dataset || dataset.status !== 'ready') {
    throw Errors.notFound('DATASET_NOT_FOUND', 'Dataset not found or not ready');
  }

  const now = new Date();
  const doc: FinetuneJobDoc = {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    datasetId: dataset._id,
    baseModel: input.baseModel?.trim() || defaultBaseModel(),
    status: 'queued',
    hyperparameters: sanitizeHyperparameters(input.hyperparameters),
    attempts: 0,
    createdBy: ctx.userId,
    createdAt: now,
    updatedAt: now,
  };
  await tenantOp(ctx.tenantId, (db) => db.collection<FinetuneJobDoc>('finetune_jobs').insertOne(doc));

  // Hand to the provider. For `local` this is a no-op (the queue is the
  // submission); for `external` it uploads the dataset and creates the
  // remote job.
  try {
    const provider = resolveFineTuneProvider();
    const { providerJobId } = await provider.submitJob({
      jobId: doc._id,
      tenantId: ctx.tenantId,
      trainingJsonl: datasetToJsonl(dataset),
      baseModel: doc.baseModel,
      hyperparameters: doc.hyperparameters,
    });
    if (providerJobId) {
      await tenantOp(ctx.tenantId, (db) =>
        db
          .collection<FinetuneJobDoc>('finetune_jobs')
          .updateOne(
            { _id: doc._id, tenantId: ctx.tenantId },
            { $set: { providerJobId, updatedAt: new Date() } }
          )
      );
      doc.providerJobId = providerJobId;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'provider submission failed';
    await tenantOp(ctx.tenantId, (db) =>
      db
        .collection<FinetuneJobDoc>('finetune_jobs')
        .updateOne(
          { _id: doc._id, tenantId: ctx.tenantId },
          { $set: { status: 'failed' as FinetuneJobStatus, error: message, updatedAt: new Date() } }
        )
    );
    doc.status = 'failed';
    doc.error = message;
  }
  return doc;
}

export async function getJob(ctx: FeedbackContext, id: string): Promise<FinetuneJobDoc | null> {
  return tenantOp(ctx.tenantId, (db) =>
    db.collection<FinetuneJobDoc>('finetune_jobs').findOne({ _id: id, tenantId: ctx.tenantId })
  );
}

export async function listJobs(ctx: FeedbackContext, limit = 50): Promise<FinetuneJobDoc[]> {
  const safeLimit = Math.min(Math.max(limit, 1), 100);
  return tenantOp(ctx.tenantId, (db) =>
    db
      .collection<FinetuneJobDoc>('finetune_jobs')
      .find({ tenantId: ctx.tenantId })
      .sort({ createdAt: -1 })
      .limit(safeLimit)
      .toArray()
  );
}

/**
 * Poll the provider and persist any status change. On success, registers the
 * artifact as a DRAFT model (never servable until eval-gated promotion).
 * Idempotent: re-syncing a terminal job is a no-op.
 */
export async function syncJob(ctx: FeedbackContext, id: string): Promise<FinetuneJobDoc> {
  const job = await getJob(ctx, id);
  if (!job) throw Errors.notFound('JOB_NOT_FOUND', 'Fine-tune job not found');
  if (job.status === 'failed' || job.status === 'cancelled') {
    return job;
  }
  if (job.status === 'succeeded') {
    // Local workers transition the document directly; the draft model may
    // not exist yet. Idempotent: registers only if missing.
    await ensureDraftModel(ctx, job);
    return job;
  }
  const provider = resolveFineTuneProvider();
  const remote = await provider.getJobStatus(job);
  if (remote.status === job.status && remote.artifactRef === job.artifactRef) {
    return job;
  }

  const now = new Date();
  const update: Partial<FinetuneJobDoc> = { updatedAt: now };
  if (remote.status !== job.status) update.status = remote.status;
  if (remote.artifactRef) update.artifactRef = remote.artifactRef;
  if (remote.error) update.error = remote.error;
  const updated = await tenantOp(ctx.tenantId, (db) =>
    db.collection<FinetuneJobDoc>('finetune_jobs').findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId },
      { $set: update },
      { returnDocument: 'after' }
    )
  );
  if (!updated) throw Errors.notFound('JOB_NOT_FOUND', 'Fine-tune job not found');

  if (updated.status === 'succeeded') {
    await ensureDraftModel(ctx, updated);
  }
  return updated;
}

/**
 * Recover `local` jobs whose worker died holding the lock: back to queued
 * with attempts incremented. Safe to run on a timer; only touches stale
 * `running` rows.
 */
export async function requeueStaleJobs(tenantId: string): Promise<number> {
  const cutoff = new Date(Date.now() - WORKER_STALE_TIMEOUT_MS);
  const res = await tenantOp(tenantId, (db) =>
    db.collection<FinetuneJobDoc>('finetune_jobs').updateMany(
      { tenantId, status: 'running', lockedAt: { $lte: cutoff } },
      {
        $set: { status: 'queued', updatedAt: new Date() },
        $inc: { attempts: 1 },
        $unset: { lockedAt: '', lockedBy: '' },
      }
    )
  );
  return res.modifiedCount ?? 0;
}

interface ModelDoc {
  _id: string;
  tenantId?: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  status: string;
  modelIdentifier: string;
  enabled: boolean;
  classification: string;
  allowedClassifications: string[];
  capabilities: Record<string, boolean>;
  contextWindow: number;
  deployment: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Idempotent DRAFT registration: registers the artifact only if no model
 * with this job id exists yet. Called for both provider-reported successes
 * (external) and worker-reported successes (local).
 */
async function ensureDraftModel(ctx: FeedbackContext, job: FinetuneJobDoc): Promise<void> {
  if (!job.artifactRef) return;
  const existing = await tenantOp(ctx.tenantId, (db) =>
    db.collection('models').findOne({ tenantId: ctx.tenantId, 'deployment.finetuneJobId': job._id })
  );
  if (!existing) {
    await registerDraftModel(ctx, job);
  }
}

/**
 * Register a succeeded training artifact as a DRAFT model. `enabled: false`
 * plus a non-servable status means the gateway can never route traffic to it
 * (it only serves ACTIVE/CANARY + enabled). Promotion is a separate,
 * eval-gated, human-approved step.
 */
async function registerDraftModel(ctx: FeedbackContext, job: FinetuneJobDoc): Promise<void> {
  const now = new Date();
  const doc: ModelDoc = {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    name: `finetune-${job.baseModel}-${job._id.slice(0, 8)}`,
    version: '1.0',
    provider: 'finetune',
    endpoint: job.artifactRef!,
    status: 'DRAFT',
    modelIdentifier: job.artifactRef!,
    enabled: false,
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    capabilities: { chat: true, streaming: true },
    contextWindow: 131072,
    deployment: { finetuneJobId: job._id, datasetId: job.datasetId, baseModel: job.baseModel },
    createdAt: now,
  };
  await tenantOp(ctx.tenantId, (db) => db.collection<ModelDoc>('models').insertOne(doc));
}
