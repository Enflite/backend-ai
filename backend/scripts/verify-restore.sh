#!/usr/bin/env bash
#
# verify-restore.sh — CI-validated MongoDB backup/restore smoke test.
#
# What it does:
#   1. mongodump the source database (all collections).
#   2. Restores the dump into a scratch database ON THE SAME CLUSTER.
#   3. Runs the migration runner (backend/src/db/migrate.ts) the way the app
#      runs it on boot — it must report "All migrations are up to date."
#   4. Verifies the key collections exist in the restored database.
#   5. Drops the scratch database and removes the dump.
#
# Validation split (see docs/recovery.md §1):
#   - VALIDATED IN CI (requires a live MongoDB + mongodb-database-tools in the
#     CI job): full dump/restore cycle, migration re-run, collection existence.
#   - Validated in THIS environment (no live MongoDB, no mongodump available):
#     `bash -n` syntax check only. The script exits 0 with a clear SKIP message
#     when the MongoDB client tools are missing, so local runs never fail
#     spuriously.
#
# Environment:
#   MONGODB_URI         source database to dump (required; typically the CI
#                       test database, e.g. mongodb://.../backend_ai_test)
#   SCRATCH_DB          scratch database name (default: backend_ai_restore_check)
#   RESTORE_DUMP_DIR    where to keep the dump (default: mktemp -d; removed on exit)
#
set -euo pipefail

SCRATCH_DB="${SCRATCH_DB:-backend_ai_restore_check}"
WORK_DIR="${RESTORE_DUMP_DIR:-$(mktemp -d)}"
DUMP_DIR="$WORK_DIR/dump"

# Client tools are checked BEFORE MONGODB_URI is required: without them the
# script SKIP-exits (local runs), and requiring the URI first would fail
# spuriously in exactly those environments.
for tool in mongodump mongorestore mongosh; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "SKIP: $tool not found — no MongoDB database tools in this environment."
    echo "This check runs in CI where mongodb-database-tools is installed; nothing failed."
    exit 0
  fi
done

SOURCE_URI="${MONGODB_URI:?MONGODB_URI must be set to the database to dump}"

# Extract the database name from the source URI (path component before ?).
# e.g. mongodb://host:27017/mydb?authSource=admin -> mydb
SOURCE_DB="$(printf '%s' "$SOURCE_URI" | sed -E 's|.*://[^/]*/([^?]+).*|\1|')"
if [[ -z "$SOURCE_DB" ]]; then
  echo "FAIL: could not extract database name from MONGODB_URI"
  exit 1
fi

# Build a URI for a different database on the SAME cluster, preserving
# userinfo/host/port and any query options (e.g. ?authSource=admin).
uri_for_db() {
  local db="$1" uri="$SOURCE_URI" query=""
  if [[ "$uri" == *\?* ]]; then
    query="?${uri#*\?}"
    uri="${uri%%\?*}"
  fi
  printf '%s/%s%s' "${uri%/*}" "$db" "$query"
}
SCRATCH_URI="$(uri_for_db "$SCRATCH_DB")"

cleanup() {
  echo "Cleaning up scratch database and dump..."
  if [[ -n "${SCRATCH_URI:-}" ]]; then
    mongosh "$SCRATCH_URI" --quiet --eval 'db.dropDatabase()' >/dev/null 2>&1 || true
  fi
  if [[ -z "${RESTORE_DUMP_DIR:-}" ]]; then
    rm -rf "$WORK_DIR"
  fi
}
trap cleanup EXIT

echo "1/5 Dumping database '$SOURCE_DB' from source cluster..."
mongodump --uri="$SOURCE_URI" --out="$DUMP_DIR"
echo "    dump written to $DUMP_DIR ($(du -sh "$DUMP_DIR" | cut -f1))"

echo "2/5 Restoring into scratch database '$SCRATCH_DB' on the source cluster..."
mongorestore --uri="$SCRATCH_URI" --dir="$DUMP_DIR/$SOURCE_DB"
echo "    restore complete"

# The repo root is the parent of backend/; migrate.ts is run via tsx from backend/.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

echo "3/5 Running the migrator against the restored database..."
# The migrator runs the way the app runs it on boot: it must report
# "up to date". Any pending migration here means the restored data
# drifted from what the migration chain produces.
(cd "$REPO_ROOT/backend" && MONGODB_URI="$SCRATCH_URI" JWT_SECRET="$JWT_SECRET" npx tsx src/db/migrate.ts) | tee "$WORK_DIR/migrate.log"
grep -q "All migrations are up to date." "$WORK_DIR/migrate.log" || { echo "FAIL: migrator did not report up-to-date after restore"; exit 1; }
echo "    migrator reports up to date after restore"

echo "4/5 Verifying key collections exist in the restored database..."
EXPECTED_COLLECTIONS=(
  tenants users organizations sessions
  documents document_chunks document_permissions
  conversations messages
  models model_access
  eval_runs eval_cases
  audit_events
  repos repo_code_chunks
  memory
  retention_policies
  schema_migrations
)
MISSING=()
for coll in "${EXPECTED_COLLECTIONS[@]}"; do
  exists=$(mongosh "$SCRATCH_URI" --quiet --eval \
    "db.getCollectionNames().includes('$coll')" | tr -d '[:space:]')
  if [[ "$exists" != "true" ]]; then
    MISSING+=("$coll")
  fi
done
if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "FAIL: collections missing after restore: ${MISSING[*]}"
  exit 1
fi
echo "    all ${#EXPECTED_COLLECTIONS[@]} key collections present"

echo "5/5 Verifying tenantId indexes exist on tenant-scoped collections..."
# Tenant isolation is application-level in MongoDB (ADR-014): every query on a
# tenant-scoped collection filters by tenantId. The compound indexes starting
# with tenantId are what make those filters efficient and are the closest
# structural analogue to the old RLS check.
TENANT_SCOPED=(documents document_chunks conversations messages audit_events memory)
for coll in "${TENANT_SCOPED[@]}"; do
  has_tenant_idx=$(mongosh "$SCRATCH_URI" --quiet --eval \
    "JSON.stringify(db.getCollection('$coll').getIndexes().map(i => i.name))" \
    | grep -c "tenantId" || true)
  if [[ "$has_tenant_idx" -eq 0 ]]; then
    echo "FAIL: no tenantId index found on $coll after restore"
    exit 1
  fi
done
echo "    tenantId indexes present on ${#TENANT_SCOPED[@]} tenant-scoped collections"

echo "OK: backup/restore verification passed (dump → scratch restore → boot-path migration check → collection + tenant-index checks)"
