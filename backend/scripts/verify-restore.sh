#!/usr/bin/env bash
#
# verify-restore.sh — CI-validated PostgreSQL backup/restore smoke test.
#
# What it does:
#   1. pg_dump --schema-only the test database (custom format).
#   2. Restores the dump into a scratch database ON THE SAME SERVER.
#   3. Copies the source's real schema_migrations records into the restored
#      database (a schema-only dump leaves that table empty), then runs the
#      migration runner (backend/src/db/migrate.ts) the way the app runs it
#      on boot — it must report "All migrations are up to date."
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

SCRATCH_DB="${SCRATCH_DB:-backend_ai_restore_check}"
WORK_DIR="${RESTORE_DUMP_DIR:-$(mktemp -d)}"
DUMP_FILE="$WORK_DIR/restore-check.dump"

# Client tools are checked BEFORE DATABASE_URL is required: without them the
# script SKIP-exits (local runs), and requiring the URL first would fail
# spuriously in exactly those environments.
for tool in pg_dump pg_restore psql; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not found — no PostgreSQL client in this environment."
    echo "This check runs in CI where postgresql-client is installed; nothing failed."
    exit 0
  fi
done

SOURCE_URL="${DATABASE_URL:?DATABASE_URL must be set to the database to dump}"

# Build a connection URL for a different database on the SAME server as
# $SOURCE_URL, preserving userinfo/host/port and any query options
# (e.g. ?sslmode=require). Pure bash so the script needs no extra tooling.
url_for_db() {
  local db="$1" rest="$SOURCE_URL" query=""
  if [[ "$rest" == *\?* ]]; then
    query="?${rest#*\?}"
    rest="${rest%%\?*}"
  fi
  printf '%s/%s%s' "${rest%/*}" "$db" "$query"
}

# Maintenance connection (default 'postgres' database) for CREATE/DROP
# DATABASE, and the scratch connection. Both target the source server —
# never local defaults.
MAINT_URL="$(url_for_db postgres)"
SCRATCH_URL="$(url_for_db "$SCRATCH_DB")"

cleanup() {
  echo "Cleaning up scratch database and dump..."
  if [[ -n "${MAINT_URL:-}" ]]; then
    psql "$MAINT_URL" -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" >/dev/null 2>&1 || true
  fi
  if [[ -z "${RESTORE_DUMP_DIR:-}" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

echo "1/5 Dumping schema from source database..."
pg_dump --format=custom --schema-only --no-owner --no-privileges \
  --file="$DUMP_FILE" "$SOURCE_URL"
echo "    dump written to $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))"

echo "2/5 Creating scratch database '$SCRATCH_DB' on the source server and restoring..."
psql "$MAINT_URL" -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\";" \
  -c "CREATE DATABASE \"$SCRATCH_DB\";"
pg_restore --no-owner --dbname="$SCRATCH_URL" "$DUMP_FILE"
echo "    restore complete"

# The repo root is the parent of backend/; migrate.ts is run via tsx from backend/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "3/5 Copying the source's real migration records, then running the migrator..."
# A schema-only dump leaves schema_migrations EMPTY. Copy the source's
# actual applied versions instead of blindly marking every file applied —
# the latter would hide a migration the source database never ran and make
# the "up to date" check meaningless.
psql "$SOURCE_URL" -v ON_ERROR_STOP=1 \
  -c "COPY (SELECT version FROM schema_migrations ORDER BY version) TO STDOUT" \
  | psql "$SCRATCH_URL" -v ON_ERROR_STOP=1 \
  -c "COPY schema_migrations (version) FROM STDIN"
# Then the migrator runs the way the app runs it on boot: it must report
# "up to date". Any pending migration here means the restored schema
# drifted from what the migration chain produces.
# (Re-running the migration files from scratch is NOT what happens after a
# real restore, and seed migrations are not re-runnable against the final
# schema — so the boot path is the faithful check.)
(cd "$REPO_ROOT/backend" && DATABASE_URL="$SCRATCH_URL" JWT_SECRET="$JWT_SECRET" npx tsx src/db/migrate.ts) | tee "$WORK_DIR/migrate.log"
grep -q "All migrations are up to date." "$WORK_DIR/migrate.log" || { echo "FAIL: migrator did not report up-to-date after restore"; exit 1; }
echo "    migrator reports up to date after restore"

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
# tenants is intentionally WITHOUT RLS (see 013_force_rls.sql: tenant lookup
# is the non-tenant-context query that bootstraps the tenant id itself).
RLS_TABLES=(documents document_chunks conversations messages)
for table in "${RLS_TABLES[@]}"; do
  rls=$(psql "$SCRATCH_URL" -tAc \
    "SELECT relrowsecurity FROM pg_class WHERE relname='$table';" | tr -d '[:space:]')
  if [[ "$rls" != "t" ]]; then
    echo "FAIL: row-level security not enabled on $table after restore"
    exit 1
  fi
done
echo "    RLS enabled on ${#RLS_TABLES[@]} tenant tables"

echo "OK: backup/restore verification passed (dump → scratch restore → boot-path migration check → table + RLS checks)"
