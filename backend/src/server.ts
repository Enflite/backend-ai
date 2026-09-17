import Fastify, { FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { config } from './config.js';
import { AppError } from './errors.js';
import { requestIdHook } from './requestId.js';
import { healthRoutes } from './health.js';
import { authRoutes } from './auth/routes.js';
import { auditRoutes } from './audit/routes.js';
import { modelRoutes } from './ai/gateway/routes.js';
import { conversationRoutes } from './conversations/routes.js';
import { chatRoutes } from './chat/routes.js';

export async function buildServer(): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === 'test' ? 'silent' : 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie'],
    },
    trustProxy: true,
    bodyLimit: 1048576, // 1MB
  });

  // Request ID
  fastify.addHook('onRequest', requestIdHook);

  // Security Headers (CSP off since frontend is separate)
  await fastify.register(helmet, {
    contentSecurityPolicy: false,
  });

  // CORS
  await fastify.register(cors, {
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  // Rate Limiting (300/min keyed by userId or IP)
  await fastify.register(rateLimit, {
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.auth?.userId ?? req.ip,
  });

  // Custom Error Handler
  fastify.setErrorHandler((error, req, reply) => {
    const requestId = req.requestId;

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId,
          details: error.details,
        },
      });
    }

    if ((error as any).validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: error.message,
          requestId,
          details: (error as any).validation,
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
  });

  // Register API routes under /api/v1
  await fastify.register(
    async (api) => {
      await api.register(healthRoutes);
      await api.register(authRoutes);
      await api.register(auditRoutes);
      await api.register(modelRoutes);
      await api.register(conversationRoutes);
      await api.register(chatRoutes);
    },
    { prefix: '/api/v1' }
  );

  // Root health endpoints
  await fastify.register(healthRoutes);

  return fastify;
}

const __filename = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  const server = await buildServer();
  try {
    await server.listen({ port: config.PORT, host: '0.0.0.0' });
    console.log(`Server listening on 0.0.0.0:${config.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}
