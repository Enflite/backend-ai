/**
 * studioConnections.test.ts — named SyteLine connection store.
 *
 * - create/list/get/update/delete lifecycle, tenant-scoped
 * - per-tenant name uniqueness (case-insensitive) → 409
 * - 'default' is a reserved name; the env-backed default is read-only
 * - baseUrl transport rule: HTTPS, or HTTP only for loopback hosts
 * - the token is encrypted at rest and never returned in cleartext
 * - resolveConnectionTarget: 409 for unknown / unconfigured, decrypts on hit
 *
 * VALIDATED IN CI with an in-memory Mongo stand-in; no live infrastructure.
 */
import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit: recordAuditMock }));

import { config } from '../src/config.js';
import {
  createConnection,
  deleteConnection,
  getConnectionView,
  listConnections,
  resolveConnectionTarget,
  updateConnection,
  assertSecureBaseUrl,
} from '../src/studio/connections/store.js';
import { DEFAULT_CONNECTION_ID } from '../src/studio/types.js';

// Reuse the in-memory collection behavior from the shared helper by
// delegating getDbMock to it.
import { makeInMemoryDb } from './helpers/studioMongo.js';

const TEST_KEY = randomBytes(32).toString('hex');
const TENANT = 'tenant-studio-a';
const OTHER_TENANT = 'tenant-studio-b';
const USER = 'user-studio-1';

function auth(tenantId = TENANT) {
  return {
    userId: USER,
    tenantId,
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'studio@example.test',
    displayName: 'Studio User',
    roleName: 'Admin',
    clearance: 'INTERNAL',
    permissions: ['studio:manage', 'studio:run'],
  } as any;
}

let mem: ReturnType<typeof makeInMemoryDb>;

beforeEach(() => {
  mem = makeInMemoryDb();
  getDbMock.mockImplementation((...args: unknown[]) => (mem.getDbMock as any)(...args));
  (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = TEST_KEY;
  (config as Record<string, unknown>).SYTELINE_BASE_URL = '';
  (config as Record<string, unknown>).SYTELINE_API_TOKEN = '';
});

function coll(name: string) {
  return mem.store[name] ?? [];
}

describe('assertSecureBaseUrl', () => {
  it('accepts https', () => {
    expect(() => assertSecureBaseUrl('https://syteline.example.com')).not.toThrow();
  });
  it('accepts loopback http', () => {
    expect(() => assertSecureBaseUrl('http://localhost:8080')).not.toThrow();
    expect(() => assertSecureBaseUrl('http://127.0.0.1:8080')).not.toThrow();
  });
  it('rejects non-loopback http', () => {
    expect(() => assertSecureBaseUrl('http://syteline.example.com')).toThrow(/HTTPS/);
  });
  it('rejects garbage', () => {
    expect(() => assertSecureBaseUrl('not a url')).toThrow();
  });
});

describe('createConnection', () => {
  it('persists the token encrypted and never returns it in cleartext', async () => {
    const view = await createConnection(auth(), {
      name: 'TRN',
      environment: 'TRN',
      baseUrl: 'https://syteline.example.com/',
      token: 'super-secret-token',
    });
    expect(view.name).toBe('TRN');
    expect(view.baseUrl).toBe('https://syteline.example.com');
    expect(view.envBacked).toBe(false);
    expect(JSON.stringify(view)).not.toContain('super-secret-token');

    const docs = coll('studio_connections');
    expect(docs).toHaveLength(1);
    const stored = docs[0]!;
    expect(stored.encryptedToken).toMatchObject({ alg: 'aes-256-gcm' });
    expect(JSON.stringify(stored)).not.toContain('super-secret-token');
  });

  it('rejects duplicate names case-insensitively per tenant', async () => {
    await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' });
    await expect(
      createConnection(auth(), { name: 'trn', environment: 'PRD', baseUrl: 'https://b.example.com', token: 't2' })
    ).rejects.toMatchObject({ statusCode: 409 });
    // A different tenant may reuse the name.
    const other = await createConnection(auth(OTHER_TENANT), { name: 'trn', environment: 'TRN', baseUrl: 'https://c.example.com', token: 't3' });
    expect(other.name).toBe('trn');
  });

  it('rejects the reserved name "default"', async () => {
    await expect(
      createConnection(auth(), { name: 'Default', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' })
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('list/get', () => {
  it('lists the env-backed default first when configured', async () => {
    (config as Record<string, unknown>).SYTELINE_BASE_URL = 'https://env.example.com';
    (config as Record<string, unknown>).SYTELINE_API_TOKEN = 'env-token';
    await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' });
    const items = await listConnections(auth());
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toBe(DEFAULT_CONNECTION_ID);
    expect(items[0]!.envBacked).toBe(true);
    expect(JSON.stringify(items)).not.toContain('env-token');
  });

  it('omits the default when the env pair is unset', async () => {
    const items = await listConnections(auth());
    expect(items).toHaveLength(0);
  });

  it('is tenant-scoped', async () => {
    await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' });
    expect(await listConnections(auth(OTHER_TENANT))).toHaveLength(0);
    const view = await getConnectionView(OTHER_TENANT, coll('studio_connections')[0]!._id);
    expect(view).toBeNull();
  });
});

describe('update/delete', () => {
  it('updates name/environment/baseUrl and rotates the token', async () => {
    const created = await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 'old' });
    const before = coll('studio_connections')[0]!.encryptedToken.ciphertext;
    const updated = await updateConnection(auth(), created.id, {
      name: 'TRN2',
      baseUrl: 'https://b.example.com',
      token: 'new',
    });
    expect(updated!.name).toBe('TRN2');
    expect(updated!.baseUrl).toBe('https://b.example.com');
    const after = coll('studio_connections')[0]!.encryptedToken.ciphertext;
    expect(after).not.toBe(before);
    // Without a token field the ciphertext is untouched.
    await updateConnection(auth(), created.id, { environment: 'PRD' });
    expect(coll('studio_connections')[0]!.encryptedToken.ciphertext).toBe(after);
  });

  it('refuses to update or delete the env-backed default', async () => {
    await expect(updateConnection(auth(), DEFAULT_CONNECTION_ID, { name: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(deleteConnection(auth(), DEFAULT_CONNECTION_ID)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('deletes a stored connection', async () => {
    const created = await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' });
    expect(await deleteConnection(auth(), created.id)).toBe(true);
    expect(coll('studio_connections')).toHaveLength(0);
    expect(await deleteConnection(auth(), created.id)).toBe(false);
  });
});

describe('resolveConnectionTarget', () => {
  it('decrypts a stored token into a zero-fillable buffer', async () => {
    const created = await createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 'decrypt-me' });
    const target = await resolveConnectionTarget(TENANT, created.id);
    expect(target.token.toString('utf8')).toBe('decrypt-me');
    target.token.fill(0);
    expect(target.token.toString('utf8')).not.toBe('decrypt-me');
  });

  it('resolves the env-backed default from config', async () => {
    (config as Record<string, unknown>).SYTELINE_BASE_URL = 'https://env.example.com';
    (config as Record<string, unknown>).SYTELINE_API_TOKEN = 'env-token';
    const target = await resolveConnectionTarget(TENANT, DEFAULT_CONNECTION_ID);
    expect(target.envBacked).toBe(true);
    expect(target.token.toString('utf8')).toBe('env-token');
    target.token.fill(0);
  });

  it('409s honestly when the connection is not connected', async () => {
    await expect(resolveConnectionTarget(TENANT, 'nope')).rejects.toMatchObject({ statusCode: 409 });
    await expect(resolveConnectionTarget(TENANT, DEFAULT_CONNECTION_ID)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STUDIO_CONNECTION_NOT_CONFIGURED',
    });
  });

  it('fails closed when the credential key is absent', async () => {
    (config as Record<string, unknown>).CREDENTIAL_STORE_KEY = '';
    await expect(
      createConnection(auth(), { name: 'TRN', environment: 'TRN', baseUrl: 'https://a.example.com', token: 't1' })
    ).rejects.toThrow(/CREDENTIAL_STORE_KEY/);
  });
});
