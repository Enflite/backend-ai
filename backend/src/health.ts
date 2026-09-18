import { FastifyInstance } from 'fastify';
import { query } from './db/pool.js';
import { config } from './config.js';
import { s3Storage } from './storage/storage.js';

export type DependencyStatus = 'ok' | 'degraded' | 'unavailable' | 'not_configured';

export interface DependencyCheck {
  /** ok | degraded | unavailable | not_configured (dependency not set up). */
  status: DependencyStatus;
  /** True when this dependency gates readiness: a non-ok critical check → 503. */
  critical: boolean;
  latencyMs?: number;
  detail?: string;
}

export interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: {
    database: DependencyCheck;
    objectStorage: DependencyCheck;
    embeddings: DependencyCheck;
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

async function checkDatabase(): Promise<DependencyCheck> {
  const started = Date.now();
  try {
    await withTimeout(query('SELECT 1'), config.READY_CHECK_TIMEOUT_MS, 'database check');
    return { status: 'ok', critical: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'unavailable',
      critical: true,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

async function checkObjectStorage(): Promise<DependencyCheck> {
  // Object storage is only configured where documents are used. An unconfigured
  // endpoint is a deliberate dev state, not an outage — document features are
  // disabled and readiness stays green. A configured-but-unreachable endpoint
  // is critical: uploads and retrieval would fail.
  if (!config.OBJECT_STORAGE_ENDPOINT) {
    return { status: 'not_configured', critical: false };
  }
  const started = Date.now();
  try {
    // exists() performs a HeadObject round-trip; a 404 on the probe key still
    // proves reachability, so any boolean result means the service is up.
    await withTimeout(s3Storage.exists('__readiness_probe__'), config.READY_CHECK_TIMEOUT_MS, 'object storage check');
    return { status: 'ok', critical: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'unavailable',
      critical: true,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

async function checkEmbeddings(): Promise<DependencyCheck> {
  // Embeddings power ingestion and RAG. A ping failure degrades those paths
  // but chat keeps working, so this check is non-critical: it surfaces as
  // `degraded` while /ready stays 200.
  if (!config.EMBEDDING_BASE_URL) {
    return { status: 'not_configured', critical: false };
  }
  const started = Date.now();
  const base = config.EMBEDDING_BASE_URL.replace(/\/$/, '');
  // Cheap, token-free pings: vLLM/OpenAI-compatible servers expose
  // GET /v1/models; Ollama answers GET /api/tags.
  const pingUrl = config.EMBEDDING_PROVIDER === 'ollama' ? `${base}/api/tags` : `${base}/v1/models`;
  try {
    const response = await fetch(pingUrl, {
      signal: AbortSignal.timeout(config.READY_CHECK_TIMEOUT_MS),
      headers: config.EMBEDDING_API_KEY ? { authorization: `Bearer ${config.EMBEDDING_API_KEY}` } : {},
    });
    // Any completed HTTP response proves the service is reachable, even a
    // 401/404 from a path the provider does not implement.
    return { status: 'ok', critical: false, latencyMs: Date.now() - started, detail: `http ${response.status}` };
  } catch (error) {
    return {
      status: 'unavailable',
      critical: false,
      latencyMs: Date.now() - started,
      detail: error instanceof Error ? error.message : 'unknown error',
    };
  }
}

/**
 * Run every readiness check with per-check timeouts. Exported so tests can
 * assert the report shape without booting the server.
 */
export async function runReadinessChecks(): Promise<ReadinessReport> {
  const [database, objectStorage, embeddings] = await Promise.all([
    checkDatabase(),
    checkObjectStorage(),
    checkEmbeddings(),
  ]);
  const checks = { database, objectStorage, embeddings };
  const criticalDown = Object.values(checks).some((check) => check.critical && check.status !== 'ok');
  return { status: criticalDown ? 'degraded' : 'ok', checks };
}

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  // Liveness: deliberately cheap and dependency-free. Orchestrators and load
  // balancers hit this at high frequency; it must never block on a database
  // or network call.
  fastify.get('/health', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  // Readiness: per-dependency status with timeouts. 200 only when every
  // critical dependency is reachable; 503 when a critical one is down.
  // Non-critical degradations (embeddings, unconfigured storage) are reported
  // in the body but do not fail the probe.
  fastify.get('/ready', async (_req, reply) => {
    const report = await runReadinessChecks();
    return reply.status(report.status === 'ok' ? 200 : 503).send(report);
  });
}
