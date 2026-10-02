/**
 * store.ts — named SyteLine connection persistence (`studio_connections`).
 *
 * Tenant-scoped CRUD. The bearer token is AES-256-GCM encrypted at rest via
 * the shared credentialCrypto helper (the same precedent as the SyteLine UI
 * credential store) and is NEVER returned in cleartext — not from the
 * store, not in logs, not in audit events. Decryption happens only at
 * single request-time use, and the buffer is zero-filled immediately after.
 *
 * The env-backed "default" connection (SYTELINE_BASE_URL /
 * SYTELINE_API_TOKEN) is NOT persisted: resolveConnectionTarget() builds it
 * from config so current behavior keeps working with zero migration, and the
 * stored routes treat it as read-only.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import type { AuthContext } from '../../authz/permissions.js';
import {
  decryptCredential,
  encryptCredential,
  resolveCredentialStoreKey,
} from '../../secrets/credentialCrypto.js';
import {
  connectionCreateSchema,
  connectionUpdateSchema,
  DEFAULT_CONNECTION_ID,
  type ConnectionPublicView,
  type StudioConnectionDoc,
} from '../types.js';

export const CONNECTIONS_COLLECTION = 'studio_connections';

/** Enforced at write time: same transport-security rule as the SyteLine
 *  adapter — plaintext HTTP only for explicit loopback development hosts. */
export function assertSecureBaseUrl(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw Errors.badRequest('INVALID_BASE_URL', 'baseUrl is not a valid URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw Errors.badRequest('INVALID_BASE_URL', 'baseUrl must use http(s)');
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (parsed.protocol !== 'https:' && !isLoopback) {
    throw Errors.badRequest(
      'INSECURE_BASE_URL',
      `Connection base URL must use HTTPS; plaintext HTTP to ${host} is allowed only for loopback development hosts`
    );
  }
}

async function collection() {
  const db = await getDb();
  return db.collection<StudioConnectionDoc>(CONNECTIONS_COLLECTION);
}

/** Case-insensitive per-tenant name lookup (anchored regex, so 'TRN' and
 *  'trn' collide as they should for a human-named connection). */
async function findByName(tenantId: string, name: string): Promise<StudioConnectionDoc | null> {
  const coll = await collection();
  return coll.findOne({
    tenantId,
    name: { $regex: `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' },
  });
}

export function toPublicView(doc: StudioConnectionDoc): ConnectionPublicView {
  return {
    id: doc._id,
    name: doc.name,
    environment: doc.environment,
    baseUrl: doc.baseUrl,
    hasToken: true,
    ...(doc.probe ? { probe: doc.probe } : {}),
    createdBy: doc.createdBy,
    createdAt: doc.createdAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
    ...(doc.lastTestedAt ? { lastTestedAt: doc.lastTestedAt.toISOString() } : {}),
    envBacked: false,
  };
}

/** The env-backed default connection as a public view (no Mongo row). */
function defaultConnectionView(): ConnectionPublicView | null {
  if (!config.SYTELINE_BASE_URL) return null;
  const now = new Date().toISOString();
  return {
    id: DEFAULT_CONNECTION_ID,
    name: 'default',
    environment: 'ENV',
    baseUrl: config.SYTELINE_BASE_URL,
    hasToken: true,
    createdBy: 'env',
    createdAt: now,
    updatedAt: now,
    envBacked: true,
  };
}

export async function createConnection(
  auth: AuthContext,
  input: z.infer<typeof connectionCreateSchema>
): Promise<ConnectionPublicView> {
  const parsed = connectionCreateSchema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid connection input', parsed.error.flatten());
  assertSecureBaseUrl(parsed.data.baseUrl);
  if (parsed.data.name.toLowerCase() === DEFAULT_CONNECTION_ID) {
    throw Errors.badRequest('RESERVED_NAME', `'${DEFAULT_CONNECTION_ID}' is a reserved connection name`);
  }
  const existing = await findByName(auth.tenantId, parsed.data.name);
  if (existing) {
    throw Errors.conflict('CONNECTION_NAME_TAKEN', `A connection named '${parsed.data.name}' already exists`);
  }
  // Fail closed when no usable key is configured: never store plaintext.
  const key = resolveCredentialStoreKey();
  const encryptedToken = encryptCredential(key, parsed.data.token);
  const now = new Date();
  const doc: StudioConnectionDoc = {
    _id: randomUUID(),
    tenantId: auth.tenantId,
    name: parsed.data.name,
    environment: parsed.data.environment,
    baseUrl: parsed.data.baseUrl.replace(/\/+$/, ''),
    encryptedToken,
    createdBy: auth.userId,
    createdAt: now,
    updatedAt: now,
  };
  await (await collection()).insertOne(doc);
  return toPublicView(doc);
}

export async function listConnections(auth: AuthContext): Promise<ConnectionPublicView[]> {
  const coll = await collection();
  const docs = await coll
    .find({ tenantId: auth.tenantId })
    .project({ encryptedToken: 0 })
    .sort({ createdAt: -1 })
    .toArray();
  const items = docs.map((doc) => toPublicView(doc as StudioConnectionDoc));
  const def = defaultConnectionView();
  return def ? [def, ...items] : items;
}

export async function getConnection(tenantId: string, id: string): Promise<StudioConnectionDoc | null> {
  if (id === DEFAULT_CONNECTION_ID) return null;
  const coll = await collection();
  return coll.findOne({ _id: id, tenantId });
}

export async function getConnectionView(tenantId: string, id: string): Promise<ConnectionPublicView | null> {
  if (id === DEFAULT_CONNECTION_ID) return defaultConnectionView();
  const doc = await getConnection(tenantId, id);
  return doc ? toPublicView(doc) : null;
}

export async function updateConnection(
  auth: AuthContext,
  id: string,
  input: z.infer<typeof connectionUpdateSchema>
): Promise<ConnectionPublicView | null> {
  const parsed = connectionUpdateSchema.safeParse(input);
  if (!parsed.success) throw Errors.badRequest('VALIDATION_ERROR', 'Invalid connection input', parsed.error.flatten());
  if (id === DEFAULT_CONNECTION_ID) {
    throw Errors.badRequest('READ_ONLY_CONNECTION', 'The default connection is configured via environment and cannot be updated');
  }
  const doc = await getConnection(auth.tenantId, id);
  if (!doc) return null;
  const data = parsed.data;
  if (data.name !== undefined && data.name.toLowerCase() !== doc.name.toLowerCase()) {
    if (data.name.toLowerCase() === DEFAULT_CONNECTION_ID) {
      throw Errors.badRequest('RESERVED_NAME', `'${DEFAULT_CONNECTION_ID}' is a reserved connection name`);
    }
    const clash = await findByName(auth.tenantId, data.name);
    if (clash && clash._id !== doc._id) {
      throw Errors.conflict('CONNECTION_NAME_TAKEN', `A connection named '${data.name}' already exists`);
    }
  }
  const update: Partial<StudioConnectionDoc> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name;
  if (data.environment !== undefined) update.environment = data.environment;
  if (data.baseUrl !== undefined) {
    assertSecureBaseUrl(data.baseUrl);
    update.baseUrl = data.baseUrl.replace(/\/+$/, '');
  }
  if (data.token !== undefined) {
    const key = resolveCredentialStoreKey();
    update.encryptedToken = encryptCredential(key, data.token);
  }
  const coll = await collection();
  await coll.updateOne({ _id: doc._id, tenantId: auth.tenantId }, { $set: update });
  const updated = await getConnection(auth.tenantId, id);
  return updated ? toPublicView(updated) : null;
}

export async function deleteConnection(auth: AuthContext, id: string): Promise<boolean> {
  if (id === DEFAULT_CONNECTION_ID) {
    throw Errors.badRequest('READ_ONLY_CONNECTION', 'The default connection is configured via environment and cannot be deleted');
  }
  const coll = await collection();
  const result = await coll.deleteOne({ _id: id, tenantId: auth.tenantId });
  return (result.deletedCount ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Request-time resolution: the caller gets a zero-fillable Buffer and MUST
// fill(0) it when the single upstream request completes.
// ---------------------------------------------------------------------------

export interface ResolvedConnection {
  id: string;
  name: string;
  environment: string;
  baseUrl: string;
  token: Buffer;
  envBacked: boolean;
}

/**
 * Resolve a connection id to request-time material (baseUrl + decrypted
 * token). The token is decrypted in memory ONLY for the single request;
 * the caller must zero-fill the buffer in a finally block. Throws a
 * 409 (not configured / not found) — an honest "not connected" — rather
 * than a 500, and never leaks the token in the error.
 */
export async function resolveConnectionTarget(
  tenantId: string,
  connectionId: string
): Promise<ResolvedConnection> {
  if (connectionId === DEFAULT_CONNECTION_ID) {
    const baseUrl = config.SYTELINE_BASE_URL;
    const token = config.SYTELINE_API_TOKEN;
    if (!baseUrl || !token) {
      throw Errors.conflict(
        'STUDIO_CONNECTION_NOT_CONFIGURED',
        "The default connection is not configured (SYTELINE_BASE_URL / SYTELINE_API_TOKEN are unset). Create a named connection under /api/v1/studio/connections instead."
      );
    }
    assertSecureBaseUrl(baseUrl);
    return {
      id: DEFAULT_CONNECTION_ID,
      name: 'default',
      environment: 'ENV',
      baseUrl: baseUrl.replace(/\/+$/, ''),
      token: Buffer.from(token, 'utf8'),
      envBacked: true,
    };
  }
  const doc = await getConnection(tenantId, connectionId);
  if (!doc) {
    throw Errors.conflict(
      'STUDIO_CONNECTION_NOT_FOUND',
      `Connection '${connectionId}' does not exist in this tenant. Create it under /api/v1/studio/connections first.`
    );
  }
  const key = resolveCredentialStoreKey();
  const token = decryptCredential(key, doc.encryptedToken);
  return {
    id: doc._id,
    name: doc.name,
    environment: doc.environment,
    baseUrl: doc.baseUrl,
    token,
    envBacked: false,
  };
}

/** Persist fresh probe results on a stored (non-env) connection. */
export async function recordProbeResult(
  tenantId: string,
  id: string,
  probe: NonNullable<StudioConnectionDoc['probe']>
): Promise<void> {
  if (id === DEFAULT_CONNECTION_ID) return;
  const coll = await collection();
  await coll.updateOne(
    { _id: id, tenantId },
    { $set: { probe, lastTestedAt: new Date(), updatedAt: new Date() } }
  );
}
