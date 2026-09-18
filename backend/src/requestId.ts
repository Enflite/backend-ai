import { randomUUID } from 'node:crypto';
import { FastifyRequest, FastifyReply } from 'fastify';

export async function requestIdHook(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  const header = req.headers['x-request-id'];
  let requestId: string;

  if (typeof header === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(header.trim())) {
    requestId = header.trim();
  } else {
    requestId = randomUUID();
  }

  req.requestId = requestId;
  const traceparent = req.headers.traceparent;
  const traceMatch = typeof traceparent === 'string'
    ? /^00-([0-9a-f]{32})-[0-9a-f]{16}-[0-9a-f]{2}$/i.exec(traceparent)
    : null;
  req.traceId = traceMatch?.[1]?.toLowerCase() ?? randomUUID().replaceAll('-', '');
  reply.header('x-request-id', requestId);
  reply.header('x-trace-id', req.traceId);
}
