import Fastify, { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { config } from './config.js';
import { AppError, Errors } from './errors.js';
import { busyBody, retryAfterSecondsFromReply } from './ai/gateway/limits.js';
import { requestIdHook } from './requestId.js';
import { healthRoutes } from './health.js';
import { metricsRoutes, recordHttpRequest } from './observability/metrics.js';
import { authRoutes } from './auth/routes.js';
import { oidcRoutes } from './auth/oidcRoutes.js';
import { auditRoutes } from './audit/routes.js';
import { modelRoutes, modelAdminRoutes, modelArtifactRoutes } from './ai/gateway/routes.js';
import { conversationRoutes } from './conversations/routes.js';
import { chatRoutes, closeActiveSseStreams } from './chat/routes.js';
import { documentRoutes } from './documents/routes.js';
import { toolRoutes } from './tools/routes.js';
import { evalRoutes } from './eval/routes.js';
import { retentionRoutes } from './retention/routes.js';
import { startRetentionScheduler, stopRetentionScheduler } from './retention/scheduler.js';
import { recoverIngestionJobs } from './documents/queue.js';
import { pool, query } from './db/pool.js';

/**
 * Retry-After (seconds) attached to 429s from the instance-global ceiling.
 * The ceiling resets on a one-minute window, so 30s is a reasonable
 * ask-the-client-to-wait that stays under the next window.
 */
const GLOBAL_RATE_LIMIT_RETRY_AFTER_SECONDS = 30;

/**
 * Fallback Retry-After when a framework 429 arrives without the Retry-After
 * header @fastify/rate-limit normally sets (e.g. in unit tests).
 */
const DEFAULT_FRAMEWORK_429_RETRY_AFTER_SECONDS = 30;

/**
 * Custom error handler for the API server.
 *
 * - AppError: honor its status code (includes AuditPersistenceError → 503).
 * - Fastify validation errors: 400.
 * - Framework-level errors (rate limiting, payload too large) carry a numeric
 *   statusCode that is not an AppError; honor known 4xx codes (429/413) so
 *   clients see real responses instead of a misleading 500. Every 429 —
 *   framework or AppError — uses the friendly 'busy' body from
 *   ai/gateway/limits.ts plus a Retry-After header.
 * - Everything else: generic 500 that never leaks internal details.
 */
export function serverErrorHandler(error: unknown, req: FastifyRequest, reply: FastifyReply): unknown {
  const requestId = req.requestId;

  if (error instanceof AppError) {
    if (error.statusCode === 429) {
      // e.g. the instance-global ceiling: same friendly 'busy' body as every
      // other 429, so clients see one honest capacity message everywhere.
      const retryAfterSeconds = GLOBAL_RATE_LIMIT_RETRY_AFTER_SECONDS;
      return reply
        .header('Retry-After', String(retryAfterSeconds))
        .status(429)
        .send(busyBody(retryAfterSeconds));
    }
    return reply.status(error.statusCode).send({
      error: {
        code: error.code,
        message: error instanceof Error ? error.message : 'Request validation failed',
        requestId,
        details: error.details,
      },
    });
  }

  if ((error as { validation?: unknown } | null)?.validation) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_ERROR',
        message: error instanceof Error ? error.message : 'Request validation failed',
        requestId,
        details: (error as { validation?: unknown }).validation,
      },
    });
  }

  const statusCode =
    typeof (error as { statusCode?: unknown } | null)?.statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : undefined;
  if (statusCode === 429) {
    // Rate limiting is capacity signaling, not a client fault: every 429 —
    // from @fastify/rate-limit's per-route buckets or the concurrency caps —
    // speaks the same friendly 'busy' body. The plugin already set
    // Retry-After on the reply before throwing; reuse it so the body and the
    // header agree.
    const retryAfterSeconds = retryAfterSecondsFromReply(reply, DEFAULT_FRAMEWORK_429_RETRY_AFTER_SECONDS);
    return reply
      .header('Retry-After', String(retryAfterSeconds))
      .status(429)
      .send(busyBody(retryAfterSeconds));
  }
  if (statusCode === 413) {
    return reply.status(statusCode).send({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Payload too large',
        requestId,
      },
    });
  }

  req.log.error(error);
  return reply.status(500).send({
    error: {
      code: 'INTERNAL',
      message: 'Internal server error',
      requestId,
    },
  });
}

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: config.NODE_ENV === 'production' ? ['127.0.0.1', '::1'] : true,
    bodyLimit: 1048576, // 1MB
  });

  // Request ID
  fastify.addHook('onRequest', requestIdHook);
  // Trace correlation: rebind the per-request logger with requestId/traceId
  // so every log line emitted through req.log — routes, gateway, providers,
  // tool calls — carries both fields. See docs/scale.md.
  fastify.addHook('onRequest', async (req) => {
    req.log = req.log.child({ requestId: req.requestId, traceId: req.traceId });
  });
  fastify.addHook('onResponse', async (req, reply) => {
    req.log.info({
      requestId: req.requestId,
      traceId: req.traceId,
      tenantId: req.auth?.tenantId,
      userId: req.auth?.userId,
      route: req.routeOptions.url,
      statusCode: reply.statusCode,
      latencyMs: reply.elapsedTime,
    }, 'request completed');
    // HTTP RED triplet for /metrics. The scrape endpoint itself is excluded
    // so Prometheus polling does not pollute the request-rate series.
    const route = req.routeOptions.url ?? 'unmatched';
    if (route !== '/metrics') {
      recordHttpRequest(
        req.method,
        route,
        `${Math.floor(reply.statusCode / 100)}xx`,
        reply.elapsedTime / 1000
      );
    }
  });

  await fastify.register(helmet);

  await fastify.register(cookie);

  // CORS is explicit; credentials are never accepted from arbitrary origins.
  await fastify.register(cors, {
    origin: config.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
    credentials: true,
    exposedHeaders: ['x-request-id', 'x-trace-id'],
  });

  await fastify.register(multipart, {
    limits: { files: 1, fileSize: config.MAX_UPLOAD_BYTES, fields: 10 },
  });

  // Rate limiting is keyed by the opaque session token when present, otherwise IP.
  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization
      ? createHash('sha256').update(req.headers.authorization).digest('hex')
      : req.ip,
  });

  // Instance-level global ceiling beneath the per-user buckets: one compromised
  // account must not be able to sustain its full per-user quota of expensive
  // requests regardless of overall load. In-memory per instance; multi-instance
  // deployments should front this with a shared limiter (see deployment docs).
  const GLOBAL_MAX_PER_MINUTE = 3000;
  let windowStart = Date.now();
  let windowCount = 0;
  fastify.addHook('onRequest', async () => {
    const now = Date.now();
    if (now - windowStart >= 60000) {
      windowStart = now;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > GLOBAL_MAX_PER_MINUTE) {
      throw Errors.tooMany('GLOBAL_RATE_LIMITED', 'Server is handling too many requests');
    }
  });

  // Custom Error Handler (extracted as a named export so its status-code
  // mapping is unit-testable without booting the whole server).
  fastify.setErrorHandler(serverErrorHandler);

  // Register API routes under /api/v1
  await fastify.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(oidcRoutes);
      await api.register(auditRoutes);
      await api.register(modelRoutes);
      await api.register(modelAdminRoutes);
      await api.register(modelArtifactRoutes);
      await api.register(conversationRoutes);
      await api.register(chatRoutes);
      await api.register(documentRoutes);
      await api.register(toolRoutes);
      await api.register(evalRoutes);
      await api.register(retentionRoutes);
    },
    { prefix: '/api/v1' }
  );

  // Retention purge scheduler (Phase 5c): in-process, every
  // RETENTION_PURGE_INTERVAL_HOURS. Started here so it runs in every
  // serving process; stopped on preClose. The timer is unref'd and runs
  // never overlap.
  startRetentionScheduler();

  // Root health endpoints
  await fastify.register(healthRoutes);
  // Prometheus exposition (gated by METRICS_PUBLIC; see observability/metrics.ts)
  await fastify.register(metricsRoutes);

  // Hijacked SSE responses are invisible to server.close(): end them
  // explicitly so a client holding a stream open cannot stall shutdown.
  fastify.addHook('preClose', async () => {
    closeActiveSseStreams();
    stopRetentionScheduler();
  });

  return fastify;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const server = await buildServer();
  // Graceful shutdown: stop accepting connections, let in-flight requests
  // (including SSE streams and ingestion callbacks) finish, then drain the DB
  // pool. The drain is bounded: if it does not complete within
  // SHUTDOWN_DRAIN_MS, remaining connections are force-closed so a stuck
  // client cannot delay shutdown past the platform's SIGKILL. SIGKILL remains
  // the last resort via container orchestration.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`Received ${signal}; shutting down gracefully...`);
    const drainMs = Number.parseInt(process.env.SHUTDOWN_DRAIN_MS ?? '15000', 10);
    let drainTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        server.close(),
        new Promise<void>((resolve) => {
          drainTimer = setTimeout(() => {
            server.log.warn(
              { drainMs },
              'Shutdown drain timed out; force-closing remaining connections'
            );
            try {
              (server.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
            } catch (error) {
              server.log.error({ err: error }, 'Error force-closing connections during shutdown');
            }
            resolve();
          }, Number.isSafeInteger(drainMs) && drainMs > 0 ? drainMs : 15000);
          drainTimer.unref?.();
        }),
      ]);
    } catch (error) {
      server.log.error({ err: error }, 'Error during server close');
    } finally {
      if (drainTimer) clearTimeout(drainTimer);
    }
    await pool.end().catch((error) => server.log.error({ err: error }, 'Error draining database pool'));
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));
  try {
    if (config.NODE_ENV === 'production') {
      // Defense in depth: PostgreSQL superusers and BYPASSRLS roles bypass
      // row-level security entirely (even FORCE ROW LEVEL SECURITY, applied
      // by migration 013 so table owners stay subject to the tenant
      // policies), which would silently disable tenant isolation. Refuse to
      // serve production on such a role.
      const role = (
        await query<{ rolsuper: boolean; rolbypassrl: boolean }>(
          'SELECT rolsuper, rolbypassrl FROM pg_roles WHERE rolname = current_user'
        )
      ).rows[0];
      if (!role || role.rolsuper || role.rolbypassrl) {
        console.error(
          'Configuration error: production DATABASE_URL must use a non-superuser role without BYPASSRLS, otherwise RLS tenant isolation is bypassed'
        );
        process.exit(1);
      }
    }
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    await recoverIngestionJobs();
    console.log(`Server listening on 0.0.0.0:${config.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
