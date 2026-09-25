/**
 * finetune/localProvider.ts — self-hosted GPU worker provider (ADR-015).
 *
 * The "use our machines" path. The API server NEVER trains: `submitJob` is a
 * no-op because enqueueing the job document (done by jobs.ts) IS the
 * submission — the `finetune_jobs` collection is the durable queue.
 * Self-hosted GPU workers claim jobs atomically with findOneAndUpdate
 * (same pattern as the document-ingestion queue) and report progress by
 * updating the job document. See backend/scripts/finetune-worker/ for the
 * reference worker and the exact claim contract.
 *
 * Toggle: FINETUNE_PROVIDER=local. No credentials, no egress, no third
 * parties — training data never leaves your infrastructure.
 */
import { tenantOp } from '../../db/mongo.js';
import type {
  FineTuneProvider,
  FinetuneJobDoc,
  FinetuneJobSpec,
  ProviderJobStatus,
} from './types.js';

export class LocalFineTuneProvider implements FineTuneProvider {
  readonly name = 'local' as const;

  async submitJob(_spec: FinetuneJobSpec): Promise<{ providerJobId?: string }> {
    // Enqueueing the finetune_jobs document is the submission mechanism.
    // Workers poll the queue; nothing to do here.
    return {};
  }

  async getJobStatus(job: FinetuneJobDoc): Promise<ProviderJobStatus> {
    // The worker owns status transitions; the API only reads.
    return {
      status: job.status,
      artifactRef: job.artifactRef,
      error: job.error,
    };
  }

  async cancelJob(job: FinetuneJobDoc): Promise<boolean> {
    // Only queued (unclaimed) jobs can be cancelled from the API; a worker
    // holding a running job must observe cancellation itself.
    const updated = await tenantOp(job.tenantId, (db) =>
      db.collection<FinetuneJobDoc>('finetune_jobs').findOneAndUpdate(
        { _id: job._id, tenantId: job.tenantId, status: 'queued' },
        { $set: { status: 'cancelled', updatedAt: new Date() } },
        { returnDocument: 'after' }
      )
    );
    return updated !== null;
  }
}
