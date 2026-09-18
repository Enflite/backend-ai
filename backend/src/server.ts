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
import { requestIdHook } from './requestId.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './auth/routes.js';
import { auditRoutes } from './audit/routes.js';
import { modelRoutes } from './ai/gateway/routes.js';
import { conversationRoutes } from './conversations/routes.js';
import { chatRoutes, closeActiveSseStreams } from './chat/routes.js';
import { documentRoutes } from './documents/routes.js';
import { toolRoutes } from './tools/routes.js';
import { recoverIngestionJobs } from './documents/queue.js';
import { pool, query } from './db/pool.js';

/**
 * Custom error handler for the API server.
 *
 * - AppError: honor its status code (includes AuditPersistenceError → 503).
 * - Fastify validation errors: 400.
 * - Framework-level errors (rate limiting, payload too large) carry a numeric
 *   statusCode that is not an AppError; honor known 4xx codes (429/413) so
 *   clients see real responses instead of a misleading 500.
 * - Everything else: generic 500 that never leaks internal details.
 */
export function serverErrorHandler(error: unknown, req: FastifyRequest, reply: FastifyReply): unknown {
  const requestId = req.requestId;

  if (error instanceof AppError) {
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
  if (statusCode === 429 || statusCode === 413) {
    return reply.status(statusCode).send({
      error: {
        code: statusCode === 429 ? 'RATE_LIMITED' : 'PAYLOAD_TOO_LARGE',
        message: statusCode === 429 ? 'Too many requests' : 'Payload too large',
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
      await api.register(auditRoutes);
      await api.register(modelRoutes);
      await api.register(conversationRoutes);
      await api.register(chatRoutes);
      await api.register(documentRoutes);
      await api.register(toolRoutes);
    },
    { prefix: '/api/v1' }
  );

  // Root health endpoints
  await fastify.register(healthRoutes);

  // Hijacked SSE responses are invisible to server.close(): end them
  // explicitly so a client holding a stream open cannot stall shutdown.
  fastify.addHook('preClose', async () => {
    closeActiveSseStreams();
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
