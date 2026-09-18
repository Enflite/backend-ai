import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';

const { query, tenantQuery } = vi.hoisted(() => ({ query: vi.fn(), tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { signToken, verifyToken } = vi.hoisted(() => ({ signToken: vi.fn(), verifyToken: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ query, tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/jwt.js', () => ({ signToken, verifyToken }));

import { authRoutes } from '../src/auth/routes.js';
import { InvalidRefreshSessionError, rotateRefreshToken } from '../src/auth/sessions.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const USER = '11111111-1111-4111-8111-111111111111';
const cookieHeader = `enflite_refresh=${TENANT}.secrettoken`;

const sessionRow = {
  id: USER, session_id: 'sess-1', tenant_id: TENANT, tenant_name: 'T',
  role_id: 'r1', role_name: 'User', is_active: true, clearance: 'INTERNAL',
};

async function app() {
  const fastify = Fastify();
  await fastify.register(cookie);
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
  signToken.mockResolvedValue('signed-access-token');
  query.mockImplementation(async (sql: string) => {
    if (sql.includes('FROM permissions')) return { rows: [{ name: 'chat:create' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
    if (sql.includes('FROM sessions s JOIN users u')) return { rows: [sessionRow], rowCount: 1 };
    // Rotation UPDATE succeeds by default.
    if (sql.includes('SET refresh_token_hash = $1')) return { rows: [{ id: 'sess-1' }], rowCount: 1 };
    if (sql.includes('previous_refresh_token_hashes')) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 1 };
  });
});

describe('rotateRefreshToken error classification', () => {
  it('throws InvalidRefreshSessionError when the conditional UPDATE loses the race', async () => {
    tenantQuery.mockImplementation(async () => ({ rows: [], rowCount: 0 }));
    await expect(
      rotateRefreshToken(`${TENANT}.old`, { userId: USER, tenantId: TENANT } as any, 'sess-1')
    ).rejects.toBeInstanceOf(InvalidRefreshSessionError);
  });

  it('lost rotation without reuse evidence returns 401 INVALID_REFRESH_TOKEN, not reuse', async () => {
    tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
      if (sql.includes('FROM sessions s JOIN users u')) return { rows: [sessionRow], rowCount: 1 };
      if (sql.includes('SET refresh_token_hash = $1')) return { rows: [], rowCount: 0 };
      if (sql.includes('previous_refresh_token_hashes')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe('INVALID_REFRESH_TOKEN');
    await fastify.close();
  });

  it('a signing failure is NOT treated as token reuse (500, no revocation, no reuse audit)', async () => {
    signToken.mockRejectedValue(new Error('signing boom'));
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(500);
    expect(res.json().code).toBe('INTERNAL');
    const revocations = tenantQuery.mock.calls.filter(([, sql]: any[]) =>
      (sql as string).includes('SET revoked_at = NOW()'));
    expect(revocations).toHaveLength(0);
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SECURITY_REFRESH_TOKEN_REUSED' })
    );
    await fastify.close();
  });

  it('caller cancellation (AbortError) is never treated as rotation failure', async () => {
    signToken.mockRejectedValue(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }));
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(500);
    expect(recordAudit).not.toHaveBeenCalledWith(
      expect.objectContaining({ action: 'SECURITY_REFRESH_TOKEN_REUSED' })
    );
    await fastify.close();
  });

  it('a successful rotation still returns fresh tokens', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'POST', url: '/auth/refresh', headers: { cookie: cookieHeader } });
    expect(res.statusCode).toBe(200);
    expect(res.json().accessToken).toBe('signed-access-token');
    await fastify.close();
  });
});
