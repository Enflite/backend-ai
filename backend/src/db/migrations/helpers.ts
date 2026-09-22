/**
 * helpers.ts — shared utilities for the MongoDB migration modules (ADR-014).
 *
 * Every migration is idempotent: `createIndex` with an explicit name is a
 * no-op when the identical index already exists, and seed inserts swallow
 * duplicate-key errors (code 11000) so re-running a migration changes nothing.
 */

import type { Collection, Db, Document, OptionalId } from 'mongodb';

const DUPLICATE_KEY = 11000;

/**
 * Document shape for collections whose `_id` is a UUID string
 * (crypto.randomUUID()), the MongoDB equivalent of the Postgres
 * `gen_random_uuid()` primary-key defaults. Declaring `_id: string` makes
 * the driver's `InferIdType` resolve to `string` instead of `ObjectId`.
 */
export interface UuidDoc extends Document {
  _id: string;
}

/** Typed collection accessor for UUID-keyed collections. */
export function coll(db: Db, name: string): Collection<UuidDoc> {
  return db.collection<UuidDoc>(name);
}

/**
 * insertMany that tolerates already-seeded documents. Any error other than
 * duplicate-key (e.g. validation, connectivity) is re-thrown.
 */
export async function insertManyIdempotent(
  coll: Collection<UuidDoc>,
  docs: OptionalId<UuidDoc>[]
): Promise<void> {
  if (docs.length === 0) return;
  try {
    await coll.insertMany(docs, { ordered: false });
  } catch (err: unknown) {
    const codes = new Set<number>();
    // The driver surfaces duplicate-key failures either as a top-level
    // MongoBulkWriteError (err.code) or as per-document writeErrors.
    const e = err as { code?: unknown; writeErrors?: Array<{ code?: unknown }> };
    if (typeof e.code === 'number') codes.add(e.code);
    for (const we of e.writeErrors ?? []) {
      if (typeof we.code === 'number') codes.add(we.code);
    }
    codes.delete(DUPLICATE_KEY);
    if (codes.size > 0) throw err;
    // Only duplicate-key errors: every surviving document was already seeded.
  }
}
