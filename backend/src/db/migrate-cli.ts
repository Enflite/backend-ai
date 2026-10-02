/**
 * migrate-cli.ts — executable entrypoint for `npm run migrate`.
 *
 * History: the `migrate` npm script used to point at `src/db/migrate.ts`,
 * which only *exports* `runMigrations()` — nothing in the codebase ever
 * called it, so the command printed nothing and applied zero migrations
 * (silent no-op). This module is the real CLI: it loads the migration
 * registry and runs it.
 *
 * Usage:
 *   npm run migrate          # dev (tsx)
 *   npm run migrate:prod     # built output (node dist/src/db/migrate-cli.js)
 *
 * Exit code is 1 on failure so CI / deploy scripts can gate on it.
 */
import { runMigrations } from './migrate.js';
import { migrations } from './migrations/index.js';
import { closeDb } from './mongo.js';

async function main(): Promise<void> {
  console.log(`Running ${migrations.length} registered migration(s)...`);
  await runMigrations(migrations);
  await closeDb();
  console.log('Done.');
}

main().catch(async (err: unknown) => {
  console.error('Migration failed:', err instanceof Error ? err.message : err);
  try {
    await closeDb();
  } catch {
    // Best-effort cleanup; the process is exiting anyway.
  }
  process.exit(1);
});
