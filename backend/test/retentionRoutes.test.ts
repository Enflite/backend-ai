/**
 * retentionRoutes.test.ts — retention policy and legal-hold API (Phase 5c).
 *
 * Covers authorization (retention:manage), tenant scoping, policy
 * get/update, legal-hold set/clear on conversations and audit events,
 * 404s, and the audit trail. The real requirePermission middleware is
 * used; only requireAuth (session) and the DB are mocked. The DB mock is
 * an in-memory stand-in for the Mongo seams the routes actually use
 * (getDb/withTenantTx from db/mongo.js).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

const { getDbMock, withTenantTxMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  withTenantTxMock: vi.fn(),
}));
const { recordAudit, recordAuditInTx } = vi.hoisted(() => ({
  recordAudit: vi.fn(),
  recordAuditInTx: vi.fn(),
}));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-1',
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'admin@example.test',
    displayName: 'Admin',
    roleName: 'Admin',
    clearance: 'INTERNAL',
    permissions: ['retention:manage'],
  } as Record<string, unknown>,
}));

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  withTenantTx: withTenantTxMock,
}));
vi.mock('../src/audit/audit.js', () => ({ recordAudit, recordAuditInTx }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));

import { AppError } from '../src/errors.js';
import { retentionRoutes } from '../src/retention/routes.js';

async function buildApp() {
  const app = Fastify();
  app.setErrorHandler((error: unknown, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'internal' } });
  });
  app.addHook('onRequest', (req: any, _reply, done) => {
    req.requestId = 'req-1';
    done();
  });
  await app.register(retentionRoutes);
  return app;
}

const CONV_ID = '11111111-1111-4111-8111-111111111111';
const AUDIT_ID = '22222222-2222-4222-8222-222222222222';

// In-memory Mongo stand-in: store is Map<collectionName, Map<_id, doc>>.
let store: Map<string, Map<string, any>>;

function matches(doc: any, filter: Record<string, unknown>): boolean {
  return Object.entries(filter).every(([key, value]) => doc?.[key] === value);
}

function applyUpdate(doc: any, update: Record<string, any>): void {
  if (update.$set) Object.assign(doc, update.$set);
}

function fakeCollection(name: string): {
  findOne: (...args: any[]) => Promise<any>;
  updateOne: (...args: any[]) => Promise<any>;
  findOneAndUpdate: (...args: any[]) => Promise<any>;
} {
  const coll = () => {
    let map = store.get(name);
    if (!map) {
      map = new Map();
      store.set(name, map);
    }
    return map;
  };
  return {
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      for (const doc of coll().values()) {
        if (matches(doc, filter)) return { ...doc };
      }
      return null;
    }),
    updateOne: vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, any>, opts?: { upsert?: boolean }) => {
        for (const doc of coll().values()) {
          if (matches(doc, filter)) {
            applyUpdate(doc, update);
            return { matchedCount: 1, modifiedCount: 1, upsertedId: undefined };
          }
        }
        if (opts?.upsert) {
          const doc: any = { ...(filter as object) };
          applyUpdate(doc, update);
          coll().set(String(doc._id), doc);
          return { matchedCount: 0, modifiedCount: 0, upsertedId: doc._id };
        }
        return { matchedCount: 0, modifiedCount: 0, upsertedId: undefined };
      }
    ),
    findOneAndUpdate: vi.fn(async (filter: Record<string, unknown>, update: Record<string, any>) => {
      for (const doc of coll().values()) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          return { _id: doc._id };
        }
      }
      return null;
    }),
  };
}

function fakeDb() {
  return { collection: (name: string) => fakeCollection(name) };
}

let sessionSeq = 0;

beforeEach(() => {
  vi.clearAllMocks();
  store = new Map();
  sessionSeq = 0;
  (currentAuth as Record<string, unknown>).permissions = ['retention:manage'];
  (currentAuth as Record<string, unknown>).tenantId = 'tenant-1';
  getDbMock.mockImplementation(async () => fakeDb());
  // Default transaction mock: runs the callback with a fresh fake session,
  // mirroring withTenantTx's real contract (session + db + tenantId).
  withTenantTxMock.mockImplementation(
    async (tenant: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) => {
      const session = { id: `session-${++sessionSeq}` };
      return callback(session, fakeDb(), tenant);
    }
  );
  recordAudit.mockResolvedValue(undefined);
  recordAuditInTx.mockResolvedValue(undefined);
});

describe('retention routes', () => {
  it('GET /retention/policy returns overrides and the effective policy, tenant-scoped', async () => {
    store.set(
      'retention_policies',
      new Map([['tenant-1', { _id: 'tenant-1', conversationsDays: 30, messagesDays: null, auditEventsDays: 0 }]])
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/retention/policy' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { overrides: unknown; effective: Record<string, number | null> };
    expect(body.overrides).toMatchObject({ conversationsDays: 30 });
    // NULL override falls back to the global default; 0 stays disabled.
    expect(body.effective.conversationsDays).toBe(30);
    expect(body.effective.auditEventsDays).toBe(0);
    await app.close();
  });

  it('PUT /retention/policy upserts overrides and audits the change', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/retention/policy',
      payload: { conversationsDays: 90, messagesDays: null, auditEventsDays: 0 },
    });
    expect(res.statusCode).toBe(200);
    expect(withTenantTxMock).toHaveBeenCalledWith('tenant-1', expect.any(Function));
    const doc = store.get('retention_policies')?.get('tenant-1');
    expect(doc).toMatchObject({ conversationsDays: 90, messagesDays: null, auditEventsDays: 0 });
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'RETENTION_POLICY_UPDATED',
        tenantId: 'tenant-1',
        userId: 'user-1',
        success: true,
      })
    );
    await app.close();
  });

  it('POST legal-hold sets and clears a conversation hold with audits', async () => {
    store.set('conversations', new Map([[CONV_ID, { _id: CONV_ID, tenantId: 'tenant-1', legalHold: false }]]));
    const app = await buildApp();
    const setRes = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(setRes.statusCode).toBe(200);
    expect(setRes.json()).toEqual({ id: CONV_ID, legalHold: true });
    expect(store.get('conversations')?.get(CONV_ID).legalHold).toBe(true);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'LEGAL_HOLD_SET',
        resource: 'conversation',
        resourceId: CONV_ID,
      })
    );

    const clearRes = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: false },
    });
    expect(clearRes.json()).toEqual({ id: CONV_ID, legalHold: false });
    expect(store.get('conversations')?.get(CONV_ID).legalHold).toBe(false);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'LEGAL_HOLD_CLEARED' })
    );
    await app.close();
  });

  it('POST legal-hold on audit events is tenant-scoped and audited', async () => {
    store.set('audit_events', new Map([[AUDIT_ID, { _id: AUDIT_ID, tenantId: 'tenant-1', legalHold: false }]]));
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/audit-events/${AUDIT_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ id: AUDIT_ID, legalHold: true });
    expect(store.get('audit_events')?.get(AUDIT_ID).legalHold).toBe(true);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'LEGAL_HOLD_SET',
        resource: 'audit_event',
        resourceId: AUDIT_ID,
      })
    );
    await app.close();
  });

  it('legal-hold on a missing conversation returns 404', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('CONVERSATION_NOT_FOUND');
    await app.close();
  });

  it('requires the retention:manage permission on every endpoint', async () => {
    (currentAuth as Record<string, unknown>).permissions = ['chat:create'];
    const app = await buildApp();
    for (const [method, url, payload] of [
      ['GET', '/retention/policy', undefined],
      ['PUT', '/retention/policy', { conversationsDays: 10 }],
      ['POST', `/retention/conversations/${CONV_ID}/legal-hold`, { hold: true }],
      ['POST', `/retention/audit-events/${AUDIT_ID}/legal-hold`, { hold: true }],
    ] as const) {
      const res = await app.inject({ method, url, payload });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('AUTHORIZATION_FAILURE');
    }
    expect(getDbMock).not.toHaveBeenCalled();
    expect(withTenantTxMock).not.toHaveBeenCalled();
    await app.close();
  });

  it('writes the legal-hold update and its audit row on the same transaction session', async () => {
    store.set('conversations', new Map([[CONV_ID, { _id: CONV_ID, tenantId: 'tenant-1', legalHold: false }]]));
    let updateSession: unknown;
    let auditSession: unknown;
    withTenantTxMock.mockImplementationOnce(
      async (tenant: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) => {
        const db = fakeDb();
        const baseCollection = db.collection.bind(db);
        db.collection = (name: string) => {
          const coll = baseCollection(name);
          if (name === 'conversations') {
            const wrapped = coll.findOneAndUpdate;
            coll.findOneAndUpdate = vi.fn(async (filter: any, update: any, opts: any) => {
              updateSession = opts?.session;
              return wrapped(filter, update, opts);
            });
          }
          return coll;
        };
        const session = { id: 'session-tx-test' };
        return callback(session, db, tenant);
      }
    );
    recordAuditInTx.mockImplementationOnce(async (session: unknown) => {
      auditSession = session;
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: `/retention/conversations/${CONV_ID}/legal-hold`,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(200);
    // Same session for the mutation and the audit write: they commit or roll
    // back together, never one without the other.
    expect(updateSession).toBeDefined();
    expect(auditSession).toBe(updateSession);
    await app.close();
  });

  it('aborts the policy upsert transaction when the in-transaction audit write fails', async () => {
    let committed = false;
    let rolledBack = false;
    let upsertSeen = false;
    // Mirrors the real withTenantTx contract: a throw inside the callback
    // rolls the transaction back instead of committing it.
    withTenantTxMock.mockImplementationOnce(
      async (tenant: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) => {
        const db = fakeDb();
        const baseCollection = db.collection.bind(db);
        db.collection = (name: string) => {
          const coll = baseCollection(name);
          if (name === 'retention_policies') {
            const wrapped = coll.updateOne;
            coll.updateOne = vi.fn(async (...args: any[]) => {
              upsertSeen = true;
              return wrapped(...args);
            });
          }
          return coll;
        };
        try {
          const result = await callback({ id: 'session-abort' }, db, tenant);
          committed = true;
          return result;
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      }
    );
    recordAuditInTx.mockRejectedValueOnce(new Error('audit store down'));
    const app = await buildApp();
    const res = await app.inject({
      method: 'PUT',
      url: '/retention/policy',
      payload: { conversationsDays: 90 },
    });
    // The audit failure propagates instead of being swallowed after commit.
    expect(res.statusCode).toBe(500);
    expect(upsertSeen).toBe(true);
    expect(recordAuditInTx).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'RETENTION_POLICY_UPDATED' })
    );
    expect(committed).toBe(false);
    expect(rolledBack).toBe(true);
    await app.close();
  });
});
