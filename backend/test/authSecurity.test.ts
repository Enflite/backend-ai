import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
const { testAuth } = vi.hoisted(() => ({
  testAuth: {
    userId: '11111111-1111-4111-8111-111111111111',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'user@example.test',
    displayName: 'User',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['chat:create'],
  },
}));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/identityProvider.js', () => ({ identityProvider: { authenticate } }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = testAuth;
    done();
  },
}));

import { authRoutes } from '../src/auth/routes.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';

async function app() {
  const fastify = Fastify();
  await fastify.register(cookie);
  // Auth routes install their own error handler expectations; keep default.
  fastify.setErrorHandler((error: any, _req, reply) => {
    const status = error.statusCode ?? 500;
    reply.status(status).send({ code: error.code ?? 'INTERNAL', message: error.message });
  });
  await fastify.register(authRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
  query.mockResolvedValue({ rows: [], rowCount: 0 });
  tenantQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  authenticate.mockResolvedValue(null);
});

describe('login lockout', () => {
  it('returns generic 401 for a locked account (no account-enumeration signal)', async () => {
    query.mockImplementation(async (_sql: string) => ({
      rows: [{ id: USER, failed_login_attempts: 5, locked_until: new Date(Date.now() + 60000).toISOString() }],
      rowCount: 1,
    }));
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
    // The lock is still recorded server-side for operators.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'AUTHENTICATION_FAILURE',
      success: false,
      reason: 'ACCOUNT_LOCKED',
      userId: USER,
    }));
    await fastify.close();
  });

  it('increments failures with a single atomic UPDATE on bad password', async () => {
    const seen: string[] = [];
    query.mockImplementation(async (sql: string) => {
      seen.push(sql);
      if (sql.startsWith('SELECT id, failed_login_attempts')) {
        return { rows: [{ id: USER, failed_login_attempts: 4, locked_until: null }], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE users')) {
        return { rows: [{ failed_login_attempts: 5, locked_until: new Date(Date.now() + 300000).toISOString() }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'user@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    const update = seen.find((sql) => sql.startsWith('UPDATE users'))!;
    // Read-modify-write happens inside the database, not in Node.
    expect(update).toContain('failed_login_attempts = failed_login_attempts + 1');
    expect(update).toContain('RETURNING failed_login_attempts');
    // The 5th failure escalates to a lockout audit.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      reason: 'ACCOUNT_LOCKED',
      metadata: { failedAttempts: 5 },
    }));
    await fastify.close();
  });

  it('gives unknown emails the same 401 without lockout bookkeeping', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@example.test', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_CREDENTIALS');
    expect(query.mock.calls.some(([sql]: any[]) => (sql as string).startsWith('UPDATE users'))).toBe(false);
    await fastify.close();
  });
});

describe('refresh-token reuse', () => {
  const cookieHeader = `enflite_refresh=${TENANT}.secrettoken`;

  it('revokes all sessions and audits when a superseded token is presented', async () => {
    tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
      if (sql.includes('FROM sessions s JOIN users u')) return { rows: [], rowCount: 0 };
      if (sql.includes('previous_refresh_token_hashes')) {
        return { rows: [{ id: 'sess-old', user_id: USER }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('REFRESH_TOKEN_REUSED');
    const revoke = tenantQuery.mock.calls.find(([, sql]: any[]) =>
      (sql as string).includes('SET revoked_at = NOW()') && (sql as string).includes('user_id = $2'));
    expect(revoke).toBeDefined();
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'SECURITY_REFRESH_TOKEN_REUSED',
      userId: USER,
    }));
    await fastify.close();
  });

  it('routes a lost rotation race through reuse detection instead of a 500', async () => {
    tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
      if (sql.includes('FROM sessions s JOIN users u')) {
        return {
          rows: [{ id: USER, session_id: 'sess-1', tenant_id: TENANT, tenant_name: 'T', role_id: 'r1', role_name: 'User', is_active: true, clearance: 'INTERNAL' }],
          rowCount: 1,
        };
      }
      // Simulate losing the concurrent-rotation race: the conditional UPDATE
      // matches zero rows because the winner already rotated.
      if (sql.includes('SET refresh_token_hash = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('previous_refresh_token_hashes')) {
        return { rows: [{ id: 'sess-1', user_id: USER }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM permissions')) return { rows: [{ name: 'chat:create' }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('REFRESH_TOKEN_REUSED');
    await fastify.close();
  });

  it('returns 401 INVALID_REFRESH_TOKEN for an unknown token', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/auth/refresh',
      headers: { cookie: cookieHeader },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
    await fastify.close();
  });
});

describe('session inventory', () => {
  it('lists sessions via GET /auth/sessions', async () => {
    tenantQuery.mockResolvedValue({
      rows: [{ id: '33333333-3333-4333-8333-333333333333', revoked: false }],
      rowCount: 1,
    });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/auth/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json().sessions[0]).toMatchObject({ current: true });
    await fastify.close();
  });

  it('revokes every session via POST /auth/logout/all', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/logout/all' });
    expect(res.statusCode).toBe(200);
    const revokeAll = tenantQuery.mock.calls.find(([, sql]: any[]) =>
      (sql as string).includes('SET revoked_at = NOW()') && (sql as string).includes('user_id = $2'));
    expect(revokeAll?.[2]).toEqual([TENANT, USER]);
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'LOGOUT_ALL' }));
    await fastify.close();
  });
});
