/**
 * studioMongo.ts — minimal in-memory Mongo stand-in for the Studio tests.
 *
 * Implements exactly the collection surface the Studio uses: insertOne,
 * findOne, find (with project / sort / toArray), updateOne ($set),
 * deleteOne. Filters support equality and case-insensitive anchored
 * $regex (used by the connection name-uniqueness check).
 */
import { vi } from 'vitest';

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    if (key === '_id' || !key.includes('.')) {
      const value = doc[key];
      if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
        if ('$regex' in cond) {
          const re = new RegExp(cond.$regex, cond.$options ?? '');
          if (typeof value !== 'string' || !re.test(value)) return false;
          continue;
        }
      }
      if (value !== cond) return false;
    }
  }
  return true;
}

function applyProjection(doc: Doc, project: Doc): Doc {
  const keys = Object.keys(project);
  const isExclusion = keys.some((k) => project[k] === 0);
  if (isExclusion) {
    const out = { ...doc };
    for (const k of keys) if (project[k] === 0) delete out[k];
    return out;
  }
  const out: Doc = {};
  for (const k of keys) if (project[k] === 1 && k in doc) out[k] = doc[k];
  if (!('_id' in out) && '_id' in doc && project._id !== 0) out._id = doc._id;
  return out;
}

export function makeInMemoryDb() {
  const store: Record<string, Doc[]> = {};
  const docs = (name: string): Doc[] => (store[name] ??= []);

  function makeCursor(name: string, filter: Doc) {
    let result = docs(name).filter((d) => matches(d, filter));
    const cursor: any = {
      project(p: Doc) {
        result = result.map((d) => applyProjection(d, p));
        return cursor;
      },
      sort(spec: Doc) {
        const [key] = Object.keys(spec);
        const dir = spec[key!]!;
        result = [...result].sort((a, b) => {
          const av = a[key!]?.valueOf?.() ?? a[key!];
          const bv = b[key!]?.valueOf?.() ?? b[key!];
          return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
        });
        return cursor;
      },
      toArray: async () => result,
    };
    return cursor;
  }

  const collection = (name: string) => ({
    insertOne: vi.fn(async (doc: Doc) => {
      docs(name).push({ ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Doc, options?: { projection?: Doc }) => {
      const found = docs(name).find((d) => matches(d, filter));
      if (!found) return null;
      return options?.projection ? applyProjection(found, options.projection) : { ...found };
    }),
    find: vi.fn((filter: Doc) => makeCursor(name, filter)),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const found = docs(name).find((d) => matches(d, filter));
      if (!found) return { matchedCount: 0, modifiedCount: 0 };
      if (update.$set) Object.assign(found, update.$set);
      return { matchedCount: 1, modifiedCount: 1 };
    }),
    deleteOne: vi.fn(async (filter: Doc) => {
      const arr = docs(name);
      const idx = arr.findIndex((d) => matches(d, filter));
      if (idx === -1) return { deletedCount: 0 };
      arr.splice(idx, 1);
      return { deletedCount: 1 };
    }),
    createIndex: vi.fn(async () => 'idx'),
  });

  const getDbMock = vi.fn(async () => ({ collection }));
  return { getDbMock, store, collection };
}
