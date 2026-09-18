/**
 * observability/metrics.ts — dependency-free in-memory RED metrics.
 *
 * A tiny Prometheus-compatible metrics registry with zero npm dependencies.
 * Counters and histograms with labels cover the RED signals (Rate, Errors,
 * Duration) for the workloads that matter for scaling:
 *
 *   - HTTP requests (all routes): rate / errors / duration
 *   - Chat turns: rate / errors / duration + time-to-first-token
 *   - Retrieval / RAG queries: rate / errors / duration
 *   - Ingestion jobs: enqueued / processed / failed / quarantined + duration
 *   - Eval runs: rate / errors / duration
 *
 * In-process and resettable: the registry lives per Node process, so
 * multi-instance deployments must scrape every instance (or federate) —
 * see docs/scale.md. Metrics helpers must never throw; every record* helper
 * below swallows its own errors so instrumentation can never break a request.
 */
import { FastifyInstance } from 'fastify';
import { config } from '../config.js';

/** Sanitize a label value for the Prometheus text exposition format. */
function sanitizeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function sanitizeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_:]/g, '_');
}

export type Labels = Record<string, string>;

function labelKey(labelNames: string[], labels: Labels): string {
  return labelNames.map((name) => labels[name] ?? '').join('␟');
}

function renderLabelSet(labelNames: string[], labels: Labels, extra?: string): string {
  const parts = labelNames.map(
    (name) => `${sanitizeName(name)}="${sanitizeLabelValue(labels[name] ?? '')}"`
  );
  if (extra) parts.push(extra);
  return parts.length ? `{${parts.join(',')}}` : '';
}

class Counter {
  readonly name: string;
  readonly help: string;
  readonly labelNames: string[];
  private values = new Map<string, { labels: Labels; value: number }>();

  constructor(name: string, help: string, labelNames: string[] = []) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
  }

  inc(labels: Labels = {}, amount = 1): void {
    if (!Number.isFinite(amount) || amount < 0) return;
    const key = labelKey(this.labelNames, labels);
    const existing = this.values.get(key);
    if (existing) {
      existing.value += amount;
    } else {
      const picked: Labels = {};
      for (const name of this.labelNames) picked[name] = labels[name] ?? '';
      this.values.set(key, { labels: picked, value: amount });
    }
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
    for (const { labels, value } of this.values.values()) {
      lines.push(`${this.name}${renderLabelSet(this.labelNames, labels)} ${value}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.values.clear();
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** TTFB buckets skew low: sub-second first tokens are the norm on a warm provider. */
const TTFB_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30];

class Histogram {
  readonly name: string;
  readonly help: string;
  readonly labelNames: string[];
  readonly buckets: number[];
  // Per series: counts[i] holds observations in (buckets[i-1], buckets[i]],
  // counts[buckets.length] holds (buckets[last], +Inf). Rendered cumulatively.
  private series = new Map<string, { labels: Labels; counts: number[]; sum: number }>();

  constructor(name: string, help: string, labelNames: string[] = [], buckets: number[] = DEFAULT_BUCKETS) {
    this.name = name;
    this.help = help;
    this.labelNames = labelNames;
    this.buckets = [...buckets].sort((a, b) => a - b);
  }

  observe(labels: Labels, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const key = labelKey(this.labelNames, labels);
    let entry = this.series.get(key);
    if (!entry) {
      const picked: Labels = {};
      for (const name of this.labelNames) picked[name] = labels[name] ?? '';
      entry = { labels: picked, counts: new Array(this.buckets.length + 1).fill(0), sum: 0 };
      this.series.set(key, entry);
    }
    entry.sum += value;
    let bucket = this.buckets.length; // +Inf by default
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        bucket = i;
        break;
      }
    }
    entry.counts[bucket]! += 1;
  }

  render(): string {
    const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
    for (const { labels, counts, sum } of this.series.values()) {
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += counts[i]!;
        lines.push(
          `${this.name}_bucket${renderLabelSet(this.labelNames, labels, `le="${this.buckets[i]}"`)} ${cumulative}`
        );
      }
      cumulative += counts[this.buckets.length]!;
      lines.push(`${this.name}_bucket${renderLabelSet(this.labelNames, labels, 'le="+Inf"')} ${cumulative}`);
      lines.push(`${this.name}_sum${renderLabelSet(this.labelNames, labels)} ${sum}`);
      lines.push(`${this.name}_count${renderLabelSet(this.labelNames, labels)} ${cumulative}`);
    }
    return lines.join('\n');
  }

  reset(): void {
    this.series.clear();
  }
}

type Collector = Counter | Histogram;

class Registry {
  private collectors: Collector[] = [];

  register<T extends Collector>(collector: T): T {
    this.collectors.push(collector);
    return collector;
  }

  render(): string {
    return this.collectors.map((c) => c.render()).join('\n') + '\n';
  }

  reset(): void {
    for (const c of this.collectors) c.reset();
  }
}

export const metricsRegistry = new Registry();

// ---------------------------------------------------------------------------
// Metric definitions
// ---------------------------------------------------------------------------

/** HTTP RED triplet, recorded by server.ts for every request (except /metrics itself). */
export const httpRequestsTotal = metricsRegistry.register(
  new Counter('http_requests_total', 'Total HTTP requests by method, route template, and status code.', ['method', 'route', 'status'])
);
export const httpRequestDuration = metricsRegistry.register(
  new Histogram('http_request_duration_seconds', 'HTTP request duration in seconds by method and route template.', ['method', 'route'])
);

/**
 * Chat turns. `outcome`: completed | error | rate_limited | aborted.
 * The `model` label is the registry model name (bounded set). Recorded by the
 * chat route once per turn; TTFB only when a first token was produced.
 */
export const chatTurnsTotal = metricsRegistry.register(
  new Counter('chat_turns_total', 'Total chat turns by model and outcome.', ['model', 'outcome'])
);
export const chatTurnDuration = metricsRegistry.register(
  new Histogram('chat_turn_duration_seconds', 'Full chat turn duration (request to final SSE frame) in seconds.', ['model'])
);
export const chatTimeToFirstToken = metricsRegistry.register(
  new Histogram('chat_time_to_first_token_seconds', 'Chat time-to-first-token in seconds.', ['model'], TTFB_BUCKETS)
);

/** Retrieval / RAG queries. `outcome`: hit | empty | error. */
export const retrievalQueriesTotal = metricsRegistry.register(
  new Counter('retrieval_queries_total', 'Total retrieval queries by outcome.', ['outcome'])
);
export const retrievalQueryDuration = metricsRegistry.register(
  new Histogram('retrieval_query_duration_seconds', 'Retrieval query duration in seconds.', [])
);

/**
 * Ingestion jobs. `outcome`: enqueued | processed | failed | quarantined.
 * Duration is recorded for terminal outcomes (processed/failed/quarantined).
 */
export const ingestionJobsTotal = metricsRegistry.register(
  new Counter('ingestion_jobs_total', 'Total ingestion jobs by outcome.', ['outcome'])
);
export const ingestionJobDuration = metricsRegistry.register(
  new Histogram('ingestion_job_duration_seconds', 'Ingestion job processing duration in seconds (terminal outcomes only).', ['outcome'])
);

/** Eval runs. `outcome`: passed | failed | error. */
export const evalRunsTotal = metricsRegistry.register(
  new Counter('eval_runs_total', 'Total eval runs by outcome.', ['outcome'])
);
export const evalRunDuration = metricsRegistry.register(
  new Histogram('eval_run_duration_seconds', 'Eval run duration in seconds.', [])
);

// ---------------------------------------------------------------------------
// Record helpers — never throw.
// ---------------------------------------------------------------------------

function safe(fn: () => void): void {
  try {
    fn();
  } catch {
    // Metrics must never break a request.
  }
}

/** HTTP RED triplet. `statusClass` is the 1xx..5xx class (e.g. "2xx"). */
export function recordHttpRequest(method: string, route: string, statusClass: string, durationSeconds: number): void {
  safe(() => {
    httpRequestsTotal.inc({ method, route, status: statusClass });
    httpRequestDuration.observe({ method, route }, durationSeconds);
  });
}

export type ChatOutcome = 'completed' | 'error' | 'rate_limited' | 'aborted';

export function recordChatTurn(model: string, outcome: ChatOutcome, durationSeconds: number, timeToFirstTokenSeconds?: number): void {
  safe(() => {
    chatTurnsTotal.inc({ model, outcome });
    chatTurnDuration.observe({ model }, durationSeconds);
    if (timeToFirstTokenSeconds !== undefined) {
      chatTimeToFirstToken.observe({ model }, timeToFirstTokenSeconds);
    }
  });
}

export type RetrievalOutcome = 'hit' | 'empty' | 'error';

export function recordRetrieval(outcome: RetrievalOutcome, durationSeconds: number): void {
  safe(() => {
    retrievalQueriesTotal.inc({ outcome });
    retrievalQueryDuration.observe({}, durationSeconds);
  });
}

export type IngestionOutcome = 'enqueued' | 'processed' | 'failed' | 'quarantined';

export function recordIngestionJob(outcome: IngestionOutcome, durationSeconds?: number): void {
  safe(() => {
    ingestionJobsTotal.inc({ outcome });
    if (durationSeconds !== undefined && outcome !== 'enqueued') {
      ingestionJobDuration.observe({ outcome }, durationSeconds);
    }
  });
}

export type EvalOutcome = 'passed' | 'failed' | 'error';

export function recordEvalRun(outcome: EvalOutcome, durationSeconds: number): void {
  safe(() => {
    evalRunsTotal.inc({ outcome });
    evalRunDuration.observe({}, durationSeconds);
  });
}

/** Render the full registry in Prometheus text exposition format. */
export function renderPrometheus(): string {
  return metricsRegistry.render();
}

/** Reset every series. Tests only — never call in production code. */
export function resetMetrics(): void {
  metricsRegistry.reset();
}

/**
 * GET /metrics. No auth in dev/test; in production the endpoint is hidden
 * (404) unless METRICS_PUBLIC is explicitly enabled — production should
 * scrape it over a private network or front it with network policy / a
 * reverse-proxy auth check. See docs/scale.md.
 */
export async function metricsRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/metrics', async (_req, reply) => {
    if (!config.METRICS_PUBLIC) {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    return reply.type('text/plain; version=0.0.4').send(renderPrometheus());
  });
}
