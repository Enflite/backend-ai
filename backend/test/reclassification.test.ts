import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

// Deterministic concurrency regression test for PATCH /documents/:id/classification.
// The route wraps the status guard SELECT ... FOR UPDATE + UPDATE + chunk DELETE
// in one transaction via withTenantTx. The mocked withTenantTx below emulates
// Postgres row locking: concurrent transactions serialize on the document row,
// and the guard is re-evaluated against committed state at lock acquisition,
// so a second relabel issued while the first is in flight must lose (404)
// instead of overwriting an in-flight reclassification or resurrecting chunks.

const events: string[] = [];
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
const { enqueueIngestion } = vi.hoisted(() => ({ enqueueIngestion: vi.fn() }));

interface DocState {
  id: string;
  classification: string;
  owner_id: string;
  status: string;
  deleted_at: string | null;
}
const docState: DocState = {
  id: '11111111-1111-4111-8111-111111111111',
  classification: 'INTERNAL',
  owner_id: 'uploader-1',
  status: 'COMPLETED',
  deleted_at: null,
};
let chunkCount = 5;

const { withTenantTx, txCalls } = vi.hoisted(() => {
  // Fake row lock: each transaction queues behind the previous one, exactly
  // like Postgres SELECT ... FOR UPDATE blocking on a locked row.
  let lockTail: Promise<void> = Promise.resolve();
  const calls: Array<{ tenantId: string; queries: string[] }> = [];
  const withTenantTx = vi.fn(async (tenantId: string, callback: (client: any) => Promise<any>) => {
    events.push('tx-start');
    const acquired = lockTail;
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    lockTail = gate;
    await acquired;
    const call = { tenantId, queries: [] as string[] };
    calls.push(call);
    try {
      const client = {
        query: async (text: string, params?: unknown[]) => {
          call.queries.push(text);
          if (text.includes('FOR UPDATE')) {
            if (docState.deleted_at || docState.status === 'PENDING' || docState.status === 'PROCESSING') {
              return { rows: [], rowCount: 0 };
            }
            return {
              rows: [{ classification: docState.classification, owner_id: docState.owner_id, has_grant: false }],
              rowCount: 1,
            };
          }
          if (text.startsWith('UPDATE documents')) {
            if (docState.status === 'PENDING' || docState.status === 'PROCESSING') {
              return { rows: [], rowCount: 0 };
            }
            docState.classification = String(params![2]);
            docState.status = 'PENDING';
            return {
              rows: [{ id: docState.id, classification: docState.classification, status: 'PENDING' }],
              rowCount: 1,
            };
          }
          if (text.startsWith('DELETE FROM document_chunks')) {
            chunkCount = 0;
            return { rows: [], rowCount: 5 };
          }
          throw new Error(`unexpected SQL: ${text}`);
        },
      };
      // Hold the lock briefly so the second request is guaranteed to queue
      // behind this one (simulating the UPDATE+DELETE work inside the tx).
      await new Promise((resolve) => setTimeout(resolve, 20));
      const result = await callback(client);
      events.push('tx-end');
      return result;
    } finally {
      release();
    }
  });
  return { withTenantTx, txCalls: calls };
});

vi.mock('../src/db/pool.js', () => ({ query: vi.fn(), tenantQuery: vi.fn(), withTenantTx }));
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
  docState.deleted_at = null;
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
    // One transaction, all three statements on the same client, in order.
    expect(withTenantTx).toHaveBeenCalledTimes(1);
    expect(withTenantTx.mock.calls[0]![0]).toBe('22222222-2222-4222-8222-222222222222');
    expect(txCalls).toHaveLength(1);
    const queries = txCalls[0]!.queries;
    expect(queries).toHaveLength(3);
    expect(queries[0]).toContain('FOR UPDATE');
    expect(queries[1]).toMatch(/^UPDATE documents/);
    expect(queries[2]).toMatch(/^DELETE FROM document_chunks/);
    // Enqueue happens only after the transaction resolved (never inside it).
    expect(events).toEqual(['tx-start', 'tx-end', 'audit', 'enqueue']);
    await fastify.close();
  });
});
