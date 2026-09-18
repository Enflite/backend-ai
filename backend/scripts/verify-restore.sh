#!/usr/bin/env bash
#
# verify-restore.sh — CI-validated PostgreSQL backup/restore smoke test.
#
# What it does:
#   1. pg_dump --schema-only the test database (custom format).
#   2. Restores the dump into a scratch database.
#   3. Re-runs the migration runner (backend/src/db/migrate.ts) against the
#      scratch database — must exit 0 ("All migrations are up to date").
#   4. Verifies the key platform tables exist in the restored database.
#   5. Drops the scratch database and removes the dump.
#
# Validation split (see docs/recovery.md §1):
#   - VALIDATED IN CI (requires a live PostgreSQL + postgresql-client in the
#     CI job): full dump/restore cycle, migration re-run, table existence.
#   - Validated in THIS environment (no live PostgreSQL, no pg_dump/psql
#     available): `bash -n` syntax check only. The script exits 0 with a
#     clear SKIP message when the PG client tools are missing, so local runs
#     never fail spuriously.
#
# Environment:
#   DATABASE_URL        source database to dump (required; typically the CI
#                       test database, e.g. postgres://.../backend_ai_test)
#   SCRATCH_DB          scratch database name (default: backend_ai_restore_check)
#   RESTORE_DUMP_DIR    where to keep the dump (default: mktemp -d; removed on exit)
#
set -euo pipefail

SOURCE_URL="${DATABASE_URL:?DATABASE_URL must be set to the database to dump}"
SCRATCH_DB="${SCRATCH_DB:-backend_ai_restore_check}"
WORK_DIR="${RESTORE_DUMP_DIR:-$(mktemp -d)}"
DUMP_FILE="$WORK_DIR/restore-check.dump"

for tool in pg_dump pg_restore psql createdb dropdb; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not found — no PostgreSQL client in this environment."
    echo "This check runs in CI where postgresql-client is installed; nothing failed."
    exit 0
  fi
done

cleanup() {
  echo "Cleaning up scratch database and dump..."
  dropdb --if-exists "$SCRATCH_DB" >/dev/null 2>&1 || true
  if [[ -z "${RESTORE_DUMP_DIR:-}" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

echo "1/5 Dumping schema from source database..."
pg_dump --format=custom --schema-only --no-owner --no-privileges \
  --file="$DUMP_FILE" "$SOURCE_URL"
echo "    dump written to $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo "2/5 Creating scratch database '$SCRATCH_DB' and restoring..."
dropdb --if-exists "$SCRATCH_DB"
createdb "$SCRATCH_DB"
pg_restore --no-owner --dbname="$SCRATCH_DB" "$DUMP_FILE"
echo "    restore complete"

echo "3/5 Re-running migrations against the restored database..."
SCRATCH_URL="$(echo "$SOURCE_URL" | sed -E "s|/[^/]*$|/$SCRATCH_DB|")"
# The repo root is the parent of backend/; migrate.ts is run via tsx from backend/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
(cd "$REPO_ROOT/backend" && DATABASE_URL="$SCRATCH_URL" npx tsx src/db/migrate.ts)
echo "    migrations applied cleanly"

echo "4/5 Verifying key tables exist in the restored database..."
EXPECTED_TABLES=(
  tenants users organizations departments sessions
  documents document_chunks document_ingestion_jobs document_permissions
  conversations messages
  models model_serving_defaults model_access
  eval_runs eval_case_results
  audit_events
  schema_migrations
  tool_executions
)
MISSING=()
for table in "${EXPECTED_TABLES[@]}"; do
  exists=$(psql "$SCRATCH_URL" -tAc \
    "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='$table';" \
    | tr -d '[:space:]')
  if [[ "$exists" != "1" ]]; then
    MISSING+=("$table")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "FAIL: tables missing after restore: ${MISSING[*]}"
  exit 1
fi
echo "    all ${#EXPECTED_TABLES[@]} key tables present"

echo "5/5 Verifying RLS is enabled on tenant-scoped tables..."
RLS_TABLES=(documents document_chunks conversations messages tenants)
for table in "${RLS_TABLES[@]}"; do
  rls=$(psql "$SCRATCH_URL" -tAc \
    "SELECT relrowsecurity FROM pg_class WHERE relname='$table';" | tr -d '[:space:]')
  if [[ "$rls" != "t" ]]; then
    echo "FAIL: row-level security not enabled on $table after restore"
    exit 1
  fi
done
echo "    RLS enabled on ${#RLS_TABLES[@]} tenant tables"

echo "OK: backup/restore verification passed (dump → scratch restore → migrations → table + RLS checks)"
