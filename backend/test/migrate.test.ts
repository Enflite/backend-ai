import { describe, expect, it } from 'vitest';
import { isNonTransactionalMigration, splitStatements } from '../src/db/migrate.js';

describe('isNonTransactionalMigration', () => {
  it('detects the header before any statement', () => {
    expect(
      isNonTransactionalMigration(
        '-- migrate: non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS x ON t (a);'
      )
    ).toBe(true);
  });

  it('ignores a header that appears after a statement', () => {
    expect(
      isNonTransactionalMigration(
        'CREATE TABLE t (a int);\n-- migrate: non-transactional'
      )
    ).toBe(false);
  });

  it('returns false for ordinary migrations', () => {
    expect(isNonTransactionalMigration('CREATE INDEX x ON t (a);')).toBe(false);
  });
});

describe('splitStatements', () => {
  it('splits simple statements', () => {
    expect(splitStatements('SELECT 1;\nSELECT 2;')).toEqual(['SELECT 1;', 'SELECT 2;']);
  });

  it('ignores semicolons inside strings, quotes, and comments', () => {
    const sql = `INSERT INTO t (a) VALUES ('semi;colon');\n-- trailing; comment\nSELECT "weird;ident" FROM t;`;
    expect(splitStatements(sql)).toEqual([
      `INSERT INTO t (a) VALUES ('semi;colon');`,
      `-- trailing; comment\nSELECT "weird;ident" FROM t;`,
    ]);
  });

  it('handles doubled-quote escapes and dollar-quoted bodies', () => {
    const sql = `INSERT INTO t (a) VALUES ('it''s; fine');\nCREATE FUNCTION f() RETURNS void AS $$ BEGIN RAISE NOTICE 'x;y'; END; $$ LANGUAGE plpgsql;`;
    const parts = splitStatements(sql);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toContain(`'it''s; fine'`);
    expect(parts[1]).toContain(`RAISE NOTICE 'x;y'`);
  });

  it('keeps a CONCURRENTLY index build as one statement', () => {
    const sql =
      '-- migrate: non-transactional\nCREATE INDEX CONCURRENTLY IF NOT EXISTS idx_t_a ON t (a);';
    expect(splitStatements(sql)).toHaveLength(1);
  });
});
