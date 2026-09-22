import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

// Deterministic concurrency regression test for PATCH /documents/:id/classification.
// The route wraps the status guard findOne + findOneAndUpdate + chunk deleteMany
// in one transaction via withTenantTx. The mocked withTenantTx below emulates
// MongoDB transaction isolation: concurrent transactions serialize on the
// document, and the guard is re-evaluated against committed state at lock
// acquisition, so a second relabel issued while the first is in flight must
// lose (404) instead of overwriting an in-flight reclassification or
// resurrecting chunks.

const events: string[] = [];
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));

interface DocState {
  id: string;
  classification: string;
  ownerId: string;
  status: string;
  deletedAt: string | null;
}
const docState: DocState = {
  id: '11111111-1111-4111-8111-111111111111',
  classification: 'INTERNAL',
  ownerId: 'uploader-1',
  status: 'COMPLETED',
  deletedAt: null,
};
let chunkCount = 5;

const { withTenantTx, txCalls } = vi.hoisted(() => {
  // Fake transaction isolation: each transaction queues behind the previous
  // one, exactly like MongoDB write-conflict serialization on the document.
  let lockTail: Promise<void> = Promise.resolve();
  const calls: Array<{ tenantId: string; operations: string[] }> = [];
  const withTenantTx = vi.fn(async (tenantId: string, callback: (session: any, db: any, tenantId: string) => Promise<any>) => {
    events.push('tx-start');
    const acquired = lockTail;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lockTail = gate;
    await acquired;
    const call = { tenantId, operations: [] as string[] };
    calls.push(call);
    try {
      const session = {};
      const db = {
        collection: (name: string) => {
          if (name === 'documents') {
            return {
              findOne: async (filter: any, _options?: any) => {
                call.operations.push('findOne:documents');
                // Status guard: PENDING/PROCESSING or deleted -> not found
                if (docState.deletedAt) return null;
                if (filter.status?.$nin?.includes(docState.status)) return null;
                if (filter._id !== docState.id) return null;
                return {
                  _id: docState.id,
                  classification: docState.classification,
                  ownerId: docState.ownerId,
                };
              },
              findOneAndUpdate: async (filter: any, update: any, _options?: any) => {
                call.operations.push('findOneAndUpdate:documents');
                // Atomic guard: only succeeds if status is not PENDING/PROCESSING
                if (docState.deletedAt) return null;
                if (filter.status?.$nin?.includes(docState.status)) return null;
                if (filter._id !== docState.id) return null;
                // Apply the update
                if (update.$set?.classification) {
                  docState.classification = update.$set.classification;
                }
                if (update.$set?.status) {
                  docState.status = update.$set.status;
                }
                return {
                  _id: docState.id,
                  classification: docState.classification,
                  status: docState.status,
                  ownerId: docState.ownerId,
                  filename: 'test.txt',
                  createdAt: new Date(),
                  updatedAt: new Date(),
                };
              },
            };
          }
          if (name === 'document_permissions') {
            return {
              findOne: async (_filter: any, _options?: any) => {
                call.operations.push('findOne:document_permissions');
                // User is the owner; no grant needed
                return null;
              },
            };
          }
          if (name === 'document_chunks') {
            return {
              deleteMany: async (_filter: any, _options?: any) => {
                call.operations.push('deleteMany:document_chunks');
                const deleted = chunkCount;
                chunkCount = 0;
                return { acknowledged: true, deletedCount: deleted };
              },
            };
          }
          if (name === 'department_memberships' || name === 'security_group_memberships') {
            return {
              find: () => ({
                toArray: async () => [],
              }),
            };
          }
          throw new Error(`unexpected collection: ${name}`);
        },
      };
      // Hold the lock briefly so the second request is guaranteed to queue
      // behind this one (simulating the update+delete work inside the tx).
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await callback(session, db, tenantId);
      events.push('tx-end');
      return result;
    } finally {
      release();
    }
  });
  return { withTenantTx, txCalls: calls };
});

vi.mock('../src/db/mongo.js', () => ({ withTenantTx }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit }));
vi.mock('../src/documents/queue.js', () => ({
  enqueueIngestion: (...args: unknown[]) => {
    events.push('enqueue');
    return (enqueueIngestion as any)(...args);
  },
}));
vi.mock('../src/storage/storage.js', () => ({ s3Storage: { put: vi.fn(), delete: vi.fn() } }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = {
      userId: 'uploader-1',
      tenantId: '22222222-2222-4222-8222-222222222222',
      sessionId: '33333333-3333-4333-8333-333333333333',
      roleId: '44444444-4444-4444-8444-444444444444',
      email: 'uploader@example.test',
      displayName: 'Uploader',
      roleName: 'User',
      clearance: 'CUI',
      permissions: ['document:upload', 'document:classify'],
    };
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (_name: string) => (_req: any, _reply: any, done: () => void) => done(),
}));

import { documentRoutes } from '../src/documents/routes.js';
import { AppError } from '../src/errors.js';

async function app() {
  const fastify = Fastify();
  fastify.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({ error: { code: error.code, message: error.message } });
    }
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
  });
  await fastify.register(documentRoutes);
  return fastify;
}

beforeEach(() => {
  events.length = 0;
  txCalls.length = 0;
  vi.clearAllMocks();
  recordAudit.mockImplementation(async (...args: unknown[]) => { events.push('audit'); return undefined; });
  enqueueIngestion.mockResolvedValue('job-1');
  // Reset the fake database.
  docState.classification = 'INTERNAL';
  docState.status = 'COMPLETED';
  docState.deletedAt = null;
  chunkCount = 5;
});

describe('PATCH /documents/:id/classification concurrency', () => {
  it('serializes concurrent relabels: exactly one wins, the loser 404s, chunks deleted once', async () => {
    const fastify = await app();
    const docId = '11111111-1111-4111-8111-111111111111';
    const relabel = (classification: string) =>
      fastify.inject({
        method: 'PATCH',
        url: `/documents/${docId}/classification`,
        payload: { classification },
      });
    const [first, second] = await Promise.all([relabel('CONFIDENTIAL'), relabel('CONFIDENTIAL')]);
    const statuses = [first.statusCode, second.statusCode].sort();
    // Exactly one succeeds; the other sees PENDING after the first commits.
    expect(statuses).toEqual([202, 404]);
    const winner = first.statusCode === 202 ? first : second;
    expect(winner.json().document.classification).toBe('CONFIDENTIAL');
    expect(winner.json().document.status).toBe('PENDING');
    // Chunks of the old label are deleted exactly once; audit + enqueue once.
    expect(chunkCount).toBe(0);
    expect(recordAudit).toHaveBeenCalledTimes(1);
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'DOCUMENT_CLASSIFICATION_CHANGED',
        metadata: { previousClassification: 'INTERNAL' },
      })
    );
    expect(enqueueIngestion).toHaveBeenCalledTimes(1);
    await fastify.close();
  });

  it('holds guard, update, and chunk delete in one transaction before any enqueue', async () => {
    const fastify = await app();
    const docId = '11111111-1111-4111-8111-111111111111';
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/documents/${docId}/classification`,
      payload: { classification: 'CONFIDENTIAL' },
    });
    expect(res.statusCode).toBe(202);
    // One transaction, all operations on the same db, in order.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(withTenantTx.mock.calls[0]![0]).toBe('22222222-2222-4222-8222-222222222222');
    expect(txCalls).toHaveLength(1);
    const operations = txCalls[0]!.operations;
    // Guard findOne, grant-check findOne, atomic findOneAndUpdate, chunk deleteMany.
    expect(operations).toEqual([
      'findOne:documents',
      'findOne:document_permissions',
      'findOneAndUpdate:documents',
      'deleteMany:document_chunks',
    ]);
    // Enqueue happens only after the transaction resolved (never inside it).
    expect(events).toEqual(['tx-start', 'tx-end', 'audit', 'enqueue']);
    await fastify.close();
  });

  it('still enqueues ingestion when audit persistence fails (fail-closed 503)', async () => {
    // Fail-closed audit failure: the document is already PENDING after the
    // committed transaction, so the ingestion job must be enqueued anyway —
    // otherwise the document strands with no active job until orphan recovery.
    recordAudit.mockRejectedValueOnce(
      new AppError(503, 'AUDIT_PERSISTENCE_FAILED', 'Audit event could not be persisted')
    );
    const fastify = await app();
    const docId = '11111111-1111-4111-8111-111111111111';
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/documents/${docId}/classification`,
      payload: { classification: 'CONFIDENTIAL' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('AUDIT_PERSISTENCE_FAILED');
    // The job was enqueued despite the audit failure; the document is not stranded.
    expect(enqueueIngestion).toHaveBeenCalledTimes(1);
    expect(enqueueIngestion).toHaveBeenCalledWith(
      expect.objectContaining({ documentId: docId })
    );
    await fastify.close();
  });
});
