import { Db } from 'mongodb';
import { getDb } from './mongo.js';

export interface Migration {
  version: string;
  description: string;
  up: (db: Db) => Promise<void>;
}

/**
 * MongoDB migration runner. Replaces the SQL file migrator (ADR-014).
 * Tracks applied versions in the `schema_migrations` collection.
 * Each migration is idempotent — safe to re-run.
 */
export async function runMigrations(migrations: Migration[]): Promise<void> {
  const db = await getDb();
  interface SchemaMigrationDoc {
    _id: string;
    version: string;
    appliedAt: Date;
  }
  const coll = db.collection<SchemaMigrationDoc>('schema_migrations');

  await coll.createIndex({ version: 1 }, { unique: true });

  const applied = new Set(
    (await coll.find({}, { projection: { _id: 0, version: 1 } }).toArray()).map(
      (d) => d.version as string
    )
  );

  const sorted = [...migrations].sort((a, b) => a.version.localeCompare(b.version));

  for (const m of sorted) {
    if (applied.has(m.version)) {
      continue;
    }
    console.log(`Applying migration: ${m.version} ${m.description}...`);
    await m.up(db);
    await coll.insertOne({ _id: m.version, version: m.version, appliedAt: new Date() });
    console.log(`Successfully applied migration: ${m.version}`);
  }

  console.log('All migrations are up to date.');
}

export async function getAppliedVersions(): Promise<string[]> {
  const db = await getDb();
  const docs = await db
    .collection('schema_migrations')
    .find({}, { projection: { version: 1 } })
    .sort({ version: 1 })
    .toArray();
  return docs.map((d) => d.version as string);
}
