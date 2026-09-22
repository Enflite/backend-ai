/**
 * store.ts — tenant-scoped user memory CRUD (memory_facts).
 *
 * Privacy model (see docs/adr/013-user-memory.md):
 * - Every operation binds BOTH tenant_id and user_id from the caller's auth
 *   context. A user can only ever touch their own rows — cross-user and
 *   cross-tenant access does not exist in this module.
 * - RLS (`tenant_isolation`, migration 027) is defense in depth; the
 *   application scoping below is the primary enforcement (ADR-004).
 * - Write-side classification may not exceed the caller's clearance
 *   (assertClassificationAllowed, like conversations).
 * - Fact text is user data, not secrets: callers must never store
 *   credentials in memory facts (the injection path redacts secret-shaped
 *   spans as a guardrail — see inject.ts).
 */

import { tenantQuery } from '../db/pool.js';
import { assertClassificationAllowed } from '../authz/classification.js';
import { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';

export const MEMORY_CATEGORIES = ['preference', 'fact', 'project'] as const;
export type MemoryCategory = (typeof MEMORY_CATEGORIES)[number];

export const MEMORY_SOURCES = ['user-stated', 'inferred'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export interface MemoryFact {
  id: string;
  tenant_id: string;
  user_id: string;
  fact: string;
  category: MemoryCategory;
  classification: Classification;
  source: MemorySource;
  created_at: string;
  updated_at: string;
}

export interface MemoryContext {
  tenantId: string;
  userId: string;
  clearance: Classification;
}

const SELECT_COLUMNS =
  'id, tenant_id, user_id, fact, category, classification, source, created_at, updated_at';

export interface CreateMemoryInput {
  fact: string;
  category?: MemoryCategory;
  /** Omitted classification resolves like conversations: PUBLIC for PUBLIC-cleared callers, else INTERNAL. */
  classification?: Classification;
  source?: MemorySource;
}

export async function createMemory(
  ctx: MemoryContext,
  input: CreateMemoryInput
): Promise<MemoryFact> {
  const classification =
    input.classification ?? (ctx.clearance === 'PUBLIC' ? 'PUBLIC' : 'INTERNAL');
  assertClassificationAllowed(ctx.clearance, classification);
  const result = await tenantQuery<MemoryFact>(
    ctx.tenantId,
    `INSERT INTO memory_facts (tenant_id, user_id, fact, category, classification, source)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${SELECT_COLUMNS}`,
    [
      ctx.tenantId,
      ctx.userId,
      input.fact,
      input.category ?? 'fact',
      classification,
      input.source ?? 'user-stated',
    ]
  );
  return result.rows[0]!;
}

export async function getMemory(ctx: MemoryContext, id: string): Promise<MemoryFact> {
  const result = await tenantQuery<MemoryFact>(
    ctx.tenantId,
    `SELECT ${SELECT_COLUMNS} FROM memory_facts WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [id, ctx.tenantId, ctx.userId]
  );
  const row = result.rows[0];
  if (!row) throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  return row;
}

export interface ListMemoriesOptions {
  category?: MemoryCategory;
  limit?: number;
  offset?: number;
}

/** Most-recent-first listing of the caller's own facts. */
export async function listMemories(
  ctx: MemoryContext,
  options: ListMemoriesOptions = {}
): Promise<MemoryFact[]> {
  const { category, limit = 50, offset = 0 } = options;
  const params: unknown[] = [ctx.tenantId, ctx.userId];
  let where = 'tenant_id = $1 AND user_id = $2';
  if (category) {
    params.push(category);
    where += ` AND category = $${params.length}`;
  }
  params.push(limit, offset);
  const result = await tenantQuery<MemoryFact>(
    ctx.tenantId,
    `SELECT ${SELECT_COLUMNS} FROM memory_facts WHERE ${where}
     ORDER BY updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return result.rows;
}

export interface UpdateMemoryInput {
  fact?: string;
  category?: MemoryCategory;
  classification?: Classification;
}

export async function updateMemory(
  ctx: MemoryContext,
  id: string,
  input: UpdateMemoryInput
): Promise<MemoryFact> {
  if (input.classification !== undefined) {
    assertClassificationAllowed(ctx.clearance, input.classification);
  }
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.fact !== undefined) {
    params.push(input.fact);
    sets.push(`fact = $${params.length}`);
  }
  if (input.category !== undefined) {
    params.push(input.category);
    sets.push(`category = $${params.length}`);
  }
  if (input.classification !== undefined) {
    params.push(input.classification);
    sets.push(`classification = $${params.length}`);
  }
  if (sets.length === 0) {
    throw Errors.badRequest('INVALID_REQUEST', 'No fields to update');
  }
  params.push(id, ctx.tenantId, ctx.userId);
  const result = await tenantQuery<MemoryFact>(
    ctx.tenantId,
    `UPDATE memory_facts SET ${sets.join(', ')}, updated_at = NOW()
     WHERE id = $${params.length - 2} AND tenant_id = $${params.length - 1} AND user_id = $${params.length}
     RETURNING ${SELECT_COLUMNS}`,
    params
  );
  const row = result.rows[0];
  if (!row) throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  return row;
}

export async function deleteMemory(ctx: MemoryContext, id: string): Promise<void> {
  const result = await tenantQuery(
    ctx.tenantId,
    'DELETE FROM memory_facts WHERE id = $1 AND tenant_id = $2 AND user_id = $3',
    [id, ctx.tenantId, ctx.userId]
  );
  if (result.rowCount === 0) {
    throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  }
}
