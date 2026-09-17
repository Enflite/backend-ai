import { randomUUID } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';

export async function requestIdHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers['x-request-id'];
  let requestId: string;

  if (typeof header === 'string' && header.trim().length > 0 && header.length <= 128) {
    requestId = header.trim();
  } else {
    requestId = randomUUID();
  }

  req.requestId = requestId;
  reply.header('x-request-id', requestId);
}
