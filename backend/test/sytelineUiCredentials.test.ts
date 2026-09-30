/**
 * sytelineUiCredentials.test.ts — per-user encrypted credential store.
 *
 * - save/rotate/list/delete scoped per (tenantId, userId)
 * - cross-user and cross-tenant isolation (user B cannot read user A's creds)
 * - audit events carry the username only — never secret material
 * - fail closed without CREDENTIAL_STORE_KEY
 *
 * Uses in-memory collection stand-ins; real MongoDB behavior
 * REQUIRES REAL PRODUCTION INFRASTRUCTURE. VALIDATED IN CI.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { config } from '../src/config.js';
import type { AuthContext } from '../src/authz/permissions.js';
import {
  deleteCredential,
  listCredentials,
  resolveUiCredentials,
  saveCredential,
} from '../src/syteline/ui/credentialStore.js';
import { decryptCredential, resolveCredentialStoreKey } from '../src/secrets/credentialCrypto.js';

const TEST_KEY = randomBytes(32).toString('hex');

function authFor(userId: string, tenantId: string): AuthContext {
  return {
    userId,
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    tenantId,
    roleId: 'role-1',
    roleName: 'Admin',
    permissions: ['tool:use', 'syteline:ui'],
    sessionId: 'session-1',
  };
}

// Minimal in-memory stand-in for the syteline_credentials collection.
function memoryCollection() {
  const docs = new Map<string, Record<string, any>>();
  const matches = (doc: Record<string, any>, filter: Record<string, any>) =>
    Object.entries(filter).every(([k, v]) => doc[k] === v);
  return {
    docs,
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of docs.values()) if (matches(doc, filter)) return { ...doc };
      return null;
    }),
    replaceOne: vi.fn(async (filter: Record<string, any>, doc: Record<string, any>, opts: { upsert?: boolean }) => {
      const k = `${filter.tenantId}:${filter.userId}`;
      if (docs.has(k)) {
        docs.set(k, { ...doc });
        return { modifiedCount: 1, upsertedCount: 0 };
      }
      if (opts?.upsert) {
        docs.set(k, { ...doc });
        return { modifiedCount: 0, upsertedCount: 1 };
      }
      return { modifiedCount: 0, upsertedCount: 0 };
    }),
    deleteOne: vi.fn(async (filter: Record<string, any>) => {
      const k = `${filter.tenantId}:${filter.userId}`;
      const had = docs.delete(k);
      return { deletedCount: had ? 1 : 0 };
    }),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const [k, doc] of docs.entries()) {
        if (doc._id === filter._id) {
          docs.set(k, { ...doc, ...update.$set });
          return { modifiedCount: 1 };
        }
      }
      return { modifiedCount: 0 };
    }),
    find: vi.fn((filter: Record<string, any>) => {
      const rows = [...docs.values()].filter((doc) => matches(doc, filter));
      return {
        project: vi.fn().mockReturnThis(),
        toArray: vi.fn(async () => rows.map((r) => ({ ...r }))),
      };
    }),
  };
}

let coll: ReturnType<typeof memoryCollection>;

beforeEach(() => {
  vi.clearAllMocks();
  coll = memoryCollection();
  getDbMock.mockResolvedValue({ collection: vi.fn(() => coll) });
  recordAuditMock.mockResolvedValue(undefined);
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
});

describe('credential store scoping', () => {
  it('saves and lists the caller\'s own credentials (username only)', async () => {
    const auth = authFor('user-a', 'tenant-a');
    const summary = await saveCredential(auth, 'jsmith1', 's3cret', 'prod');
    expect(summary.username).toBe('jsmith1');
    expect(summary).not.toHaveProperty('password');
    expect(summary).not.toHaveProperty('encryptedPassword');

    const listed = await listCredentials(auth);
    expect(listed).toHaveLength(1);
    expect(listed[0]!.username).toBe('jsmith1');
    expect(listed[0]).not.toHaveProperty('encryptedPassword');
    // The stored document holds an encrypted envelope, never cleartext.
    const stored = [...coll.docs.values()][0]!;
    expect(stored.encryptedPassword.alg).toBe('aes-256-gcm');
    expect(JSON.stringify(stored)).not.toContain('s3cret');
  });

  it('rotates on re-save (one document per user)', async () => {
    const auth = authFor('user-a', 'tenant-a');
    await saveCredential(auth, 'jsmith1', 'old-secret');
    await saveCredential(auth, 'jsmith1', 'new-secret');
    expect(coll.docs.size).toBe(1);
    const listed = await listCredentials(auth);
    expect(listed).toHaveLength(1);
  });

  it('isolates users: user B cannot see user A\'s credentials', async () => {
    await saveCredential(authFor('user-a', 'tenant-a'), 'alice', 'alice-secret');
    const listedB = await listCredentials(authFor('user-b', 'tenant-a'));
    expect(listedB).toHaveLength(0);
    const deletedB = await deleteCredential(authFor('user-b', 'tenant-a'));
    expect(deletedB).toBe(false);
    // User A's creds survive user B's delete attempt.
    expect(await listCredentials(authFor('user-a', 'tenant-a'))).toHaveLength(1);
  });

  it('isolates tenants: same user id in another tenant sees nothing', async () => {
    await saveCredential(authFor('user-a', 'tenant-a'), 'alice', 'alice-secret');
    expect(await listCredentials(authFor('user-a', 'tenant-b'))).toHaveLength(0);
  });

  it('deletes the caller\'s credentials', async () => {
    const auth = authFor('user-a', 'tenant-a');
    await saveCredential(auth, 'jsmith1', 's3cret');
    expect(await deleteCredential(auth)).toBe(true);
    expect(await listCredentials(auth)).toHaveLength(0);
  });

  it('rejects invalid usernames', async () => {
    await expect(saveCredential(authFor('user-a', 'tenant-a'), 'evil user!', 'pw')).rejects.toThrow();
    await expect(saveCredential(authFor('user-a', 'tenant-a'), '', 'pw')).rejects.toThrow();
  });
});

describe('credential store audit hygiene', () => {
  it('audit events never carry secret material', async () => {
    const auth = authFor('user-a', 'tenant-a');
    await saveCredential(auth, 'jsmith1', 'super-secret-password');
    await deleteCredential(auth);
    expect(recordAuditMock).toHaveBeenCalled();
    const serialized = JSON.stringify(recordAuditMock.mock.calls);
    expect(serialized).not.toContain('super-secret-password');
    const savedCall = recordAuditMock.mock.calls.find(
      (call: unknown[]) => (call[0] as { action: string }).action === 'SYTELINE_CREDENTIAL_SAVED',
    );
    expect(savedCall).toBeDefined();
    expect((savedCall![0] as { metadata: { username: string } }).metadata.username).toBe('jsmith1');
  });
});

describe('credential resolution', () => {
  it('decrypts the stored password for login use', async () => {
    const auth = authFor('user-a', 'tenant-a');
    await saveCredential(auth, 'jsmith1', 'login-secret');
    const resolved = await resolveUiCredentials(auth);
    expect(resolved).not.toBeNull();
    expect(resolved!.username).toBe('jsmith1');
    expect(resolved!.source).toBe('stored');
    expect(resolved!.password.toString('utf8')).toBe('login-secret');
    resolved!.password.fill(0);
  });

  it('falls back to the service account when the user saved nothing', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_USERNAME = 'svc-account';
    (config as Record<string, unknown>).SYTELINE_UI_PASSWORD = 'svc-secret';
    try {
      const resolved = await resolveUiCredentials(authFor('user-a', 'tenant-a'));
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe('service');
      expect(resolved!.username).toBe('svc-account');
      resolved!.password.fill(0);
    } finally {
      (config as Record<string, unknown>).SYTELINE_UI_USERNAME = '';
      (config as Record<string, unknown>).SYTELINE_UI_PASSWORD = '';
    }
  });

  it('returns null when neither stored nor service credentials exist', async () => {
    const resolved = await resolveUiCredentials(authFor('user-a', 'tenant-a'));
    expect(resolved).toBeNull();
  });

  it('prefers stored credentials over the service account', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_USERNAME = 'svc-account';
    (config as Record<string, unknown>).SYTELINE_UI_PASSWORD = 'svc-secret';
    try {
      const auth = authFor('user-a', 'tenant-a');
      await saveCredential(auth, 'jsmith1', 'user-secret');
      const resolved = await resolveUiCredentials(auth);
      expect(resolved!.source).toBe('stored');
      resolved!.password.fill(0);
    } finally {
      (config as Record<string, unknown>).SYTELINE_UI_USERNAME = '';
      (config as Record<string, unknown>).SYTELINE_UI_PASSWORD = '';
    }
  });

  it('fails closed when CREDENTIAL_STORE_KEY is absent', async () => {
    (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = '';
    const auth = authFor('user-a', 'tenant-a');
    await expect(saveCredential(auth, 'jsmith1', 'pw')).rejects.toThrow();
    (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
  });

  it('stored envelopes decrypt with the configured key', async () => {
    const auth = authFor('user-a', 'tenant-a');
    await saveCredential(auth, 'jsmith1', 'roundtrip-secret');
    const stored = [...coll.docs.values()][0]!;
    const key = resolveCredentialStoreKey(TEST_KEY);
    const plaintext = decryptCredential(key, stored.encryptedPassword);
    expect(plaintext.toString('utf8')).toBe('roundtrip-secret');
    plaintext.fill(0);
  });
});
