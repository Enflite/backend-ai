import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { tenantQuery, withTenantTx } = vi.hoisted(() => ({
  tenantQuery: vi.fn(),
  // Mirror withTenantTx: run the callback with a client whose query() delegates
  // to the tenantQuery mock so SQL-text dispatch keeps working.
  withTenantTx: vi.fn(async (tenantId: string, callback: (client: any) => Promise<any>) =>
    callback({ query: (text: string, params?: any) => tenantQuery(tenantId, text, params) })),
}));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));

vi.mock('../src/db/pool.js', () => ({ tenantQuery, withTenantTx }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/documents/queue.js', () => ({ enqueueIngestion }));

const testAuth = vi.hoisted(() => ({
  current: {
    userId: 'owner-1',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'owner@example.test',
    displayName: 'Owner',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['document:read', 'document:classify'],
  } as Record<string, unknown>,
}));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = testAuth.current;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { documentRoutes } from '../src/documents/routes.js';
import { AppError } from '../src/errors.js';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

const DOC_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function mockDocLookup(classification: string, ownerId: string, hasGrant = false) {
  tenantQuery.mockImplementation(async (_tenantId: string, text: string) => {
    if (text.startsWith('SELECT d.classification, d.owner_id')) {
      return { rowCount: 1, rows: [{ classification, owner_id: ownerId, has_grant: hasGrant }] };
    }
    if (text.startsWith('UPDATE documents SET classification')) {
      return { rowCount: 1, rows: [{ id: DOC_ID, classification: 'PUBLIC', status: 'PENDING' }] };
    }
    return { rowCount: 0, rows: [] };
  });
}

let app: ReturnType<typeof Fastify>;

beforeEach(async () => {
  vi.clearAllMocks();
  testAuth.current = {
    userId: 'owner-1',
    tenantId: '22222222-2222-4222-8222-222222222222',
    sessionId: '33333333-3333-4333-8333-333333333333',
    roleId: '44444444-4444-4444-8444-444444444444',
    email: 'owner@example.test',
    displayName: 'Owner',
    roleName: 'User',
    clearance: 'CONFIDENTIAL',
    permissions: ['document:read', 'document:classify'],
  };
  enqueueIngestion.mockResolvedValue('job-1');
  app = Fastify();
  // Mirror server.ts's AppError mapping so code assertions match production.
  app.setErrorHandler((error: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await app.register(documentRoutes);
});

describe('PATCH /documents/:id/classification authorization', () => {
  it('rejects reclassification by a non-owner without tenant:manage', async () => {
    mockDocLookup('CONFIDENTIAL', 'someone-else');
    testAuth.current.userId = 'intruder-1';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('DOCUMENT_RECLASSIFY_FORBIDDEN');
  });

  it('allows reclassification by a non-owner holding an explicit document grant', async () => {
    mockDocLookup('INTERNAL', 'someone-else', true);
    testAuth.current.userId = 'collaborator-1';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
  });

  it('sends the caller identity into the grant check like the document GET route', async () => {
    mockDocLookup('INTERNAL', 'someone-else');
    testAuth.current.userId = 'collaborator-1';
    await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    const lookup = tenantQuery.mock.calls.find(([, text]: any[]) =>
      (text as string).startsWith('SELECT d.classification, d.owner_id'));
    expect(lookup).toBeDefined();
    // user_id and role_id are bound for the document_permissions grant predicate.
    expect(lookup![2]).toEqual(expect.arrayContaining(['collaborator-1', testAuth.current.roleId]));
  });

  it('allows reclassification by a tenant manager who is not the owner', async () => {
    mockDocLookup('INTERNAL', 'someone-else');
    testAuth.current.userId = 'manager-1';
    testAuth.current.permissions = ['document:read', 'document:classify', 'tenant:manage'];
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
  });

  it('rejects when the caller cannot read the current classification', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    testAuth.current.clearance = 'INTERNAL';
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'INTERNAL', confirm: true },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('CLASSIFICATION_DENIED');
  });

  it('requires explicit confirmation for downgrades', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('records the previous classification in the audit event', async () => {
    mockDocLookup('CONFIDENTIAL', 'owner-1');
    const response = await app.inject({
      method: 'PATCH',
      url: `/documents/${DOC_ID}/classification`,
      payload: { classification: 'PUBLIC', confirm: true },
    });
    expect(response.statusCode).toBe(202);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DOCUMENT_CLASSIFICATION_CHANGED',
        classification: 'PUBLIC',
        metadata: { previousClassification: 'CONFIDENTIAL' },
      })
    );
  });
});

describe('list pagination', () => {
  it('passes bounded limit/offset to the documents query', async () => {
    tenantQuery.mockResolvedValue({ rows: [] });
    const response = await app.inject({ method: 'GET', url: '/documents?limit=10&offset=20' });
    expect(response.statusCode).toBe(200);
    const params = tenantQuery.mock.calls[0]![2] as unknown[];
    expect(params.slice(-2)).toEqual([10, 20]);
    expect(response.json().pagination).toEqual({ limit: 10, offset: 20 });
  });

  it('rejects limit above the server maximum', async () => {
    const response = await app.inject({ method: 'GET', url: '/documents?limit=500' });
    expect(response.statusCode).toBe(400);
  });
});
