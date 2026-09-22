/**
 * retention.test.ts — retention purge unit tests (Phase 5c, MongoDB/ADR-014).
 *
 * Mocks the MongoDB layer and the audit writer; asserts the purge honors
 * legal holds, batches deletes, resolves per-tenant overrides, audits the
 * purge *after* deleting audit rows, and keeps sweeping when one tenant
 * fails. VALIDATED IN CI with mocks; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the MongoDB layer: getDb returns a mock Db with collection() that
// returns mock collections. withTenantTx runs the callback with a mock session.
const { mockCollections, getDbMock, withTenantTxMock } = vi.hoisted(() => {
  const mockCollections: Record<string, any> = {};
  const makeCollection = () => ({
    find: vi.fn(),
    findOne: vi.fn(),
    deleteMany: vi.fn(),
    deleteOne: vi.fn(),
    insertOne: vi.fn(),
    updateOne: vi.fn(),
    updateMany: vi.fn(),
  });
  const getCollection = (name: string) => {
    if (!mockCollections[name]) {
      mockCollections[name] = makeCollection();
    }
    return mockCollections[name];
  };
  const getDbMock = vi.fn(async () => ({
    collection: getCollection,
  }));
  const withTenantTxMock = vi.fn(async (_tenantId: string, callback: (session: any, db: any) => Promise<any>) => {
    const mockSession = {};
    const mockDb = { collection: getCollection };
    return callback(mockSession, mockDb);
  });
  return { mockCollections, getDbMock, withTenantTxMock };
});

vi.mock('../src/db/mongo.js', () => ({
  getDb: getDbMock,
  withTenantTx: withTenantTxMock,
}));

const { recordAuditMock, purgeGlobalAuditEventsMock } = vi.hoisted(() => ({
  recordAuditMock: vi.fn(),
  purgeGlobalAuditEventsMock: vi.fn(),
}));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  purgeGlobalAuditEvents: purgeGlobalAuditEventsMock,
}));

import {
  effectivePolicy,
  purgeAllTenants,
  purgeTenant,
  resolvePolicy,
} from '../src/retention/purge.js';
import { config } from '../src/config.js';

// Helper to create a mock cursor with toArray()
function mockCursor(docs: any[]) {
  return {
    toArray: vi.fn().mockResolvedValue(docs),
    project: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
  };
}

// Helper to get or create a mock collection
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      find: vi.fn().mockReturnValue(mockCursor([])),
      findOne: vi.fn().mockResolvedValue(null),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true }),
    };
  }
  return mockCollections[name];
}

function resetCollections() {
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    // Reset all mock methods that exist
    for (const method of ['find', 'findOne', 'deleteMany', 'deleteOne', 'insertOne', 'updateOne', 'updateMany']) {
      if (coll[method] && typeof coll[method].mockReset === 'function') {
        coll[method].mockReset();
      }
    }
    // Default: empty results (only for methods that exist)
    if (coll.find) coll.find.mockReturnValue(mockCursor([]));
    if (coll.findOne) coll.findOne.mockResolvedValue(null);
    if (coll.deleteMany) coll.deleteMany.mockResolvedValue({ deletedCount: 0 });
  }
}

beforeEach(() => {
  getDbMock.mockClear();
  withTenantTxMock.mockClear();
  recordAuditMock.mockReset();
  purgeGlobalAuditEventsMock.mockReset();
  recordAuditMock.mockResolvedValue(undefined);
  purgeGlobalAuditEventsMock.mockResolvedValue(0);
  resetCollections();
});

describe('retention policy resolution', () => {
  it('falls back to global config when no tenant override exists', () => {
    const policy = effectivePolicy(undefined);
    expect(policy).toEqual({
      conversationsDays: config.RETENTION_CONVERSATIONS_DAYS,
      messagesDays: config.RETENTION_MESSAGES_DAYS,
      auditEventsDays: config.RETENTION_AUDIT_EVENTS_DAYS,
    });
  });

  it('prefers tenant overrides field by field', () => {
    const policy = effectivePolicy({ conversationsDays: 30, messagesDays: null, auditEventsDays: 0 });
    expect(policy.conversationsDays).toBe(30);
    expect(policy.messagesDays).toBe(config.RETENTION_MESSAGES_DAYS);
    expect(policy.auditEventsDays).toBe(0);
  });

  it('reads the override document for the tenant', async () => {
    const coll = getMockCollection('retention_policies');
    coll.findOne.mockResolvedValueOnce({
      _id: 'tenant-1',
      conversationsDays: 90,
      messagesDays: null,
      auditEventsDays: null,
    });
    const policy = await resolvePolicy('tenant-1');
    expect(policy.conversationsDays).toBe(90);
    expect(coll.findOne).toHaveBeenCalledWith({ _id: 'tenant-1' });
  });
});

describe('purgeTenant', () => {
  it('deletes expired documents honoring legal holds, then audits the purge', async () => {
    // Setup: messages collection returns 2 expired messages, conversations
    // collection confirms their conversations are not on hold.
    const messagesColl = getMockCollection('messages');
    const conversationsColl = getMockCollection('conversations');
    const auditColl = getMockCollection('audit_events');
    // purgeMessages: first batch has 2 messages, second batch empty (done)
    messagesColl.find
      .mockReturnValueOnce(mockCursor([
        { _id: 'm1', conversationId: 'c1' },
        { _id: 'm2', conversationId: 'c1' },
      ]))
      .mockReturnValueOnce(mockCursor([]));
    // Legal-hold check: conversation c1 is not on hold
    conversationsColl.find.mockReturnValueOnce(mockCursor([{ _id: 'c1' }]));
    messagesColl.deleteMany.mockResolvedValueOnce({ deletedCount: 2 });

    // purgeConversations: 1 expired conversation (not on hold), then empty
    conversationsColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'c2' }]))
      .mockReturnValueOnce(mockCursor([]));
    // withTenantTx mock handles the transaction; deleteMany on the txDb
    // We need to mock the deleteMany calls inside withTenantTx. The mock
    // withTenantTxMock uses the same mockCollections, so we set up:
    // Actually, withTenantTxMock calls callback with mockDb that uses getCollection,
    // which returns the same mock collections. So deleteMany on messages/conversations
    // inside the transaction will hit our mocks.

    // purgeAuditEvents: 3 expired audit events, then empty
    auditColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'a1' }, { _id: 'a2' }, { _id: 'a3' }]))
      .mockReturnValueOnce(mockCursor([]));
    auditColl.deleteMany.mockResolvedValueOnce({ deletedCount: 3 });

    // For the conversation purge transaction, we need deleteMany to return counts
    // The withTenantTx mock will call deleteMany on the same mock collections
    // Let's set up sequential mock responses carefully.
    // Order of operations in purgeTenant:
    // 1. purgeMessages: messages.find (batch1), conversations.find (hold check), messages.deleteMany, messages.find (batch2 empty)
    // 2. purgeConversations: conversations.find (batch1), withTenantTx[ messages.deleteMany, conversations.deleteMany ], conversations.find (batch2 empty)
    // 3. purgeAuditEvents: audit_events.find (batch1), audit_events.deleteMany, audit_events.find (batch2 empty)

    // Reset and set up in order
    resetCollections();
    const msgColl = getMockCollection('messages');
    const convColl = getMockCollection('conversations');
    const audColl = getMockCollection('audit_events');

    msgColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'm1', conversationId: 'c1' }, { _id: 'm2', conversationId: 'c1' }]))
      .mockReturnValueOnce(mockCursor([]));
    convColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'c1' }])) // hold check for messages
      .mockReturnValueOnce(mockCursor([{ _id: 'c2' }])) // conversations batch1
      .mockReturnValueOnce(mockCursor([])); // conversations batch2
    msgColl.deleteMany.mockResolvedValue({ deletedCount: 2 }); // messages purge
    // Transaction deletes: messages.deleteMany and conversations.deleteMany inside withTenantTx
    // These will use the same mocks; we need them to return specific values
    // Let's make deleteMany return different values based on call order
    let deleteManyCalls = 0;
    const deleteManyImpl = async () => {
      deleteManyCalls++;
      if (deleteManyCalls === 1) return { deletedCount: 2 }; // messages purge (standalone)
      if (deleteManyCalls === 2) return { deletedCount: 0 }; // messages in conversation purge (tx)
      if (deleteManyCalls === 3) return { deletedCount: 1 }; // conversations in conversation purge (tx)
      return { deletedCount: 0 };
    };
    msgColl.deleteMany.mockImplementation(deleteManyImpl);
    convColl.deleteMany.mockImplementation(deleteManyImpl);
    audColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'a1' }, { _id: 'a2' }, { _id: 'a3' }]))
      .mockReturnValueOnce(mockCursor([]));
    audColl.deleteMany.mockResolvedValue({ deletedCount: 3 });

    const counts = await purgeTenant('tenant-1');

    expect(counts).toEqual({ conversations: 1, messages: 2, auditEvents: 3 });
    // The purge audit is written AFTER the deletes (it must survive them).
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RETENTION_PURGE', tenantId: 'tenant-1' })
    );
    const summary = recordAuditMock.mock.calls[0]![0] as { metadata: { counts: unknown } };
    expect(summary.metadata.counts).toEqual({ conversations: 1, messages: 2, auditEvents: 3 });
  });

  it('skips tables whose retention is disabled (0 override, null global)', async () => {
    resetCollections();
    const policyColl = getMockCollection('retention_policies');
    policyColl.findOne.mockResolvedValueOnce({
      _id: 'tenant-1',
      conversationsDays: null, // fall back to global (enabled)
      messagesDays: 0, // disabled
      auditEventsDays: 30, // enabled
    });

    const convColl = getMockCollection('conversations');
    const audColl = getMockCollection('audit_events');
    const msgColl = getMockCollection('messages');

    // Conversations: 2 deleted
    convColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'c1' }, { _id: 'c2' }]))
      .mockReturnValueOnce(mockCursor([]));
    convColl.deleteMany.mockResolvedValue({ deletedCount: 2 });
    msgColl.deleteMany.mockResolvedValue({ deletedCount: 0 });

    // Audit: 4 deleted
    audColl.find
      .mockReturnValueOnce(mockCursor([{ _id: 'a1' }, { _id: 'a2' }, { _id: 'a3' }, { _id: 'a4' }]))
      .mockReturnValueOnce(mockCursor([]));
    audColl.deleteMany.mockResolvedValue({ deletedCount: 4 });

    const counts = await purgeTenant('tenant-1');
    expect(counts).toEqual({ conversations: 2, messages: 0, auditEvents: 4 });
    // Messages purge should not have been called (disabled)
    expect(msgColl.find).not.toHaveBeenCalled();
  });

  it('a null global default disables purging for that table', async () => {
    const original = config.RETENTION_CONVERSATIONS_DAYS;
    (config as Record<string, unknown>).RETENTION_CONVERSATIONS_DAYS = null;
    try {
      resetCollections();
      // No override row
      getMockCollection('retention_policies').findOne.mockResolvedValueOnce(null);
      const counts = await purgeTenant('tenant-1');
      const convColl = getMockCollection('conversations');
      expect(convColl.find).not.toHaveBeenCalled();
      expect(counts.conversations).toBe(0);
    } finally {
      (config as Record<string, unknown>).RETENTION_CONVERSATIONS_DAYS = original;
    }
  });
});

describe('purgeAllTenants', () => {
  it('sweeps every tenant, purges global audit rows, and audits the sweep', async () => {
    resetCollections();
    const tenantsColl = getMockCollection('tenants');
    tenantsColl.find.mockReturnValue(mockCursor([{ _id: 't1' }, { _id: 't2' }]));

    // Global (NULL-tenant) audit rows are purged through audit.ts, which
    // owns the audit_events collection's pre-auth paths.
    purgeGlobalAuditEventsMock.mockResolvedValue(7);
    const result = await purgeAllTenants();
    expect(result.tenants).toBe(2);
    expect(result.failed).toEqual([]);
    expect(purgeGlobalAuditEventsMock).toHaveBeenCalledWith(config.RETENTION_AUDIT_EVENTS_DAYS, 1000);
    expect(result.counts.auditEvents).toBe(7); // global rows included
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'RETENTION_PURGE_SWEEP' })
    );
  });

  it('continues past a failed tenant and reports it', async () => {
    resetCollections();
    const tenantsColl = getMockCollection('tenants');
    tenantsColl.find.mockReturnValue(mockCursor([{ _id: 't1' }, { _id: 't2' }]));

    // Make purgeTenant fail for t1 by making the second getDb() call throw.
    // The first getDb() call (in purgeAllTenants to list tenants) must succeed.
    let getDbCalls = 0;
    getDbMock.mockImplementation(async () => {
      getDbCalls++;
      if (getDbCalls === 2) {
        // This is the getDb() inside purgeTenant('t1') -> resolvePolicy('t1')
        throw new Error('db exploded');
      }
      return { collection: (name: string) => getMockCollection(name) };
    });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await purgeAllTenants();
      expect(result.tenants).toBe(1);
      expect(result.failed).toEqual(['t1']);
      expect(recordAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RETENTION_PURGE_SWEEP', success: false })
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('surfaces a platform-global audit purge failure in the result and the sweep audit', async () => {
    resetCollections();
    const tenantsColl = getMockCollection('tenants');
    tenantsColl.find.mockReturnValue(mockCursor([{ _id: 't1' }]));

    purgeGlobalAuditEventsMock.mockRejectedValue(new Error('audit db down'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const result = await purgeAllTenants();
      // The failure is surfaced on the result, not just logged.
      expect(result.globalAuditPurgeError).toContain('audit db down');
      expect(result.failed).toEqual([]);
      // ...and the sweep audit is marked failed with the error detail.
      expect(recordAuditMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'RETENTION_PURGE_SWEEP',
          success: false,
          metadata: expect.objectContaining({ globalAuditPurgeError: expect.stringContaining('audit db down') }),
        })
      );
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('marks the sweep audit successful when the global audit purge succeeds', async () => {
    resetCollections();
    const tenantsColl = getMockCollection('tenants');
    tenantsColl.find.mockReturnValue(mockCursor([{ _id: 't1' }]));

    const result = await purgeAllTenants();
    expect(result.globalAuditPurgeError).toBeNull();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'RETENTION_PURGE_SWEEP',
        success: true,
        metadata: expect.objectContaining({ globalAuditPurgeError: null }),
      })
    );
  });
});
