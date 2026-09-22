import { MongoClient, Db, ClientSession } from 'mongodb';
import { config } from '../config.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function getClient(): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(config.MONGODB_URI);
    await client.connect();
  }
  return client;
}

export async function getDb(): Promise<Db> {
  if (!db) {
    const c = await getClient();
    db = c.db();
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
  }
}

/**
 * Run a callback inside a MongoDB multi-document transaction.
 * Replaces withTx (PostgreSQL). Atlas is a replica set, so transactions
 * are available.
 */
export async function withTx<T>(
  callback: (session: ClientSession, db: Db) => Promise<T>
): Promise<T> {
  const c = await getClient();
  const d = await getDb();
  const session = c.startSession();
  try {
    let result: T;
    await session.withTransaction(async () => {
      result = await callback(session, d);
    });
    return result!;
  } finally {
    await session.endSession();
  }
}

/**
 * Run a callback with tenant context. In MongoDB there is no RLS —
 * tenant isolation is enforced by application-level tenantId filters
 * on every query (ADR-004, ADR-014). This wrapper exists for API
 * compatibility; the tenantId is passed through for explicit filtering.
 */
export async function withTenant<T>(
  tenantId: string,
  callback: (db: Db, tenantId: string) => Promise<T>
): Promise<T> {
  const d = await getDb();
  return callback(d, tenantId);
}

/**
 * Single-operation helper with tenant context. Replaces tenantQuery.
 * Callers must include { tenantId } in their filter.
 */
export async function tenantOp<T>(
  tenantId: string,
  callback: (db: Db, tenantId: string) => Promise<T>
): Promise<T> {
  return withTenant(tenantId, callback);
}

/**
 * Multi-operation transaction with tenant context. Replaces withTenantTx.
 */
export async function withTenantTx<T>(
  tenantId: string,
  callback: (session: ClientSession, db: Db, tenantId: string) => Promise<T>
): Promise<T> {
  return withTx((session, db) => callback(session, db, tenantId));
}
