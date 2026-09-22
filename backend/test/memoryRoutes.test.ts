/**
 * memoryRoutes.test.ts — /api/v1/memory CRUD routes.
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live Postgres):
 *  - Unauthenticated requests get 401 (requireAuth enforced).
 *  - Requests without the memory:* permission get 403 (real
 *    requirePermission, not a pass-through).
 *  - Every store call carries the caller's tenantId/userId: a caller in
 *    tenant A produces queries that can only touch tenant A rows.
 *  - CRUD happy paths, validation rejections, and MEMORY_NOT_FOUND
 *    handling; security-relevant actions are audited.
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL POSTGRESQL:
 *  - Live RLS enforcement of the migration-027 tenant_isolation policy.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: { value: null as any },
}));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: (err?: Error) => void) => {
    if (!currentAuth.value) {
      done(Errors.unauthorized('MISSING_TOKEN', 'Authorization header with Bearer <redacted> required'));
      return;
    }
    req.auth = currentAuth.value;
    done();
  },
}));
// Real permission enforcement: 403s are exercised for real.
vi.mock('../src/authz/middleware.js', async (importOriginal) => importOriginal());

import { memoryRoutes } from '../src/memory/routes.js';
import { AppError, Errors } from '../src/errors.js';
import type { AuthContext } from '../src/authz/permissions.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';

function authFor(overrides: Partial<AuthContext> = {}): AuthContext {
  return {
    userId: USER_A1,
    tenantId: TENANT_A,
    sessionId: 'a1000000-0000-4000-8000-000000000000',
    roleId: 'aa000000-0000-4000-8000-000000000000',
    email: 'a1@example.test',
    displayName: 'User A1',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['memory:read', 'memory:write'],
    ...overrides,
  };
}

async function app() {
  const fastify = Fastify();
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(memoryRoutes, { prefix: '/api/v1' });
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  recordAudit.mockResolvedValue(undefined);
  currentAuth.value = authFor();
});

describe('auth', () => {
  it('rejects unauthenticated requests with 401', async () => {
    currentAuth.value = null;
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects callers without memory:read with 403', async () => {
    currentAuth.value = authFor({ permissions: [] });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
  });

  it('rejects callers without memory:write on POST with 403', async () => {
    currentAuth.value = authFor({ permissions: ['memory:read'] });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('POST /memory', () => {
  it('creates a fact, scopes it to the caller, and audits it', async () => {
    const row = { id: 'm1', tenant_id: TENANT_A, user_id: USER_A1, fact: 'prefers tea', category: 'preference', classification: 'INTERNAL', source: 'user-stated' };
    tenantQuery.mockResolvedValue({ rows: [row] });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'prefers tea', category: 'preference' },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().memory.fact).toBe('prefers tea');
    const [, , params] = tenantQuery.mock.calls[0]!;
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toBe(USER_A1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_CREATE', resourceId: 'm1', tenantId: TENANT_A, userId: USER_A1 })
    );
  });

  it('rejects empty or over-long facts with 400', async () => {
    const fastify = await app();
    const empty = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: '  ' } });
    expect(empty.statusCode).toBe(400);
    const long = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: 'x'.repeat(2001) } });
    expect(long.statusCode).toBe(400);
    const badCategory = await fastify.inject({ method: 'POST', url: '/api/v1/memory', payload: { fact: 'x', category: 'nope' } });
    expect(badCategory.statusCode).toBe(400);
    expect(tenantQuery).not.toHaveBeenCalled();
  });

  it('rejects classification above the caller clearance with 403', async () => {
    currentAuth.value = authFor({ clearance: 'PUBLIC' });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/api/v1/memory',
      payload: { fact: 'x', classification: 'CONFIDENTIAL' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLASSIFICATION_DENIED');
  });

  it('rejects malformed ids with 400', async () => {
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory/not-a-uuid' });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /memory', () => {
  it('lists only the caller’s facts (tenant+user scoped)', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1' }] });
    const fastify = await app();
    const res = await fastify.inject({ method: 'GET', url: '/api/v1/memory?category=preference&limit=10' });
    expect(res.statusCode).toBe(200);
    expect(res.json().memories).toHaveLength(1);
    const [, sql, params] = tenantQuery.mock.calls[0]!;
    expect(sql).toMatch(/tenant_id = \$1[\s\S]*user_id = \$2/);
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toBe(USER_A1);
  });

  it('a tenant-B id is invisible: MEMORY_NOT_FOUND when rows are empty', async () => {
    tenantQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'GET',
      url: '/api/v1/memory/b2222222-2222-4222-8222-222222222222',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('MEMORY_NOT_FOUND');
    // The query the module issued was still scoped to tenant A — the id
    // alone can never reach another tenant's row.
    expect(tenantQuery.mock.calls[0]![2][1]).toBe(TENANT_A);
  });
});

describe('PATCH /memory/:id', () => {
  it('updates a fact and audits it', async () => {
    const row = { id: 'm1', fact: 'prefers coffee', classification: 'INTERNAL' };
    tenantQuery.mockResolvedValue({ rows: [row] });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
      payload: { fact: 'prefers coffee' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().memory.fact).toBe('prefers coffee');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_UPDATE', resource: 'memory' })
    );
  });

  it('returns 404 for another user’s fact', async () => {
    tenantQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'PATCH',
      url: '/api/v1/memory/b2222222-2222-4222-8222-222222222222',
      payload: { fact: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /memory/:id', () => {
  it('deletes a fact, returns 204, and audits it', async () => {
    tenantQuery.mockResolvedValue({ rowCount: 1 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(204);
    const [, sql, params] = tenantQuery.mock.calls[0]!;
    expect(sql).toContain('DELETE FROM memory_facts');
    expect(params).toEqual(['a1111111-1111-4111-8111-111111111111', TENANT_A, USER_A1]);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MEMORY_DELETE', resource: 'memory' })
    );
    // Audit must not carry the fact text itself.
    const auditInput = (recordAudit as any).mock.calls[0][0];
    expect(JSON.stringify(auditInput)).not.toContain('prefers');
  });

  it('rejects cross-tenant delete: caller tenant is bound, not the target’s', async () => {
    currentAuth.value = authFor({ tenantId: TENANT_B });
    tenantQuery.mockResolvedValue({ rowCount: 0 });
    const fastify = await app();
    const res = await fastify.inject({
      method: 'DELETE',
      url: '/api/v1/memory/a1111111-1111-4111-8111-111111111111',
    });
    expect(res.statusCode).toBe(404);
    expect(tenantQuery.mock.calls[0]![2][1]).toBe(TENANT_B);
  });
});
