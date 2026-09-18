/**
 * Phase 4c observability tests: the in-memory metrics registry, the
 * Prometheus exposition format, the /metrics route gate, trace helpers, and
 * the extended /ready dependency checks.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';

// The DB pool is stubbed per test: readiness is about check logic and HTTP
// mapping, not about a live database.
const { poolQuery, poolConnect, clientRelease } = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  poolConnect: vi.fn(),
  clientRelease: vi.fn(),
}));
vi.mock('../src/db/pool.js', () => ({ query: poolQuery, pool: { connect: poolConnect } }));

import { config } from '../src/config.js';
import {
  metricsRoutes,
  recordHttpRequest,
  recordChatTurn,
  recordRetrieval,
  recordIngestionJob,
  recordEvalRun,
  renderPrometheus,
  resetMetrics,
} from '../src/observability/metrics.js';
import { correlationFields, buildTraceparent, hasTraceContext } from '../src/observability/traces.js';
import { healthRoutes, runReadinessChecks } from '../src/health.js';

afterEach(() => {
  resetMetrics();
});

beforeEach(() => {
  poolQuery.mockReset();
  poolQuery.mockResolvedValue({ rows: [{ '?column?': 1 }] });
  poolConnect.mockReset();
  clientRelease.mockReset();
  // The readiness database check uses a dedicated pooled client (bounded
  // server-side via statement_timeout); stub connect() to hand it the
  // stubbed query fn.
  poolConnect.mockResolvedValue({ query: poolQuery, release: clientRelease });
});

describe('metrics registry', () => {
  it('renders counters with labels in Prometheus text format', () => {
    recordHttpRequest('GET', '/api/v1/chat', '2xx', 0.12);
    recordHttpRequest('GET', '/api/v1/chat', '2xx', 0.2);
    recordHttpRequest('POST', '/api/v1/chat', '5xx', 1.5);
    const out = renderPrometheus();
    expect(out).toContain('# HELP http_requests_total');
    expect(out).toContain('# TYPE http_requests_total counter');
    expect(out).toContain('http_requests_total{method="GET",route="/api/v1/chat",status="2xx"} 2');
    expect(out).toContain('http_requests_total{method="POST",route="/api/v1/chat",status="5xx"} 1');
  });

  it('renders histograms with cumulative buckets, sum, and count', () => {
    recordChatTurn('mock-model', 'completed', 1.2, 0.3);
    recordChatTurn('mock-model', 'completed', 0.4, 0.15);
    const out = renderPrometheus();
    expect(out).toContain('# TYPE chat_turn_duration_seconds histogram');
    // Both observations fall in le="2.5" and below; cumulative bucket counts.
    expect(out).toContain('chat_turn_duration_seconds_bucket{model="mock-model",le="2.5"} 2');
    expect(out).toContain('chat_turn_duration_seconds_bucket{model="mock-model",le="+Inf"} 2');
    expect(out).toContain('chat_turn_duration_seconds_count{model="mock-model"} 2');
    expect(out).toMatch(/chat_turn_duration_seconds_sum\{model="mock-model"\} 1\.6/);
    // TTFB uses the low-skew bucket set.
    expect(out).toContain('chat_time_to_first_token_seconds_bucket{model="mock-model",le="0.5"} 2');
  });

  it('covers retrieval, ingestion, and eval series', () => {
    recordRetrieval('hit', 0.05);
    recordRetrieval('empty', 0.04);
    recordIngestionJob('enqueued');
    recordIngestionJob('processed', 12.5);
    recordIngestionJob('quarantined', 3.0);
    recordEvalRun('passed', 60);
    const out = renderPrometheus();
    expect(out).toContain('retrieval_queries_total{outcome="hit"} 1');
    expect(out).toContain('retrieval_queries_total{outcome="empty"} 1');
    expect(out).toContain('ingestion_jobs_total{outcome="enqueued"} 1');
    expect(out).toContain('ingestion_jobs_total{outcome="processed"} 1');
    expect(out).toContain('ingestion_jobs_total{outcome="quarantined"} 1');
    expect(out).toContain('eval_runs_total{outcome="passed"} 1');
    expect(out).toContain('ingestion_job_duration_seconds_count{outcome="processed"} 1');
    // Enqueued jobs carry no duration.
    expect(out).not.toContain('ingestion_job_duration_seconds_count{outcome="enqueued"}');
  });

  it('sanitizes label values and never throws on bad input', () => {
    expect(() =>
      recordHttpRequest('GET', '/x"y\\z\n', '2xx', Number.NaN)
    ).not.toThrow();
    const out = renderPrometheus();
    expect(out).toContain('route="/x\\"y\\\\z\\n"');
  });

  it('resetMetrics clears all series', () => {
    recordHttpRequest('GET', '/a', '2xx', 0.1);
    resetMetrics();
    expect(renderPrometheus()).not.toContain('http_requests_total{');
  });
});

describe('GET /metrics', () => {
  it('exposes Prometheus text when METRICS_PUBLIC is true', async () => {
    const app = Fastify();
    await app.register(metricsRoutes);
    recordHttpRequest('GET', '/health', '2xx', 0.001);
    const res = await app.inject({ method: 'GET', url: '/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.body).toContain('http_requests_total{method="GET",route="/health",status="2xx"} 1');
    await app.close();
  });

  it('returns 404 when METRICS_PUBLIC is false', async () => {
    const previous = config.METRICS_PUBLIC;
    config.METRICS_PUBLIC = false;
    try {
      const app = Fastify();
      await app.register(metricsRoutes);
      const res = await app.inject({ method: 'GET', url: '/metrics' });
      expect(res.statusCode).toBe(404);
      await app.close();
    } finally {
      config.METRICS_PUBLIC = previous;
    }
  });
});

describe('trace helpers', () => {
  it('correlationFields picks requestId and traceId', () => {
    expect(correlationFields({ requestId: 'r1', traceId: 't1' })).toEqual({ requestId: 'r1', traceId: 't1' });
    expect(correlationFields({})).toEqual({});
  });

  it('buildTraceparent emits a valid W3C traceparent', () => {
    const traceId = 'a'.repeat(32);
    const header = buildTraceparent(traceId, 'b'.repeat(16));
    expect(header).toBe(`00-${traceId}-${'b'.repeat(16)}-01`);
    expect(buildTraceparent(traceId)).toMatch(/^00-a{32}-[0-9a-f]{16}-01$/);
  });

  it('hasTraceContext detects requests past requestIdHook', () => {
    expect(hasTraceContext({ requestId: 'r', traceId: 't' } as never)).toBe(true);
    expect(hasTraceContext({} as never)).toBe(false);
  });
});

describe('/ready dependency checks', () => {
  it('reports ok when the database answers and optional deps are unconfigured', async () => {
    const report = await runReadinessChecks();
    expect(report.status).toBe('ok');
    expect(report.checks.database.status).toBe('ok');
    expect(report.checks.database.critical).toBe(true);
    expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
    // No OBJECT_STORAGE_ENDPOINT / EMBEDDING_BASE_URL in the test env.
    expect(report.checks.objectStorage.status).toBe('not_configured');
    expect(report.checks.objectStorage.critical).toBe(false);
    expect(report.checks.embeddings.status).toBe('not_configured');
    expect(report.checks.embeddings.critical).toBe(false);
  });

  it('marks the report degraded when a critical dependency is down', async () => {
    poolQuery.mockRejectedValue(new Error('connection refused'));
    const report = await runReadinessChecks();
    expect(report.status).toBe('degraded');
    expect(report.checks.database.status).toBe('unavailable');
    expect(report.checks.database.critical).toBe(true);
    expect(report.checks.database.detail).toContain('connection refused');
  });

  it('GET /ready returns 200 with per-dependency status when healthy', async () => {
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.checks.database.status).toBe('ok');
    expect(body.checks.objectStorage).toBeDefined();
    expect(body.checks.embeddings).toBeDefined();
    await app.close();
  });

  it('GET /ready returns 503 when a critical dependency is down', async () => {
    poolQuery.mockRejectedValue(new Error('connection refused'));
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json().status).toBe('degraded');
    await app.close();
  });

  it('GET /ready never exposes raw dependency errors publicly', async () => {
    // The probe is unauthenticated: connection strings and SDK internals in
    // raw error messages must stay server-side (logged), not in the body.
    poolQuery.mockRejectedValue(new Error('connect postgres://db.internal:5432 refused'));
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.checks.database.status).toBe('unavailable');
    expect(body.checks.database.detail).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('db.internal');
    await app.close();
  });

  it('GET /ready reports degraded rather than 500ing when the pool is exhausted', async () => {
    poolConnect.mockRejectedValueOnce(new Error('pool exhausted'));
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.status).toBe('degraded');
    expect(body.checks.database.status).toBe('unavailable');
    expect(body.checks.database.detail).toBeUndefined();
    await app.close();
  });

  it('GET /health stays a cheap liveness probe', async () => {
    const app = Fastify();
    await app.register(healthRoutes);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});
