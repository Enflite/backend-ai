import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { Errors, AppError } from '../errors.js';
import { requireAuth } from '../auth/middleware.js';
import { requirePermission } from '../authz/middleware.js';
import { gatewayStream } from '../ai/gateway/gateway.js';

const chatBodySchema = z.object({
  conversationId: z.string().uuid().optional(),
  content: z.string().min(1).max(32000),
  model: z.string().optional(),
});

export async function chatRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/chat',
    {
      preHandler: [requireAuth, requirePermission('chat:create')],
    },
    async (req, reply) => {
      const auth = req.auth!;
      const parsed = chatBodySchema.safeParse(req.body);
      if (!parsed.success) {
        throw Errors.badRequest('INVALID_REQUEST', 'Invalid chat request body', parsed.error.format());
      }

      let conversationId = parsed.data.conversationId;
      let chosenModel = parsed.data.model ?? config.VLLM_MODEL;

      if (conversationId) {
        const convRes = await query<{ id: string; model: string }>(
          'SELECT id, model FROM conversations WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
          [conversationId, auth.tenantId, auth.userId]
        );
        if (convRes.rows.length === 0) {
          throw Errors.notFound('CONVERSATION_NOT_FOUND', 'Conversation not found');
        }
        if (!parsed.data.model && convRes.rows[0]?.model) {
          chosenModel = convRes.rows[0].model;
        }
      } else {
        const title = parsed.data.content.slice(0, 50).trim() || 'New Conversation';
        const createRes = await query<{ id: string }>(
          `INSERT INTO conversations (tenant_id, user_id, title, model)
           VALUES ($1, $2, $3, $4)
           RETURNING id`,
          [auth.tenantId, auth.userId, title, chosenModel]
        );
        conversationId = createRes.rows[0]!.id;
      }

      // Load prior history (last 50 messages, roles user/assistant/system only)
      const historyRes = await query<{ role: 'user' | 'assistant' | 'system'; content: string }>(
        `SELECT role, content
         FROM messages
         WHERE conversation_id = $1 AND tenant_id = $2 AND role IN ('user', 'assistant', 'system')
         ORDER BY created_at DESC
         LIMIT 50`,
        [conversationId, auth.tenantId]
      );
      const history = historyRes.rows.reverse();

      // Persist user message BEFORE streaming
      await query(
        `INSERT INTO messages (conversation_id, tenant_id, role, content, model)
         VALUES ($1, $2, 'user', $3, $4)`,
        [conversationId, auth.tenantId, parsed.data.content, chosenModel]
      );
      history.push({ role: 'user', content: parsed.data.content });

      // Prepare SSE streaming response
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.setHeader('x-request-id', req.requestId);
      reply.raw.flushHeaders();

      function sendSSE(event: string, data: unknown): void {
        if (reply.raw.writable && !reply.raw.writableEnded) {
          reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        }
      }

      const abortController = new AbortController();
      req.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          abortController.abort();
        }
      });

      sendSSE('meta', { conversationId, model: chosenModel });

      let assembledContent = '';
      const finishReason = 'stop';

      try {
        const stream = gatewayStream({
          tenantId: auth.tenantId,
          userId: auth.userId,
          requestId: req.requestId,
          modelName: chosenModel,
          messages: history,
          signal: abortController.signal,
        });

        for await (const chunk of stream) {
          assembledContent += chunk;
          sendSSE('delta', { content: chunk });
        }

        sendSSE('done', { finishReason });
      } catch (err: unknown) {
        const code = err instanceof AppError ? err.code : 'STREAM_ERROR';
        const message = err instanceof Error ? err.message : 'Stream error';
        sendSSE('error', { code, message, requestId: req.requestId });
      } finally {
        if (assembledContent.length > 0) {
          try {
            await query(
              `INSERT INTO messages (conversation_id, tenant_id, role, content, model)
               VALUES ($1, $2, 'assistant', $3, $4)`,
              [conversationId, auth.tenantId, assembledContent, chosenModel]
            );
            await query(
              'UPDATE conversations SET updated_at = NOW() WHERE id = $1',
              [conversationId]
            );
          } catch (dbErr) {
            req.log.error(dbErr, 'Failed to persist assistant message');
          }
        }
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      }
    }
  );
}
