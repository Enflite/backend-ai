# ADR-014: Migrate persistence from PostgreSQL to MongoDB Atlas

**Status:** Accepted  
**Date:** 2026-09-22  
**Deciders:** Jake Smith  

## Context

The platform's persistence layer is PostgreSQL 16 with pgvector (27 SQL
migrations, 33 tables, row-level security, HNSW vector indexes). Operations
and the AI workload benefit from MongoDB Atlas:

- **Atlas Vector Search** replaces pgvector HNSW indexes natively, keeping
  the RAG and repo-code vector search on the same operational database.
- **Flexible schema** fits the JSONB-heavy workload (`messages.metadata`,
  `audit_events.metadata`, `models.capabilities`, `tool_executions.parameters`)
  without DDL migrations for every new field.
- **Managed Atlas** removes PostgreSQL/pgvector operational burden; the
  target is `mongodb+srv://cluster0.q6kjgmp.mongodb.net/enflite-ai`.

## Decision

Replace the PostgreSQL persistence layer with MongoDB Atlas:

1. **Driver:** official `mongodb` Node.js driver. Single `MongoClient`,
   `MONGODB_URI` env var replaces `DATABASE_URL`.
2. **IDs:** UUID strings in `_id` (keeps existing UUID-based code paths
   stable; no ObjectId migration).
3. **Tenant isolation:** application-level `tenantId` equality filter on every
   query — this was already the primary enforcement (ADR-004); PostgreSQL RLS
   was defense-in-depth and has no MongoDB equivalent. The tenant-isolation
   test suite is ported to assert the filter, not RLS policies.
4. **Migrations:** versioned runner against a `schema_migrations` collection
   (`{_id: version, appliedAt}`). Each migration is an idempotent TypeScript
   module that creates collections, indexes (including partial and Atlas
   Vector Search indexes), and seed data. SQL migration files are retired.
5. **Vector search:** Atlas `$vectorSearch` on `document_chunks.embedding` and
   `repo_code_chunks.embedding` (1536 dims, cosine). Tenant/ACL/
   classification filters move into `$vectorSearch.filter`. If Atlas Search
   is unavailable, the retrieval layer falls back to application-side
   brute-force cosine over a bounded candidate set (clearly labeled
   `REQUIRES REAL INFRASTRUCTURE` in tests).
6. **Transactions:** MongoDB multi-document transactions replace `withTx` /
   `withTenantTx` (Atlas is a replica set). `findOneAndUpdate` covers the
   `SELECT ... FOR UPDATE SKIP LOCKED` job-claim pattern atomically.
7. **Secrets:** the connection string is never committed. `MONGODB_URI` comes
   from the environment / secret manager. `.env.example` documents the
   placeholder only.

## Consequences

- All 27 SQL migrations are superseded; fresh Atlas deployments run the
  MongoDB migration chain.
- **Existing PostgreSQL data:** This ADR does NOT authorize silently discarding
  live PostgreSQL data. Before any production cutover, one of the following
  must be completed:
  1. **Idempotent PostgreSQL→MongoDB importer** — a one-time migration script
     that reads from the live PostgreSQL database and writes to MongoDB with:
     - Dry-run mode (counts and samples without writing)
     - Provenance tracking (source table/row → destination document)
     - Tenant scoping (migrates tenant-by-tenant, never cross-tenant)
     - Reconciliation checks (row counts match, spot-check field values)
     - Restart safety (idempotent — safe to re-run after failure)
     - Audit records of what was migrated, when, and by whom
  2. **Explicit zero-data confirmation** — if the PostgreSQL database is
     confirmed to contain no production data (dev/test only), document this
     explicitly with evidence (table row counts, deployment history) and
     obtain Jake's sign-off before cutover.
  
  The importer (option 1) is the default expectation. Option 2 requires
  affirmative evidence, not assumption.
- `backend/test/rlsEnforcement.test.ts` is replaced with a tenant-isolation
  test asserting application-level `tenantId` scoping.
- `docker-compose.yml` drops the `postgres` service; local dev uses a local
  `mongod` or Atlas.
- Vector-search quality now depends on the Atlas Search index build; the
  deterministic mock path in CI is unchanged.
