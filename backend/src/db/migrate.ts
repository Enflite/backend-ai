import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { pool, withTx, query } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * A migration file opts into non-transactional execution by starting with a
 * header line `-- migrate: non-transactional` (before any statement). This
 * exists for operations PostgreSQL forbids inside a transaction block, such
 * as `CREATE INDEX CONCURRENTLY` on populated production tables.
 *
 * Non-transactional migrations run statement-by-statement outside a
 * transaction, so a failure can leave earlier statements applied: keep them
 * to a single idempotent statement (e.g. one `CREATE INDEX CONCURRENTLY IF
 * NOT EXISTS`) and validate the upgrade on staging first.
 */
export function isNonTransactionalMigration(sql: string): boolean {
  for (const line of sql.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('--')) {
      if (/^--\s*migrate:\s*non-transactional\s*$/i.test(trimmed)) return true;
      continue;
    }
    return false;
  }
  return false;
}

/**
 * Split SQL text into individual statements, respecting single-quoted
 * strings, double-quoted identifiers, line/block comments, and
 * dollar-quoted bodies. Only used for explicitly non-transactional
 * migrations; transactional migrations keep the existing whole-file path.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    // Line comment
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      current += sql.slice(i, end === -1 ? n : end);
      i = end === -1 ? n : end;
      continue;
    }
    // Block comment
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      current += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // Quoted string or identifier: '...' / "...", with '' / "" escapes.
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          j += 1;
          break;
        }
        j += 1;
      }
      current += sql.slice(i, j);
      i = j;
      continue;
    }
    // Dollar-quoted body: $tag$ ... $tag$
    if (ch === '$') {
      const tagMatch = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i));
      if (tagMatch) {
        const tag = tagMatch[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? n : end + tag.length;
        current += sql.slice(i, stop);
        i = stop;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }
    if (ch === ';') {
      current += ch;
      const statement = current.trim();
      if (statement) statements.push(statement);
      current = '';
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

/**
 * Migration-state verification and repair helpers.
 *
 * migrate.ts applies transactional migrations inside a single transaction, so
 * a failure rolls back cleanly: the failing file is NOT recorded in
 * `schema_migrations`, and a re-run will retry it from scratch. Non-
 * transactional migrations (single `CREATE INDEX CONCURRENTLY`-style
 * statement) can leave partial state behind — they are the ones that need
 * manual repair.
 *
 * Diagnosis and repair procedure (see docs/recovery.md §3 for the full
 * runbook):
 *   1. Run `verifyMigrationState()` (read-only). `pending` lists migration
 *      files on disk that were never applied — re-run `npm run migrate`.
 *      `appliedButMissing` lists versions recorded in the database that no
 *      longer exist on disk — investigate before touching anything: someone
 *      hand-applied DDL or a file was renamed.
 *   2. If a migration failed: check the runner logs for the failing file and
 *      the PostgreSQL error. Transactional failures need no cleanup — fix
 *      the SQL (or the database state it tripped on) and re-run.
 *   3. For a failed NON-transactional migration: inspect what the statement
 *      partially did (e.g. an index left INVALID — check
 *      `pg_index.indisvalid`), drop/repair the partial artifact, then re-run.
 *      Prefer idempotent forms (`IF NOT EXISTS`) so re-runs are safe.
 *   4. Take a Postgres advisory lock (`SELECT pg_advisory_lock(...)`) around
 *      any manual repair in production so a second migrator cannot run
 *      concurrently; release it afterwards.
 *
 * WARNINGS: never hand-edit `schema_migrations` to "skip" a migration unless
 * you can prove its effects are fully present; never run two migrators
 * against the same database at once; always back up (`docs/recovery.md` §1)
 * before manual DDL in production.
 */
export interface MigrationDrift {
  /** Migration files present on disk (sorted). */
  onDisk: string[];
  /** Versions recorded in schema_migrations (sorted). */
  applied: string[];
  /** On disk but never applied — re-running the migrator will apply these. */
  pending: string[];
  /** Applied in the database but no file on disk — investigate, do not re-run blindly. */
  appliedButMissing: string[];
}

/** Pure drift computation — no database access, fully unit-testable. */
export function computeMigrationDrift(
  onDisk: string[],
  applied: string[]
): MigrationDrift {
  const disk = [...onDisk].sort();
  const appliedSorted = [...applied].sort();
  const appliedSet = new Set(applied);
  const diskSet = new Set(onDisk);
  return {
    onDisk: disk,
    applied: appliedSorted,
    pending: disk.filter((f) => !appliedSet.has(f)),
    appliedButMissing: appliedSorted.filter((v) => !diskSet.has(v)),
  };
}

/** Read-only check of migration state against the database. */
export async function verifyMigrationState(): Promise<MigrationDrift> {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = await readdir(migrationsDir);
  const onDisk = files.filter((f) => f.endsWith('.sql'));
  const appliedResult = await query<{ version: string }>(
    'SELECT version FROM schema_migrations'
  );
  return computeMigrationDrift(
    onDisk,
    appliedResult.rows.map((r) => r.version)
  );
}

export async function runMigrations(): Promise<void> {
  const migrationsDir = path.join(__dirname, 'migrations');

  // Ensure migrations tracking table exists
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const appliedResult = await query<{ version: string }>(
    'SELECT version FROM schema_migrations'
  );
  const appliedSet = new Set(appliedResult.rows.map((r) => r.version));

  const files = await readdir(migrationsDir);
  const sqlFiles = files.filter((f) => f.endsWith('.sql')).sort();

  for (const file of sqlFiles) {
    if (appliedSet.has(file)) {
      continue;
    }

    console.log(`Applying migration: ${file}...`);
    const filePath = path.join(migrationsDir, file);
    const sql = await readFile(filePath, 'utf-8');

    if (isNonTransactionalMigration(sql)) {
      // Runs outside a transaction (e.g. CREATE INDEX CONCURRENTLY). A
      // failure can leave earlier statements applied, so keep these
      // migrations to a single idempotent statement and prefer re-runnable
      // forms such as `IF NOT EXISTS`.
      const statements = splitStatements(sql);
      if (statements.length !== 1) {
        throw new Error(
          `Non-transactional migration ${file} must contain exactly one statement (found ${statements.length}); ` +
            'split multi-statement migrations into one file per statement.'
        );
      }
      const statement = statements[0]!;
      await pool.query(statement);
      await query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
    } else {
      await withTx(async (client) => {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version) VALUES ($1)',
          [file]
        );
      });
    }

    console.log(`Successfully applied migration: ${file}`);
  }

  console.log('All migrations are up to date.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(__filename)) {
  runMigrations()
    .then(async () => {
      await pool.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error('Migration failed:', err);
      await pool.end();
      process.exit(1);
    });
}
