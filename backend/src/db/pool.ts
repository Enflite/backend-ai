import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
});

export async function query<T extends pg.QueryResultRow = any>(
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params);
}

export async function withTx<T>(
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function withTenant<T>(
  tenantId: string,
  callback: (client: pg.PoolClient) => Promise<T>
): Promise<T> {
  return withTx(async (client) => {
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
    return callback(client);
  });
}

export async function tenantQuery<T extends pg.QueryResultRow = any>(
  tenantId: string,
  text: string,
  params?: unknown[]
): Promise<pg.QueryResult<T>> {
  return withTenant(tenantId, (client) => client.query<T>(text, params));
}
