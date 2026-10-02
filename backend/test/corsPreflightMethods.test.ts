/**
 * corsPreflightMethods.test.ts — regression test for chat delete/rename
 * dying in the browser with "CORS error" / "Failed to fetch".
 *
 * The @fastify/cors default methods (GET,HEAD,POST) omit DELETE and PATCH,
 * so the preflight for DELETE /api/v1/conversations/:id (chat delete) and
 * PATCH (chat rename) returned an allow-methods list without them and the
 * browser blocked the request even though the preflight itself was 204.
 * server.ts must pin the full method list explicitly.
 */
import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

const CONVERSATION_URL = '/api/v1/conversations/11111111-1111-4111-8111-111111111111';

async function preflight(requestMethod: string) {
  const app = await buildServer();
  try {
    return await app.inject({
      method: 'OPTIONS',
      url: CONVERSATION_URL,
      headers: {
        // Default CORS_ORIGIN (dev frontend).
        origin: 'http://localhost:8443',
        'access-control-request-method': requestMethod,
      },
    });
  } finally {
    await app.close();
  }
}

describe('CORS preflight allowed methods', () => {
  it('advertises DELETE so chat delete passes the browser preflight', async () => {
    const res = await preflight('DELETE');
    expect(res.statusCode).toBe(204);
    const methods = String(res.headers['access-control-allow-methods'] ?? '')
      .split(',')
      .map((method) => method.trim());
    for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS']) {
      expect(methods).toContain(method);
    }
  });

  it('advertises PATCH so chat rename passes the browser preflight', async () => {
    const res = await preflight('PATCH');
    expect(res.statusCode).toBe(204);
    const methods = String(res.headers['access-control-allow-methods'] ?? '')
      .split(',')
      .map((method) => method.trim());
    expect(methods).toContain('PATCH');
  });
});
