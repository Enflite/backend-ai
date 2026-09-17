import { FastifyInstance } from 'fastify';
import { query } from './db/pool.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/health', async (_req, reply) => {
    return reply.status(200).send({ status: 'ok' });
  });

  fastify.get('/ready', async (_req, reply) => {
    try {
      await query('SELECT 1');
      return reply.status(200).send({ status: 'ok', database: 'available' });
    } catch {
      return reply.status(503).send({ database: 'unavailable' });
    }
  });
}
