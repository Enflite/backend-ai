/**
 * memoryStore.test.ts — tenant-scoped user memory store.
 *
 * WHAT THIS FILE PROVES (mocks, deterministic, no live Postgres):
 *  - Every CRUD statement binds BOTH tenant_id and user_id from the
 *    caller's auth context — never from request input — so tenant A's
 *    context cannot produce a query that touches tenant B's rows.
 *  - Write-side classification is asserted against the caller's clearance
 *    (UNKNOWN fails closed via canAccessClassification).
 *  - A simulated isolated-database check: with tenantQuery faked to filter
 *    by the bound (tenant_id, user_id) params, a tenant-A caller never sees
 *    tenant-B rows.
 *
 * WHAT THIS FILE CANNOT PROVE — REQUIRES REAL POSTGRESQL:
 *  - That the RLS tenant_isolation policy actually blocks a query issued
 *    with a missing/mismatched app.tenant_id (migration 027), or that the
 *    migration chain applies cleanly. Those need a live-database CI job.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));

import {
  createMemory,
  deleteMemory,
  getMemory,
  listMemories,
  updateMemory,
  MemoryContext,
} from '../src/memory/store.js';

const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER_A1 = 'a1111111-1111-4111-8111-111111111111';
const USER_B1 = 'b1111111-1111-4111-8111-111111111111';

const CTX_A: MemoryContext = { tenantId: TENANT_A, userId: USER_A1, clearance: 'CONFIDENTIAL' };

function lastCall() {
  const calls = tenantQuery.mock.calls;
  return { tenant: calls[calls.length - 1]![0] as string, sql: calls[calls.length - 1]![1] as string, params: calls[calls.length - 1]![2] as unknown[] };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createMemory', () => {
  it('scopes the INSERT to the caller tenant and user', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1' }] });
    await createMemory(CTX_A, { fact: 'prefers concise summaries' });
    const { tenant, sql, params } = lastCall();
    expect(tenant).toBe(TENANT_A);
    expect(sql).toContain('INSERT INTO memory_facts');
    expect(sql).toMatch(/tenant_id[\s\S]*user_id/);
    expect(params[0]).toBe(TENANT_A);
    expect(params[1]).toBe(USER_A1);
    expect(params[2]).toBe('prefers concise summaries');
  });

  it('defaults classification to INTERNAL for non-PUBLIC clearances', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1' }] });
    await createMemory(CTX_A, { fact: 'x' });
    expect(lastCall().params[4]).toBe('INTERNAL');
  });

  it('defaults classification to PUBLIC for PUBLIC-cleared callers', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1' }] });
    await createMemory({ ...CTX_A, clearance: 'PUBLIC' }, { fact: 'x' });
    expect(lastCall().params[4]).toBe('PUBLIC');
  });

  it('rejects a classification above the caller clearance', async () => {
    await expect(
      createMemory({ ...CTX_A, clearance: 'PUBLIC' }, { fact: 'x', classification: 'CONFIDENTIAL' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
    expect(tenantQuery).not.toHaveBeenCalled();
  });

  it('rejects UNKNOWN classification (fails closed)', async () => {
    await expect(
      createMemory(CTX_A, { fact: 'x', classification: 'UNKNOWN' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
  });
});

describe('getMemory / listMemories', () => {
  it('getMemory predicates id, tenant_id, AND user_id', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1', fact: 'x' }] });
    const row = await getMemory(CTX_A, 'm1-id-uuid');
    expect(row.id).toBe('m1');
    const { sql, params } = lastCall();
    expect(sql).toMatch(/id = \$1[\s\S]*tenant_id = \$2[\s\S]*user_id = \$3/);
    expect(params).toEqual(['m1-id-uuid', TENANT_A, USER_A1]);
  });

  it('getMemory throws MEMORY_NOT_FOUND when another tenant owns the row', async () => {
    tenantQuery.mockResolvedValue({ rows: [] });
    await expect(getMemory(CTX_A, 'someone-elses-id')).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    });
    // The module asked for the caller's tenant+user — it cannot reach
    // another tenant's row even if the id is known.
    expect(lastCall().params).toEqual(['someone-elses-id', TENANT_A, USER_A1]);
  });

  it('listMemories scopes to tenant+user and orders most-recent-first', async () => {
    tenantQuery.mockResolvedValue({ rows: [] });
    await listMemories(CTX_A, { limit: 10, offset: 5 });
    const { sql, params } = lastCall();
    expect(sql).toContain('FROM memory_facts');
    expect(sql).toMatch(/tenant_id = \$1[\s\S]*user_id = \$2/);
    expect(sql).toContain('ORDER BY updated_at DESC');
    expect(params).toEqual([TENANT_A, USER_A1, 10, 5]);
  });

  it('listMemories supports a category filter', async () => {
    tenantQuery.mockResolvedValue({ rows: [] });
    await listMemories(CTX_A, { category: 'preference' });
    const { sql, params } = lastCall();
    expect(sql).toContain('category = $3');
    expect(params[2]).toBe('preference');
  });
});

describe('updateMemory / deleteMemory', () => {
  it('updateMemory predicates tenant+user and rejects over-clearance classification', async () => {
    tenantQuery.mockResolvedValue({ rows: [{ id: 'm1' }] });
    await updateMemory(CTX_A, 'm1', { fact: 'new text' });
    const { sql, params } = lastCall();
    expect(sql).toContain('UPDATE memory_facts');
    expect(sql).toMatch(/tenant_id = \$[\d]+[\s\S]*user_id = \$/);
    expect(params.slice(-3)).toEqual(['m1', TENANT_A, USER_A1]);

    await expect(
      updateMemory({ ...CTX_A, clearance: 'INTERNAL' }, 'm1', { classification: 'CUI' })
    ).rejects.toMatchObject({ code: 'CLASSIFICATION_DENIED' });
  });

  it('updateMemory with no fields is rejected', async () => {
    await expect(updateMemory(CTX_A, 'm1', {})).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
  });

  it('updateMemory throws MEMORY_NOT_FOUND for another user’s row', async () => {
    tenantQuery.mockResolvedValue({ rows: [] });
    await expect(updateMemory(CTX_A, 'm1', { fact: 'x' })).rejects.toMatchObject({
      code: 'MEMORY_NOT_FOUND',
    });
  });

  it('deleteMemory predicates tenant+user and throws when nothing was deleted', async () => {
    tenantQuery.mockResolvedValue({ rowCount: 1 });
    await deleteMemory(CTX_A, 'm1');
    const { sql, params } = lastCall();
    expect(sql).toMatch(/DELETE FROM memory_facts[\s\S]*tenant_id = \$2[\s\S]*user_id = \$3/);
    expect(params).toEqual(['m1', TENANT_A, USER_A1]);

    tenantQuery.mockResolvedValue({ rowCount: 0 });
    await expect(deleteMemory(CTX_A, 'm1')).rejects.toMatchObject({ code: 'MEMORY_NOT_FOUND' });
  });
});

describe('cross-tenant isolation (simulated database)', () => {
  it('a tenant-A caller never sees tenant-B rows through this module', async () => {
    const rows = [
      { id: 'a1', tenant_id: TENANT_A, user_id: USER_A1, fact: 'A fact' },
      { id: 'b1', tenant_id: TENANT_B, user_id: USER_B1, fact: 'B fact' },
    ];
    tenantQuery.mockImplementation(async (tenant: string, _sql: string, params: unknown[]) => {
      // Behave like the real database: rows are returned only for the bound
      // (tenant_id, user_id) pair.
      const filtered = rows.filter(
        (r) => r.tenant_id === params[0] && r.user_id === params[1]
      );
      return { rows: filtered, rowCount: filtered.length } as never;
    });
    const seen = await listMemories(CTX_A, {});
    expect(seen.map((r) => r.id)).toEqual(['a1']);
    const seenB = await listMemories({ tenantId: TENANT_B, userId: USER_B1, clearance: 'CONFIDENTIAL' }, {});
    expect(seenB.map((r) => r.id)).toEqual(['b1']);
  });
});
