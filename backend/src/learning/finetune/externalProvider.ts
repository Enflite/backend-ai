/**
 * finetune/externalProvider.ts — 3rd-party fine-tuning service (ADR-015).
 *
 * The testing path: rent GPU by the hour, no hardware. Speaks the
 * OpenAI-compatible fine-tuning REST dialect —
 *   POST {base}/v1/files                  (multipart upload, purpose=fine-tune)
 *   POST {base}/v1/fine_tuning/jobs       { training_file, model, hyperparameters }
 *   GET  {base}/v1/fine_tuning/jobs/{id}
 * — which covers OpenAI, Together AI and Fireworks AI.
 *
 * Security posture: the configured base URL's origin MUST be listed in
 * FINETUNE_ALLOWED_ORIGINS or construction throws. Training data leaves the
 * tenant boundary here, so operators must confirm the provider's
 * data-retention terms before enabling this on non-PUBLIC data.
 */
import { config } from '../../config.js';
import { Errors } from '../../errors.js';
import type {
  FineTuneProvider,
  FinetuneJobDoc,
  FinetuneJobSpec,
  ProviderJobStatus,
} from './types.js';

const REQUEST_TIMEOUT_MS = 30000;

/** Hyperparameters we forward; everything else is rejected. */
const HYPERPARAMETER_ALLOWLIST = new Set(['n_epochs', 'batch_size', 'learning_rate_multiplier']);

function allowedOrigins(): string[] {
  return config.FINETUNE_ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function assertExternalProviderAllowed(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw Errors.badRequest('INVALID_FINETUNE_URL', 'FINETUNE_API_BASE_URL is not a valid URL');
  }
  if (url.protocol !== 'https:') {
    throw Errors.badRequest('FINETUNE_URL_NOT_HTTPS', '3rd-party fine-tuning must use HTTPS');
  }
  const origins = allowedOrigins();
  if (!origins.includes(url.origin.toLowerCase())) {
    throw Errors.forbidden(
      'FINETUNE_ORIGIN_NOT_ALLOWED',
      'Fine-tuning service origin is not in FINETUNE_ALLOWED_ORIGINS'
    );
  }
  return url;
}

interface FileUploadResponse {
  id: string;
}
interface JobCreateResponse {
  id: string;
  status: string;
}
interface JobGetResponse {
  id: string;
  status: string;
  fine_tuned_model?: string | null;
  error?: { message?: string } | null;
}

function mapStatus(providerStatus: string): ProviderJobStatus['status'] {
  switch (providerStatus) {
    case 'validating_files':
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'succeeded':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
    default:
      return 'failed';
  }
}

export class ExternalFineTuneProvider implements FineTuneProvider {
  readonly name = 'external' as const;
  private readonly baseUrl: URL;
  private readonly apiKey: string;

  constructor(baseUrl?: string, apiKey?: string) {
    const url = baseUrl ?? config.FINETUNE_API_BASE_URL;
    if (!url) throw Errors.badRequest('FINETUNE_NOT_CONFIGURED', 'FINETUNE_API_BASE_URL is not set');
    this.baseUrl = assertExternalProviderAllowed(url);
    this.apiKey = apiKey ?? config.FINETUNE_API_KEY;
    if (!this.apiKey) throw Errors.badRequest('FINETUNE_NOT_CONFIGURED', 'FINETUNE_API_KEY is not set');
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.apiKey}`, ...extra };
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const url = new URL(path, this.baseUrl).toString();
    let res: Response;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      throw Errors.badRequest('FINETUNE_PROVIDER_UNREACHABLE', `Fine-tuning service unreachable: ${(err as Error).message}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw Errors.badRequest(
        'FINETUNE_PROVIDER_ERROR',
        `Fine-tuning service returned ${res.status}: ${body.slice(0, 300)}`
      );
    }
    return (await res.json()) as T;
  }

  private filteredHyperparameters(spec: FinetuneJobSpec): Record<string, number | string> | undefined {
    if (!spec.hyperparameters) return undefined;
    const out: Record<string, number | string> = {};
    for (const [k, v] of Object.entries(spec.hyperparameters)) {
      if (HYPERPARAMETER_ALLOWLIST.has(k)) out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  async submitJob(spec: FinetuneJobSpec): Promise<{ providerJobId?: string }> {
    // 1. Upload the training file.
    const form = new FormData();
    form.append('purpose', 'fine-tune');
    form.append('file', new Blob([spec.trainingJsonl], { type: 'application/x-ndjson' }), 'training.jsonl');
    const file = await this.request<FileUploadResponse>('/v1/files', {
      method: 'POST',
      headers: this.headers(),
      body: form,
    });
    if (!file.id) throw Errors.badRequest('FINETUNE_PROVIDER_ERROR', 'File upload returned no id');

    // 2. Create the fine-tune job.
    const payload: Record<string, unknown> = { training_file: file.id, model: spec.baseModel };
    const hyperparameters = this.filteredHyperparameters(spec);
    if (hyperparameters) payload.hyperparameters = hyperparameters;
    const job = await this.request<JobCreateResponse>('/v1/fine_tuning/jobs', {
      method: 'POST',
      headers: this.headers({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
    });
    if (!job.id) throw Errors.badRequest('FINETUNE_PROVIDER_ERROR', 'Job creation returned no id');
    return { providerJobId: job.id };
  }

  async getJobStatus(job: FinetuneJobDoc): Promise<ProviderJobStatus> {
    if (!job.providerJobId) return { status: job.status };
    const remote = await this.request<JobGetResponse>(
      `/v1/fine_tuning/jobs/${encodeURIComponent(job.providerJobId)}`,
      { method: 'GET', headers: this.headers() }
    );
    const status = mapStatus(remote.status);
    return {
      status,
      artifactRef: status === 'succeeded' ? remote.fine_tuned_model ?? undefined : undefined,
      error: status === 'failed' ? remote.error?.message ?? 'provider reported failure' : undefined,
    };
  }

  async cancelJob(job: FinetuneJobDoc): Promise<boolean> {
    if (!job.providerJobId) return false;
    try {
      await this.request<unknown>(
        `/v1/fine_tuning/jobs/${encodeURIComponent(job.providerJobId)}/cancel`,
        { method: 'POST', headers: this.headers() }
      );
      return true;
    } catch {
      return false;
    }
  }
}
