# Platform Recovery Runbook

How to get the Enflite AI platform back after data loss, a bad migration, or
a lost secret. Concrete commands, in the order you will need them. Keep this
doc next to the backup cron — a runbook you cannot find during an incident
is not a runbook.

Assumptions: you have shell access to the deployment host, `psql` /
`pg_dump` / `pg_restore` from postgresql-client, and the environment the
backend normally runs with (`DATABASE_URL`, `OBJECT_STORAGE_*`). All
timestamps below are UTC unless noted.

---

## 1. PostgreSQL backup and restore

### 1.1 Nightly backup (the RPO mechanism)

The platform's own data (tenants, users, documents metadata, conversations,
eval results, audit events) lives in one PostgreSQL database. Back it up
nightly with `pg_dump` in custom format — compressed, parallelizable, and
restorable table-by-table:

```bash
# Run nightly from cron on the backup host (example: 02:00 UTC)
BACKUP_DIR=/var/backups/backend-ai
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
pg_dump --format=custom --compress=9 \
  --file="$BACKUP_DIR/backend-ai-$STAMP.dump" \
  "$DATABASE_URL"
# Keep 30 days of nightly dumps; alert if the newest dump is older than 26h.
find "$BACKUP_DIR" -name 'backend-ai-*.dump' -mtime +30 -delete
```

Why custom format (`-Fc`) and not plain SQL: a custom-format dump restores
faster, and `pg_restore --list/--use-list` lets you restore a single table
without replaying the whole file. Do **not** use `--schema-only` for real
backups — that flag is only for the CI restore check (§1.4).

Verify the backup right after taking it; an unverified backup is a rumor:

```bash
pg_restore --list "$BACKUP_DIR/backend-ai-$STAMP.dump" | head -5
# must list tables; exit code 0 means the archive header is intact
```

### 1.2 Full restore

```bash
DUMP=/var/backups/backend-ai/backend-ai-<STAMP>.dump
TARGET_URL="postgres://<user>:<pass>@<host>:5432/<restoredb>"

# 1. Restore into a FRESH database — never over the live one on the first pass.
createdb <restoredb>                       # or: psql -c "CREATE DATABASE <restoredb>"
pg_restore --no-owner --dbname="$TARGET_URL" "$DUMP"

# 2. Re-run migrations against the restored database. pg_dump already captured
#    the schema, so this should print "All migrations are up to date." — it
#    also catches the case where the dump predates a migration file.
DATABASE_URL="$TARGET_URL" npm run migrate

# 3. Sanity checks before pointing the app at it:
psql "$TARGET_URL" -tAc \
  "SELECT count(*) FROM schema_migrations;"            # expect 17+ rows
psql "$TARGET_URL" -tAc \
  "SELECT relname FROM pg_class WHERE relname IN ('documents','tenants','users')
   AND relrowsecurity;"                                 # RLS must survive the restore
psql "$TARGET_URL" -tAc \
  "SELECT count(*) FROM tenants;"                       # expect > 0 in production

# 4. Cut over: point DATABASE_URL at the restored database and restart the
#    backend. Keep the old database untouched until the app is healthy.
```

Expected timeline: restore of a few-GB dump plus checks is typically
30–90 minutes, inside the RTO budget (§4).

### 1.3 Per-tenant considerations (RLS)

- **Backups are whole-database.** Row-level security is enforced per
  session (`SET app.tenant_id` / `withTenant`); `pg_dump` runs as a
  superuser-level role and bypasses RLS, so every tenant's rows land in the
  dump. There is no supported "dump only tenant X" — RLS is an access
  control, not a partitioning scheme.
- **Per-tenant restore = restore to scratch, then copy.** To recover one
  tenant without touching others: restore the dump to a scratch database
  (§1.2 steps 1–2), then copy that tenant's rows explicitly, e.g.:

  ```sql
  -- on the live database, for one table at a time (repeat per tenant table)
  INSERT INTO documents SELECT * FROM dblink_or_fdw.documents
  WHERE tenant_id = '<tenant-uuid>' ON CONFLICT DO NOTHING;
  ```

  Use foreign-data-wrapper or `COPY (SELECT … WHERE tenant_id=…) TO STDOUT`
  / `COPY … FROM STDIN` between the two databases. Never hand-edit
  `tenant_id` values.
- **Tenant deletion is soft.** `documents.status = 'DELETED'` and RLS keep
  deleted rows out of queries; the rows still occupy the backup until
  retention expires. True erasure (e.g. a GDPR delete request) needs an
  explicit hard-delete plus confirmation the next nightly dump no longer
  contains the rows.

### 1.4 CI-validated restore test

`backend/scripts/verify-restore.sh` (`npm run verify:restore`) is the
automated version of §1.2: it dumps the test database schema, restores into
a scratch database, re-runs `migrate.ts` (must exit 0), and asserts the key
platform tables exist **and** that RLS is still enabled on the tenant tables.

Validation split — be precise about what each environment proves:

| Environment | What runs | What it proves |
|---|---|---|
| CI (requires live PostgreSQL + postgresql-client in the job) | `npm run verify:restore` end-to-end | Dump → scratch restore → migrations apply cleanly → key tables exist → RLS intact. **This is the real validation.** |
| Dev machines without PostgreSQL | `bash -n` syntax check + SKIP exit 0 | Script parses; the guard rails (missing tools, missing `DATABASE_URL`) behave. Does **not** prove restore works. |

If the script ever FAILs in CI, treat it as a p0: the backup you are
relying on for §4's RPO claim does not restore.

---

## 2. Object storage consistency

Documents have **two** homes: metadata rows in PostgreSQL (`documents`,
`document_chunks`) and bytes in S3-compatible object storage
(`backend/src/storage/storage.ts`). They can disagree. The rule for every
disagreement below: **the ingestion job state is the source of truth for
pipeline state** — `document_ingestion_jobs.status` (`PENDING` →
`PROCESSING` → `SUCCEEDED` / `FAILED`) and `documents.status`
(`PENDING` / `PROCESSING` / `READY` / `FAILED` / `QUARANTINED` / `DELETED`).

### 2.1 PG says the document exists, but the object is missing

Symptoms: `documents.status = 'READY'` but `s3Storage.exists(storage_key)`
returns false; users get "Stored document content not found".

Recovery:

```sql
-- Find READY documents whose ingestion never succeeded (the likely orphans)
SELECT d.id, d.tenant_id, d.storage_key, j.status AS job_status, j.error_code
FROM documents d
LEFT JOIN document_ingestion_jobs j ON j.document_id = d.id
WHERE d.status = 'READY'
  AND (j.status IS NULL OR j.status <> 'SUCCEEDED');
```

Then, per row:

1. If the source file is still available (re-upload from the user or from
   the original location): set the document back to `PENDING` and enqueue a
   fresh ingestion job — the pipeline re-derives chunks and embeddings from
   the re-uploaded bytes.
2. If the source is gone: set `documents.status = 'FAILED'` with an
   operator note, and tell the tenant the document must be re-uploaded. Do
   not leave it `READY` — a `READY` row with no bytes is a lie the RAG
   layer will surface as a 500.

### 2.2 The object exists, but PG has no row for it

Symptoms: objects in the bucket with no matching `documents.storage_key`.

These are orphans — typically from an upload whose DB insert failed after
the S3 `put`, or a hard-deleted row whose object cleanup never ran.

Orphan sweep (quarterly, or after any incident involving uploads):

```bash
# 1. List all keys in the bucket
aws s3api list-objects-v2 --bucket "$OBJECT_STORAGE_BUCKET" \
  --query 'Contents[].Key' --output text > /tmp/bucket-keys.txt

# 2. List all storage_keys the database knows about
psql "$DATABASE_URL" -tAc \
  "SELECT storage_key FROM documents WHERE storage_key IS NOT NULL;" \
  > /tmp/db-keys.txt

# 3. Keys in the bucket but not in the database are orphans.
comm -23 <(sort /tmp/bucket-keys.txt) <(sort /tmp/db-keys.txt) > /tmp/orphans.txt
```

Delete orphans only after a **7-day grace period** (a document mid-upload
can briefly look orphaned), and only keys older than that grace window.
When in doubt, move them to a `quarantine/` prefix first and delete next
quarter.

### 2.3 What the platform does NOT do for you (yet)

- No automatic reconciliation job exists — the queries above are manual.
  (Recommended follow-up: a nightly cron that runs §2.1's query and pages
  when `READY`-without-`SUCCEEDED` rows appear.)
- No bucket versioning is assumed — enable versioning on
  `$OBJECT_STORAGE_BUCKET` so an accidental overwrite/delete is
  recoverable from the bucket itself.

---

## 3. Migration recovery

### 3.1 How `migrate.ts` behaves on failure

Read `backend/src/db/migrate.ts` before touching a failed migration; the
behavior differs by migration kind:

- **Transactional migrations (the default):** the whole file runs inside one
  transaction, and the `schema_migrations` insert is part of that
  transaction. If any statement fails, **everything rolls back** — the
  database is unchanged and the version is not recorded. Re-running the
  migrator retries the file from scratch. This is the safe case.
- **Non-transactional migrations** (file starts with
  `-- migrate: non-transactional`, used for `CREATE INDEX CONCURRENTLY`):
  statements run one at a time **outside** a transaction, and the file must
  contain exactly one statement. A failure can leave earlier effects applied
  — e.g. an index left in `INVALID` state. These need manual inspection.

### 3.2 Diagnose

```bash
# 1. Find the failing file and the PostgreSQL error in the migrator logs.
npm run migrate            # re-run to reproduce; it stops at the first failure

# 2. Read-only state check — what did / didn't apply:
npx tsx -e "
import { verifyMigrationState } from './src/db/migrate.js';
const d = await verifyMigrationState();
console.log('pending:', d.pending);
console.log('applied-but-missing:', d.appliedButMissing);
"
```

- `pending` non-empty: the migrator simply hasn't applied those files —
  fix the underlying error and re-run.
- `appliedButMissing` non-empty: the database records a version with no
  file on disk. **Stop.** Someone hand-applied DDL or renamed a file.
  Compare the database schema against the migration files by hand before
  doing anything.
- For a failed non-transactional migration, check for partial artifacts:

  ```sql
  SELECT indexrelid::regclass FROM pg_index WHERE NOT indisvalid;
  -- INVALID indexes must be dropped (DROP INDEX CONCURRENTLY) before re-running
  ```

### 3.3 Repair procedure

1. **Take a backup first** (§1.1). Manual DDL without a fresh backup is how
   incidents become disasters.
2. **Serialize access.** The migrator takes no lock itself, so before any
   manual repair in production, take an advisory lock and hold it in the
   same session for the whole repair:

   ```sql
   SELECT pg_advisory_lock(7274255981);   -- arbitrary fixed key for migrations
   -- ... do the repair ...
   SELECT pg_advisory_unlock(7274255981);
   ```

   Confirm no other migrator/backend is running DDL concurrently.
3. **Transactional failure:** fix the SQL file (or the database state it
   tripped on — e.g. a conflicting hand-created index), then re-run
   `npm run migrate`. Nothing to clean up; the rollback already handled it.
4. **Non-transactional failure:** drop the partial artifact (e.g. the
   `INVALID` index), confirm the one statement is idempotent
   (`IF NOT EXISTS`), then re-run.
5. **Verify:** `verifyMigrationState()` shows no pending, the app boots,
   and the smoke queries in §1.2 return sane counts.

### 3.4 Explicit warnings

- **Never hand-edit `schema_migrations`** to "skip" a migration unless you
  can prove, statement by statement, that its effects are fully present.
  Marking a half-applied migration as done is the single easiest way to
  corrupt this database.
- **Never run two migrators against the same database at once.**
- **Always validate the fixed migration on staging first**, then
  production. The migration files are the same; the data is not.

---

## 4. RPO / RTO targets

Targets are for the platform's own PostgreSQL data (the asset this runbook
protects). "Met" means there is an automated, CI- or cron-verified
mechanism; "not yet" means the gap is real and tracked.

| Target | Value | Status |
|---|---|---|
| **RPO** (max data loss) | ≤ 24 hours, via nightly `pg_dump -Fc` (§1.1) | ⚠️ **Not yet met** — the dump command is documented here but no backup cron or off-site copy is wired up in this repo. Until it is, RPO is "whenever someone last dumped by hand". |
| **RTO** (max downtime to restore service) | ≤ 4 hours: fresh DB → `pg_restore` → `npm run migrate` → smoke checks → cutover (§1.2) | ⚠️ **Partially met** — the restore procedure and the CI restore check (`verify-restore.sh`) exist, but no timed restore drill has been run against production-sized data. Schedule one. |

What already meets the spirit, even where the letter is open:

- Migrations are idempotent-by-construction on re-run, and the CI restore
  check proves a dumped schema re-migrates cleanly — so the restore path
  itself is tested on every CI run.
- RLS survives `pg_restore` (verified in step 5 of `verify-restore.sh`),
  so a restore does not silently widen tenant access.

What does **not** meet the targets yet:

- No point-in-time recovery: WAL archiving / continuous archiving is not
  configured, so recovery granularity is "last nightly dump", not "any
  second".
- No standby replica: a regional database outage is a restore-from-backup
  event, not a failover.
- Object storage has no RPO target of its own — document bytes are
  recoverable only via re-upload (§2.1) unless bucket versioning is enabled
  (§2.3).
- Secrets have no RPO/RTO in the data sense — see §5.

---

## 5. Secret recovery

### 5.1 Where secrets live

All secrets are environment-provided and validated at boot in
`backend/src/config.ts`. **Nothing secret lives in the repo** — keep it
that way.

| Secret | Env var | Used for |
|---|---|---|
| JWT signing secret | `JWT_SECRET` (≥ 32 chars, placeholders rejected at boot) | Signing/validating session JWTs |
| Database credentials | `DATABASE_URL` | All PostgreSQL access |
| Object storage credentials | `OBJECT_STORAGE_ACCESS_KEY` / `OBJECT_STORAGE_SECRET_KEY`, endpoint/bucket/region vars | S3-compatible document bytes |

In production these must come from a secret manager (AWS Secrets Manager,
Vault, etc.), injected at deploy time — never baked into images, never in
chat logs, never in `.env` files committed anywhere.

### 5.2 JWT secret rotation (planned, low-downtime)

Current state, honestly: the backend accepts a **single** `JWT_SECRET`
(`backend/src/config.ts`). Rotating it invalidates every outstanding
session and refresh token immediately — all users are logged out at once.
There is no `JWT_SECRET_PREVIOUS` dual-accept today; adding one is the
recommended follow-up before the first rotation.

Rotation procedure today:

```bash
# 1. Generate the new secret (64 hex chars; the >=32-char minimum is a floor, not a target)
NEW_SECRET=$(openssl rand -hex 32)

# 2. Store it in the secret manager FIRST, then roll the deployment.
#    Expect a hard logout for all users at cutover — schedule it in a
#    maintenance window and announce it.

# 3. After cutover, confirm: old tokens must now fail closed.
#    (Spot-check: a pre-rotation JWT presented to /api/v1/auth/me returns 401.)

# 4. Old refresh-token rows are now useless; they expire naturally.
#    No manual cleanup required.
```

### 5.3 Object storage credential rotation

The S3 client is constructed per-call from config (`storage.ts`), so
credential rotation needs no code change and no restart beyond config
reload: create the new access key alongside the old one, update the secret
manager, roll the deployment, then deactivate the old key. If both old and
new keys are valid during the roll, there is zero downtime.

### 5.4 What breaks if a secret is lost

- **JWT secret lost:** every session token becomes unverifiable — the
  entire user base is logged out and cannot stay logged in until a new
  secret is deployed. Recovery = generate a new secret (§5.2) and accept
  the logout event. There is no way to "recover" the old secret's sessions.
- **Database credentials lost/rotated without updating the app:** total
  outage (the pool cannot connect). Recovery = update `DATABASE_URL` in
  the secret manager and restart. Keep a break-glass database superuser
  credential in the secret manager, separate from the app's role.
- **Object storage keys lost:** document upload/download and ingestion
  fail; chat and auth keep working. Recovery = issue new keys (§5.3);
  documents already stored are unaffected once valid credentials return.

After any secret incident: rotate the affected secret even if you think
you recovered it, and check the audit log (`audit_events`) for access
during the exposure window.
