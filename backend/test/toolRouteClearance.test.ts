import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: 'user-1',
      tenantId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'user@example.test',
      displayName: 'User',
      roleName: 'User',
      clearance: 'INTERNAL',
      permissions: ['tool:use', 'syteline:read'],
    };
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { toolRoutes } from '../src/tools/routes.js';
import { toolRegistry } from '../src/tools/gateway.js';
import { AppError } from '../src/errors.js';

const tool = toolRegistry.find((entry) => entry.name === 'syteline.getItem')!;
const originalExecute = tool.execute;

async function app() {
  const fastify = Fastify();
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(toolRoutes);
  return fastify;
}

beforeEach(() => {
  vi.clearAllMocks();
  tool.execute = originalExecute;
  recordAudit.mockResolvedValue(undefined);
  tenantQuery.mockImplementation(async (_tenant: string, sql: string) => {
    if (sql.includes('INSERT INTO tool_executions')) return { rows: [{ id: 'exec-1' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
});

describe('POST /tools/:name/execute clearance enforcement', () => {
  it('rejects an asserted classification above the caller clearance with 403', async () => {
    const execute = vi.fn();
    tool.execute = execute as typeof tool.execute;
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tools/syteline.getItem/execute',
      payload: { parameters: { item: 'A', site: 'MAIN' }, classification: 'CUI', confirmed: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLASSIFICATION_DENIED');
    // The tool itself must never run on a denied call.
    expect(execute).not.toHaveBeenCalled();
    // The denial is still audited.
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TOOL_EXECUTION',
      success: false,
      classification: 'CUI',
    }));
    await fastify.close();
  });

  it('rejects the UNKNOWN classification as well', async () => {
    const fastify = await app();
    const res = await fastify.inject({
      method: 'POST',
      url: '/tools/syteline.getItem/execute',
      payload: { parameters: { item: 'A', site: 'MAIN' }, classification: 'UNKNOWN', confirmed: true },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('CLASSIFICATION_DENIED');
    await fastify.close();
  });
});
