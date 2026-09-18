/**
 * rlsEnforcement.test.ts — Row-Level Security enforcement verification.
 *
 * WHAT THIS FILE PROVES (with mocks, deterministic, no live Postgres):
 *  - `withTenant`/`tenantQuery` in src/db/pool.ts really do set
 *    `app.tenant_id` via `SET CONFIG` before any tenant query runs, inside a
 *    transaction (behavioral, via a stubbed `pg` Pool).
 *  - No production source file issues tenant-table queries through the raw
 *    `query()` helper without a tenant context (static scan). The single
 *    exception is audit.ts, whose raw path is provably guarded by a
 *    `tenantId ? tenantQuery : query` ternary for tenant-less auth-failure
 *    records.
 *  - Migration 013 forces RLS on every tenant table, and the tenant_isolation
 *    policies in 003/004 predicate on `current_setting('app.tenant_id')`.
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL POSTGRESQL:
 *  - That Postgres actually enforces the tenant_isolation policy (e.g. a query
 *    issued with app.tenant_id unset, or set to tenant B, returns zero of
 *    tenant A's rows — including when the runtime role OWNS the tables, which
 *    is exactly what FORCE ROW LEVEL SECURITY addresses).
 *  - That WITH CHECK blocks cross-tenant INSERTs.
 *  - That every migration in the chain applies cleanly on a real cluster.
 *  These need a live-database CI job (e.g. `migrate` against ephemeral
 *  Postgres, then attempt cross-tenant reads as the app role). Nothing below
 *  may be read as claiming those live checks passed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { recorded, connections, FakePool, poolClientOf } = vi.hoisted(() => {
  const recorded: Array<{ kind: string; text?: string; params?: unknown[] }> = [];
  const connections: Array<{ connectionString?: string }> = [];
  const clients: unknown[] = [];

  class FakeClient {
    queries: Array<{ text: string; params?: unknown[] }> = [];
    released = false;
    async query(text: string, params?: unknown[]) {
      this.queries.push({ text, params });
      recorded.push({ kind: 'query', text, params });
      return { rows: [], rowCount: 0 };
    }
    release() {
      this.released = true;
      recorded.push({ kind: 'release' });
    }
  }
  class FakePool {
    client = new FakeClient();
    constructor(opts?: { connectionString?: string }) {
      connections.push({ connectionString: opts?.connectionString });
      clients.push(this.client);
    }
    async connect() {
      recorded.push({ kind: 'connect' });
      return this.client;
    }
    async query(text: string, params?: unknown[]) {
      recorded.push({ kind: 'pool.query', text, params });
      return { rows: [], rowCount: 0 };
    }
  }
  return {
    recorded,
    connections,
    FakePool,
    poolClientOf: (pool: unknown) => (pool as { client: FakeClient }).client,
  };
});

vi.mock('pg', () => ({
  default: { Pool: FakePool },
  Pool: FakePool,
  __esModule: true,
}));

import { query, withTx, withTenant, tenantQuery, pool } from '../src/db/pool.js';

// Silence unused-import warnings for helpers exercised indirectly.
void query;
void withTx;

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const MIGRATIONS = join(SRC, 'db', 'migrations');

function readSource(relativePath: string): string {
  return readFileSync(join(SRC, relativePath), 'utf8');
}

function allSourceFiles(dir = SRC): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...allSourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

beforeEach(() => {
  recorded.length = 0;
  connections.length = 0;
});

describe('tenant context is set before any tenant query runs', () => {
  it('withTenant sets app.tenant_id inside a transaction before the callback', async () => {
    const seen: string[] = [];
    await withTenant('tenant-x', async (client) => {
      seen.push('callback');
      await client.query('SELECT 1');
    });
    const kinds = recorded.map((r) => (r.kind === 'query' ? r.text : r.kind));
    expect(kinds[0]).toBe('connect');
    expect(kinds[1]).toBe('BEGIN');
    expect(kinds[2]).toBe("SELECT set_config('app.tenant_id', $1, true)");
    expect(kinds[3]).toBe('SELECT 1');
    expect(kinds[kinds.length - 2]).toBe('COMMIT');
    expect(kinds[kinds.length - 1]).toBe('release');

    const setConfig = recorded.find((r) => r.text === "SELECT set_config('app.tenant_id', $1, true)");
    expect(setConfig!.params).toEqual(['tenant-x']);
    // The tenant id is bound as a parameter — never interpolated into SQL.
    expect(setConfig!.text).not.toContain('tenant-x');
    // The callback ran exactly once, strictly after the tenant context was set.
    expect(seen).toEqual(['callback']);
    expect(recorded.indexOf(setConfig!)).toBeLessThan(
      recorded.findIndex((r) => r.text === 'SELECT 1')
    );
    expect(poolClientOf(pool).released).toBe(true);
  });

  it('tenantQuery routes through withTenant with the caller-supplied tenant', async () => {
    await tenantQuery('tenant-y', 'SELECT * FROM conversations WHERE tenant_id = $1', ['tenant-y']);
    const setConfig = recorded.find((r) => r.text === "SELECT set_config('app.tenant_id', $1, true)");
    expect(setConfig).toBeDefined();
    expect(setConfig!.params).toEqual(['tenant-y']);
    const select = recorded.find((r) => r.text === 'SELECT * FROM conversations WHERE tenant_id = $1');
    expect(select).toBeDefined();
    // Ordering: set_config precedes the actual query.
    expect(recorded.indexOf(setConfig!)).toBeLessThan(recorded.indexOf(select!));
  });

  it('rolls back and releases the client when the tenant callback throws', async () => {
    await expect(
      withTenant('tenant-z', async () => {
        throw new Error('callback exploded');
      })
    ).rejects.toThrow('callback exploded');
    const kinds = recorded.map((r) => (r.kind === 'query' ? r.text : r.kind));
    expect(kinds).toContain('ROLLBACK');
    expect(kinds).not.toContain('COMMIT');
    expect(kinds[kinds.length - 1]).toBe('release');
  });

  it('each withTenant call gets its own tenant context (no cross-call leakage)', async () => {
    await withTenant('tenant-a', async (client) => { await client.query('SELECT 1'); });
    await withTenant('tenant-b', async (client) => { await client.query('SELECT 1'); });
    const setConfigs = recorded.filter((r) => r.text === "SELECT set_config('app.tenant_id', $1, true)");
    expect(setConfigs.map((r) => r.params)).toEqual([['tenant-a'], ['tenant-b']]);
  });
});

describe('static: raw query() is never used on tenant tables', () => {
  // The runtime `query` export issues SQL with NO tenant context, so it must
  // never touch a table that RLS protects. Each file below imports it for a
  // documented, tenant-free purpose:
  //  - audit/audit.ts: tenant-less authentication-failure records, behind a
  //    `tenantId ? tenantQuery : query` guard (asserted separately).
  //  - ai/gateway/routes.ts: model-admin routes read/write the `models`
  //    table, which is platform-level (no tenant_id, not RLS-protected);
  //    gated by requirePermission('model:manage').
  //  - auth/identityProvider.ts, auth/routes.ts: login flow reads `users`,
  //    `memberships`, `tenants`, `roles`, `permissions` — none carry RLS;
  //    session writes go through tenantQuery.
  //  - documents/queue.ts: `SELECT id FROM tenants` to fan out per-tenant
  //    ingestion; all tenant-table work uses tenantQuery(tenant.id, ...).
  //  - health.ts: `SELECT 1` liveness probe.
  //  - server.ts: startup pg_roles check that REFUSES superuser/BYPASSRLS
  //    roles (a BYPASSRLS role would silently defeat even FORCE RLS).
  const RAW_QUERY_ALLOWLIST = new Set([
    'audit/audit.ts',
    'ai/gateway/routes.ts',
    'auth/identityProvider.ts',
    'auth/routes.ts',
    'documents/queue.ts',
    'health.ts',
    'server.ts',
  ]);
  const TENANT_TABLES = [
    'conversations', 'messages', 'audit_events', 'sessions', 'model_access',
    'documents', 'document_permissions', 'document_chunks', 'tool_executions',
    'departments', 'security_groups', 'department_memberships',
    'security_group_memberships', 'document_ingestion_jobs',
  ];

  function rawQueryImporters(): string[] {
    const out: string[] = [];
    for (const file of allSourceFiles()) {
      const relative = file.slice(SRC.length + 1);
      if (relative === 'db/pool.ts') continue;
      const content = readFileSync(file, 'utf8');
      const importMatch = content.match(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*db\/pool\.js['"]/);
      if (!importMatch) continue;
      const names = importMatch[1]!.split(',').map((n) => n.trim().split(/\s+as\s+/)[0]);
      if (names.includes('query')) out.push(relative);
    }
    return out;
  }

  /**
   * SQL string literals handed to the RAW query() helper (tenantQuery /
   * withTenant calls are scrubbed first). A tenant table may appear in a
   * file's SQL only when the statement runs through a tenant-scoped helper;
   * these are the statements that run with NO tenant context, so none of
   * them may name a tenant table.
   */
  function rawQuerySqlStrings(content: string, extraCallees: string[] = []): string[] {
    const scrubbed = content.replace(/tenantQuery/g, 'XX').replace(/withTenant/g, 'XX');
    const out: string[] = [];
    const names = ['query', ...extraCallees].join('|');
    // Matches query<...>(`sql`), query('sql'), query("sql") — but not tenantQuery.
    const re = new RegExp(
      '(?<![A-Za-z0-9_$])(?:' + names + ')\\s*(?:<[^<>]*>)?\\s*\\(\\s*' +
        '(`(?:[^`\\\\]|\\\\.)*`|\'(?:[^\'\\\\]|\\\\.)*\'|"(?:[^"\\\\]|\\\\.)*")',
      'g'
    );
    let m: RegExpExecArray | null;
    while ((m = re.exec(scrubbed)) !== null) out.push(m[1]!);
    return out;
  }

  it('no file outside the documented allowlist imports the raw query helper', () => {
    const importers = rawQueryImporters();
    const unexpected = importers.filter((f) => !RAW_QUERY_ALLOWLIST.has(f));
    expect(unexpected).toEqual([]);
    // The allowlist must stay exact: every entry must still import query,
    // otherwise a stale entry hides a real change.
    for (const allowed of RAW_QUERY_ALLOWLIST) {
      expect(importers, `${allowed} no longer imports query — update the allowlist`).toContain(allowed);
    }
  });

  it('allowlisted raw-query users never issue DML against tenant tables', () => {
    for (const relative of RAW_QUERY_ALLOWLIST) {
      const content = readFileSync(join(SRC, relative), 'utf8');
      // audit.ts aliases the helper: `const execute = ... : query` then `execute(...)`.
      const statements = rawQuerySqlStrings(content, relative === 'audit/audit.ts' ? ['execute'] : []);
      expect(statements.length, `${relative} allowlist entry has no raw query() SQL?`).toBeGreaterThan(0);
      for (const sql of statements) {
        for (const table of TENANT_TABLES) {
          // audit.ts's own INSERT INTO audit_events is the guarded path
          // (tenantQuery when a tenant is known — asserted above).
          if (relative === 'audit/audit.ts' && table === 'audit_events') continue;
          expect(
            new RegExp(`\\b${table}\\b`, 'i').test(sql),
            `${relative} runs context-free SQL against tenant table ${table}`
          ).toBe(false);
        }
      }
    }
  });

  it('audit.ts falls back to raw query only when no tenant is known', () => {
    const content = readSource('audit/audit.ts');
    // recordAudit: tenant-scoped insert when a tenant is known, raw pool
    // query only when none is.
    expect(content).toContain('await tenantQuery(input.tenantId, INSERT_AUDIT_SQL, params)');
    expect(content).toContain('await query(INSERT_AUDIT_SQL, params)');
    // recordAuditInTx: sets the RLS tenant context inside the transaction
    // when a tenant is known, so the WITH CHECK policy sees the right tenant.
    expect(content).toContain('await client.query("SELECT set_config(\'app.tenant_id\', $1, true)", [input.tenantId])');
  });

  it('server refuses to boot on a superuser or BYPASSRLS role', () => {
    // Even FORCE ROW LEVEL SECURITY is bypassed by superuser/BYPASSRLS, so
    // the process must not serve traffic on such a role in production.
    const content = readSource('server.ts');
    expect(content).toContain('rolsuper');
    expect(content).toContain('rolbypassrl');
    expect(content).toMatch(/rolsuper \|\| role\.rolbypassrl[\s\S]{0,300}process\.exit\(1\)/);
  });

  it('no source file calls pool.query directly (except the migration runner)', () => {
    // db/migrate.ts applies DDL as the migration role; migrations must run
    // outside any tenant context by design.
    const ALLOWLIST = new Set(['db/migrate.ts']);
    const offenders: string[] = [];
    for (const file of allSourceFiles()) {
      const relative = file.slice(SRC.length + 1);
      if (relative === 'db/pool.ts' || ALLOWLIST.has(relative)) continue;
      const content = readFileSync(file, 'utf8');
      if (/\bpool\.query\s*\(/.test(content)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});

describe('static: migrations enforce RLS on every tenant table', () => {
  function tablesInForceRls(sql: string): string[] {
    const arrayMatch = sql.match(/ARRAY\s+ARRAY\[([\s\S]*?)\]/);
    expect(arrayMatch, '013_force_rls.sql must enumerate tables in ARRAY[...] syntax').toBeTruthy();
    return [...arrayMatch![1]!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
  }

  it('013_force_rls.sql forces RLS on the full tenant-table inventory', () => {
    const sql = readFileSync(join(MIGRATIONS, '013_force_rls.sql'), 'utf8');
    expect(sql).toContain('FORCE ROW LEVEL SECURITY');
    const tables = tablesInForceRls(sql);
    for (const required of [
      'conversations', 'messages', 'audit_events', 'sessions', 'model_access',
      'documents', 'document_permissions', 'document_chunks', 'tool_executions',
      'departments', 'security_groups', 'department_memberships',
      'security_group_memberships', 'document_ingestion_jobs',
    ]) {
      expect(tables, `013 must force RLS on ${required}`).toContain(required);
    }
  });

  it('the tenant_isolation policies predicate on app.tenant_id', () => {
    for (const migration of ['003_enterprise_platform.sql', '004_secure_rag.sql']) {
      const raw = readFileSync(join(MIGRATIONS, migration), 'utf8');
      // The policy text is built with format(), so SQL quotes are doubled in
      // the migration source; normalize before asserting.
      const sql = raw.replaceAll("''", "'");
      expect(sql, `${migration} must define tenant_isolation policies`).toContain('CREATE POLICY tenant_isolation');
      expect(sql).toContain("current_setting('app.tenant_id'");
      // Both the read path (USING) and the write path (WITH CHECK) must be
      // tenant-bound; a USING-only policy would let a caller write rows for
      // another tenant.
      expect(sql).toContain('WITH CHECK');
    }
  });

  it('documents why FORCE (not just ENABLE) is required', () => {
    const sql = readFileSync(join(MIGRATIONS, '013_force_rls.sql'), 'utf8');
    expect(sql.toLowerCase()).toContain('owner');
  });
});
