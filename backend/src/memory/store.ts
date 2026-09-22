/**
 * store.ts — tenant-scoped user memory CRUD (memory_facts).
 *
 * Privacy model (see docs/adr/013-user-memory.md):
 * - Every operation binds BOTH tenantId and userId from the caller's auth
 *   context. A user can only ever touch their own rows — cross-user and
 *   cross-tenant access does not exist in this module.
 * - Application-level tenantId filtering is the enforcement (ADR-004,
 *   ADR-014); MongoDB has no RLS, so the { tenantId } filter on every
 *   query is load-bearing.
 * - Write-side classification may not exceed the caller's clearance
 *   (assertClassificationAllowed, like conversations).
 * - Fact text is user data, not secrets: callers must never store
 *   credentials in memory facts (the injection path redacts secret-shaped
 *   spans as a guardrail — see inject.ts).
 *
 * Storage note: MongoDB documents use camelCase fields with the UUID in
 * `_id` (ADR-014). The public MemoryFact interface keeps its original
 * snake_case shape so existing consumers (inject.ts, tests) are unaffected;
 * toMemoryFact maps between the two.
 */

import { randomUUID } from 'node:crypto';
import { tenantOp } from '../db/mongo.js';
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

/** MongoDB document shape for the `memory_facts` collection (ADR-014). */
interface MemoryFactDoc {
  _id: string;
  tenantId: string;
  userId: string;
  fact: string;
  category: MemoryCategory;
  classification: Classification;
  source: MemorySource;
  createdAt: Date;
  updatedAt: Date;
}

function toMemoryFact(doc: MemoryFactDoc): MemoryFact {
  return {
    id: doc._id,
    tenant_id: doc.tenantId,
    user_id: doc.userId,
    fact: doc.fact,
    category: doc.category,
    classification: doc.classification,
    source: doc.source,
    created_at: doc.createdAt.toISOString(),
    updated_at: doc.updatedAt.toISOString(),
  };
}

export interface MemoryContext {
  tenantId: string;
  userId: string;
  clearance: Classification;
}

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
  const now = new Date();
  const doc: MemoryFactDoc = {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    fact: input.fact,
    category: input.category ?? 'fact',
    classification,
    source: input.source ?? 'user-stated',
    createdAt: now,
    updatedAt: now,
  };
  await tenantOp(ctx.tenantId, async (db) => {
    await db.collection<MemoryFactDoc>('memory_facts').insertOne(doc);
  });
  return toMemoryFact(doc);
}

export async function getMemory(ctx: MemoryContext, id: string): Promise<MemoryFact> {
  const doc = await tenantOp(ctx.tenantId, (db) =>
    db
      .collection<MemoryFactDoc>('memory_facts')
      .findOne({ _id: id, tenantId: ctx.tenantId, userId: ctx.userId })
  );
  if (!doc) throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  return toMemoryFact(doc);
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
  const docs = await tenantOp(ctx.tenantId, (db) => {
    const filter: Record<string, unknown> = { tenantId: ctx.tenantId, userId: ctx.userId };
    if (category) filter.category = category;
    return db
      .collection<MemoryFactDoc>('memory_facts')
      .find(filter)
      .sort({ updatedAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray();
  });
  return docs.map(toMemoryFact);
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
  const set: Record<string, unknown> = {};
  if (input.fact !== undefined) set.fact = input.fact;
  if (input.category !== undefined) set.category = input.category;
  if (input.classification !== undefined) set.classification = input.classification;
  if (Object.keys(set).length === 0) {
    throw Errors.badRequest('INVALID_REQUEST', 'No fields to update');
  }
  set.updatedAt = new Date();
  const doc = await tenantOp(ctx.tenantId, (db) =>
    db.collection<MemoryFactDoc>('memory_facts').findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, userId: ctx.userId },
      { $set: set },
      { returnDocument: 'after' }
    )
  );
  if (!doc) throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  return toMemoryFact(doc);
}

export async function deleteMemory(ctx: MemoryContext, id: string): Promise<void> {
  const deletedCount = await tenantOp(ctx.tenantId, async (db) => {
    const result = await db
      .collection<MemoryFactDoc>('memory_facts')
      .deleteOne({ _id: id, tenantId: ctx.tenantId, userId: ctx.userId });
    return result.deletedCount;
  });
  if (deletedCount === 0) {
    throw Errors.notFound('MEMORY_NOT_FOUND', 'Memory not found');
  }
}
