import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
// Enable the dev-login route for this test file only.
vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return { ...actual, config: { ...actual.config, DEV_AUTH_ENABLED: true } };
});

import { authRoutes } from '../src/auth/routes.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

async function app() {
  const fastify = Fastify();
  await fastify.register(cookie);
  // High global ceiling so only the per-route bucket (10/min) can trigger.
  await fastify.register(rateLimit, { max: 1000, timeWindow: '1 minute' });
  fastify.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL' });
  });
  await fastify.register(authRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM users WHERE lower(email)')) {
      return {
        rows: [{ id: USER, email: 'dev@example.test', password_hash: 'x', display_name: 'Dev', is_active: true, clearance: 'INTERNAL' }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM memberships')) {
      return {
        rows: [{ tenant_id: TENANT, tenant_name: 'T', role_id: 'r1', role_name: 'User' }],
        rowCount: 1,
      };
    }
    if (sql.includes('FROM permissions')) return { rows: [{ name: 'chat:create' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  tenantQuery.mockResolvedValue({ rows: [], rowCount: 1 });
});

describe('POST /auth/dev-login rate limit', () => {
  it('allows 10 requests per minute, then returns 429 like /auth/login', async () => {
    const fastify = await app();
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await fastify.inject({
        method: 'POST',
        url: '/auth/dev-login',
        payload: { email: 'dev@example.test' },
      });
      statuses.push(res.statusCode);
    }
    expect(statuses.slice(0, 10)).toEqual(new Array(10).fill(200));
    expect(statuses[10]).toBe(429);
    expect(statuses[11]).toBe(429);
    await fastify.close();
  });
});
