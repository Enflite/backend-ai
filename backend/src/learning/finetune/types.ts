/**
 * finetune/types.ts — fine-tune provider abstraction (ADR-015, stage 3).
 *
 * The API server orchestrates training but never trains: compute happens
 * either on a 3rd-party fine-tuning service (`external`, for testing) or on
 * self-hosted GPU workers (`local`, via the `finetune_jobs` queue). Both
 * providers implement this interface; application code asks the factory
 * (factory.ts) which one is active based on FINETUNE_PROVIDER.
 *
 * A succeeded job registers its artifact in the `models` collection with
 * status DRAFT — serving it requires the eval-gated promotion flow
 * (ADR-008). Training never auto-promotes.
 */

export const FINETUNE_JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type FinetuneJobStatus = (typeof FINETUNE_JOB_STATUSES)[number];

/** MongoDB document shape for the `finetune_jobs` collection (ADR-014). */
export interface FinetuneJobDoc {
  _id: string;
  tenantId: string;
  datasetId: string;
  /** Base model to fine-tune, e.g. meta-llama/Meta-Llama-3.1-8B-Instruct. */
  baseModel: string;
  /** Provider-side job id (external) — absent for local until claimed. */
  providerJobId?: string;
  status: FinetuneJobStatus;
  /** Provider-specific hyperparameter overrides (validated allowlist). */
  hyperparameters?: Record<string, number | string>;
  /** Where the trained artifact lives (set on success). */
  artifactRef?: string;
  error?: string;
  attempts: number;
  /** Local-worker claim fields (atomic claim pattern, cf. ingestion queue). */
  lockedAt?: Date;
  lockedBy?: string;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

/** What the API server hands a provider to start training. */
export interface FinetuneJobSpec {
  jobId: string;
  tenantId: string;
  /** JSONL training data (SFT format). */
  trainingJsonl: string;
  baseModel: string;
  hyperparameters?: Record<string, number | string>;
}

/** Normalized status view returned by every provider. */
export interface ProviderJobStatus {
  status: FinetuneJobStatus;
  /** Set when the provider reports success. */
  artifactRef?: string;
  /** Set when the provider reports failure. */
  error?: string;
}

export interface FineTuneProvider {
  readonly name: 'external' | 'local';
  /** Submit training work. Resolves when the provider has accepted the job. */
  submitJob(spec: FinetuneJobSpec): Promise<{ providerJobId?: string }>;
  /** Poll the provider for current status. */
  getJobStatus(job: FinetuneJobDoc): Promise<ProviderJobStatus>;
  /**
   * Best-effort cancellation. Returns true when the provider accepted the
   * cancellation; local queued jobs are always cancellable.
   */
  cancelJob(job: FinetuneJobDoc): Promise<boolean>;
}
