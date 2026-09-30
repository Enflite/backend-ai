/**
 * credentialStore.ts — per-user encrypted SyteLine UI credential storage.
 *
 * Mongo collection `syteline_credentials`, tenant-scoped, one document per
 * user (save = rotate/upsert). The username is stored in cleartext (an
 * identifier, used for labeling and audit); the password is AES-256-GCM
 * encrypted via credentialCrypto and NEVER appears in cleartext — not in
 * the database, not in logs, not in tool output, not in audit events.
 *
 * `userId` always comes from the caller's AuthContext, never from tool
 * arguments: users can only ever save/read/delete their OWN credentials
 * (no cross-user impersonation).
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getDb } from '../../db/mongo.js';
import { recordAudit } from '../../audit/audit.js';
import { Errors } from '../../errors.js';
import { config } from '../../config.js';
import type { AuthContext } from '../../authz/permissions.js';
import {
  decryptCredential,
  encryptCredential,
  resolveCredentialStoreKey,
  type EncryptedCredential,
} from '../../secrets/credentialCrypto.js';

export const CREDENTIALS_COLLECTION = 'syteline_credentials';

const usernameSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._@\\-]+$/);
const passwordSchema = z.string().min(1).max(512);
const labelSchema = z.string().trim().min(1).max(80);

export interface SytelineCredentialDoc {
  _id: string;
  tenantId: string;
  userId: string;
  username: string;
  encryptedPassword: EncryptedCredential;
  label?: string;
  createdAt: Date;
  updatedAt: Date;
  lastUsedAt?: Date;
}

export interface CredentialSummary {
  username: string;
  label?: string;
  updatedAt: Date;
  lastUsedAt?: Date;
}

/** Collection accessor (tenant filtering is applied per-query, not here). */
async function collection() {
  const db = await getDb();
  return db.collection<SytelineCredentialDoc>(CREDENTIALS_COLLECTION);
}

/**
 * Save (or rotate) the caller's SyteLine UI credentials. Destructive-gated
 * at the tool layer; here the upsert is per (tenantId, userId).
 */
export async function saveCredential(
  auth: AuthContext,
  username: string,
  password: string,
  label?: string,
  requestId?: string,
): Promise<CredentialSummary> {
  const parsedUsername = usernameSchema.safeParse(username);
  if (!parsedUsername.success) throw Errors.badRequest('INVALID_USERNAME', 'Username is invalid');
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedPassword.success) throw Errors.badRequest('INVALID_PASSWORD', 'Password is invalid');
  const parsedLabel = label === undefined ? undefined : labelSchema.safeParse(label);
  if (parsedLabel && !parsedLabel.success) throw Errors.badRequest('INVALID_LABEL', 'Label is invalid');

  // Fail closed when no usable key is configured: never store plaintext.
  const key = resolveCredentialStoreKey();
  const encryptedPassword = encryptCredential(key, parsedPassword.data);

  const now = new Date();
  const coll = await collection();
  const existing = await coll.findOne({ tenantId: auth.tenantId, userId: auth.userId });
  const doc: SytelineCredentialDoc = {
    _id: existing?._id ?? randomUUID(),
    tenantId: auth.tenantId,
    userId: auth.userId,
    username: parsedUsername.data,
    encryptedPassword,
    ...(parsedLabel?.data ? { label: parsedLabel.data } : {}),
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
  };
  await coll.replaceOne(
    { tenantId: auth.tenantId, userId: auth.userId },
    doc,
    { upsert: true },
  );
  // Audit carries the username only — never secret material.
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    requestId,
    action: 'SYTELINE_CREDENTIAL_SAVED',
    success: true,
    metadata: { username: parsedUsername.data },
  });
  return {
    username: doc.username,
    ...(doc.label ? { label: doc.label } : {}),
    updatedAt: doc.updatedAt,
    ...(doc.lastUsedAt ? { lastUsedAt: doc.lastUsedAt } : {}),
  };
}

/** Revoke the caller's stored credentials. Returns true when any existed. */
export async function deleteCredential(
  auth: AuthContext,
  requestId?: string,
): Promise<boolean> {
  const coll = await collection();
  const result = await coll.deleteOne({ tenantId: auth.tenantId, userId: auth.userId });
  const deleted = (result.deletedCount ?? 0) > 0;
  await recordAudit({
    tenantId: auth.tenantId,
    userId: auth.userId,
    requestId,
    action: 'SYTELINE_CREDENTIAL_DELETED',
    success: true,
    metadata: { hadCredentials: deleted },
  });
  return deleted;
}

/** List the caller's stored credentials — identifiers only, never secrets. */
export async function listCredentials(auth: AuthContext): Promise<CredentialSummary[]> {
  const coll = await collection();
  const docs = await coll
    .find({ tenantId: auth.tenantId, userId: auth.userId })
    .project({ username: 1, label: 1, updatedAt: 1, lastUsedAt: 1 })
    .toArray();
  return docs.map((doc) => ({
    username: doc.username,
    ...(doc.label ? { label: doc.label } : {}),
    updatedAt: doc.updatedAt,
    ...(doc.lastUsedAt ? { lastUsedAt: doc.lastUsedAt } : {}),
  }));
}

export interface ResolvedUiCredentials {
  username: string;
  /**
   * Decrypted password as a Buffer. The caller MUST zero-fill it
   * (`password.fill(0)`) once the single login use completes.
   */
  password: Buffer;
  /** 'stored' = the user's own saved creds, 'service' = tenant env fallback. */
  source: 'stored' | 'service';
}

/**
 * Resolve the credentials to log in with, in precedence order:
 *  1. the caller's own stored credentials (decrypted in memory);
 *  2. the tenant service account from SYTELINE_UI_USERNAME /
 *     SYTELINE_UI_PASSWORD env, when set.
 * Returns null when neither exists. Never logs or returns plaintext.
 */
export async function resolveUiCredentials(
  auth: AuthContext,
): Promise<ResolvedUiCredentials | null> {
  const coll = await collection();
  const doc = await coll.findOne({ tenantId: auth.tenantId, userId: auth.userId });
  if (doc) {
    const key = resolveCredentialStoreKey();
    const password = decryptCredential(key, doc.encryptedPassword);
    await coll.updateOne(
      { _id: doc._id, tenantId: auth.tenantId },
      { $set: { lastUsedAt: new Date() } },
    );
    return { username: doc.username, password, source: 'stored' };
  }
  const username = config.SYTELINE_UI_USERNAME;
  const password = config.SYTELINE_UI_PASSWORD;
  if (username && password) {
    return { username, password: Buffer.from(password, 'utf8'), source: 'service' };
  }
  return null;
}
