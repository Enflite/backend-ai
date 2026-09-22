/**
 * 003_documents_rag — documents, RAG and ingestion collections (ADR-014).
 *
 * Ports SQL migrations 003_enterprise_platform (documents,
 * document_permissions, document_chunks DDL), 004_secure_rag (departments,
 * security_groups, memberships, ACL widening, embedding provenance, HNSW),
 * 005_performance_indexes, 008_query_performance, 014_audit_fixes and
 * 018_ingestion_jobs (worker-pool columns and indexes).
 *
 * VECTOR SEARCH: the HNSW indexes on `document_chunks.embedding`
 * (1536 dims, cosine) become Atlas Vector Search indexes, which CANNOT be
 * created through the MongoDB driver. They are provisioned by
 * `backend/src/db/createVectorIndexes.ts` (Atlas Admin API) — see the
 * comments on the document_chunks section below.
 *
 * Partial unique indexes use `partialFilterExpression`:
 *  - document_ingestion_jobs active-document dedupe and idempotency dedupe
 *    mirror the PG partial UNIQUE indexes; the ingestion queue's
 *    ON CONFLICT ... DO NOTHING becomes updateOne with $setOnInsert/upsert
 *    (or a pre-check) against these indexes.
 *  - document_permissions' UNIQUE NULLS NOT DISTINCT becomes a SPARSE
 *    unique index: exactly one principal field (userId/roleId/departmentId/
 *    groupId) must be present per document, and ABSENT fields must be
 *    omitted (not null) — sparse indexes only skip missing fields. The
 *    "exactly one principal" check is application-level.
 */

import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';

/** Embedding contract shared with the Atlas Vector Search index definition. */
export const EMBEDDING_DIMENSIONS = 1536;

export const migration003: Migration = {
  version: '003_documents_rag',
  description:
    'Documents, document permissions/chunks, ingestion jobs, departments and security groups with indexes',

  up: async (db: Db): Promise<void> => {
    // ------------------------------------------------------------------
    // documents
    // ------------------------------------------------------------------
    await db.collection('documents').createIndex(
      { tenantId: 1, checksumSha256: 1 },
      { unique: true, name: 'idx_documents_tenant_checksum' }
    );
    // Soft-delete-aware listing indexes: `deletedAt: null` in the partial
    // filter matches documents where the field is null OR absent.
    await db.collection('documents').createIndex(
      { tenantId: 1, ownerId: 1, createdAt: -1 },
      {
        name: 'idx_documents_tenant_owner',
        partialFilterExpression: { deletedAt: null },
      }
    );
    await db.collection('documents').createIndex(
      { tenantId: 1, createdAt: -1 },
      {
        name: 'idx_documents_tenant_created',
        partialFilterExpression: { deletedAt: null },
      }
    );

    // ------------------------------------------------------------------
    // document_permissions
    // ------------------------------------------------------------------
    await db.collection('document_permissions').createIndex(
      {
        tenantId: 1,
        documentId: 1,
        userId: 1,
        roleId: 1,
        departmentId: 1,
        groupId: 1,
      },
      { name: 'idx_document_permissions_lookup' }
    );
    await db.collection('document_permissions').createIndex(
      { documentId: 1, userId: 1, roleId: 1, departmentId: 1, groupId: 1 },
      {
        unique: true,
        sparse: true,
        name: 'idx_document_permissions_principal_unique',
      }
    );

    // ------------------------------------------------------------------
    // document_chunks
    // ------------------------------------------------------------------
    await db.collection('document_chunks').createIndex(
      { documentId: 1, chunkIndex: 1 },
      { unique: true, name: 'idx_document_chunks_document_chunk' }
    );
    await db.collection('document_chunks').createIndex(
      { tenantId: 1, documentId: 1, createdAt: -1 },
      { name: 'idx_document_chunks_document_created' }
    );
    // VECTOR SEARCH INDEX (Atlas-only):
    //   name:       idx_document_chunks_embedding_vector
    //   collection: document_chunks
    //   field:      embedding — vector, 1536 dimensions, cosine similarity
    // The MongoDB driver cannot create Atlas Search indexes; run
    // `backend/src/db/createVectorIndexes.ts` (Atlas Admin API) or create it
    // in the Atlas UI. The $vectorSearch `filter` carries the tenant /
    // classification / ACL predicates that the PG query applied around the
    // `<=>` ordering (see db-inventory §4).
    //
    // `embedding` is stored as a plain number array of length 1536; the
    // provenance fields (embeddingModel/embeddingVersion/embeddingDimensions)
    // pin retrieval to one embedding configuration, mirroring the 004 checks.

    // ------------------------------------------------------------------
    // document_ingestion_jobs
    // ------------------------------------------------------------------
    // Active-job dedupe: at most one PENDING/PROCESSING job per document.
    await db.collection('document_ingestion_jobs').createIndex(
      { documentId: 1 },
      {
        unique: true,
        name: 'idx_ingestion_jobs_active_document',
        partialFilterExpression: { status: { $in: ['PENDING', 'PROCESSING'] } },
      }
    );
    // Worker claim scans (008 + 018): pending-claim and stale-reclaim paths.
    await db.collection('document_ingestion_jobs').createIndex(
      { availableAt: 1, createdAt: 1 },
      {
        name: 'idx_ingestion_jobs_pending',
        partialFilterExpression: { status: 'PENDING' },
      }
    );
    await db.collection('document_ingestion_jobs').createIndex(
      { tenantId: 1, createdAt: 1 },
      {
        name: 'idx_ingestion_jobs_tenant_pending',
        partialFilterExpression: { status: 'PENDING' },
      }
    );
    await db.collection('document_ingestion_jobs').createIndex(
      { tenantId: 1, lockedAt: 1 },
      {
        name: 'idx_ingestion_jobs_tenant_stale',
        partialFilterExpression: { status: 'PROCESSING' },
      }
    );
    // Idempotency dedupe (018): at most one in-flight job per (tenant, key);
    // terminal jobs do not block later reuse of a key.
    await db.collection('document_ingestion_jobs').createIndex(
      { tenantId: 1, idempotencyKey: 1 },
      {
        unique: true,
        name: 'idx_ingestion_jobs_idempotency',
        partialFilterExpression: {
          idempotencyKey: { $ne: null },
          status: { $in: ['PENDING', 'PROCESSING'] },
        },
      }
    );
    // Backoff-aware claim path (018): oldest-due PENDING job per tenant.
    await db.collection('document_ingestion_jobs').createIndex(
      { tenantId: 1, nextAttemptAt: 1, createdAt: 1 },
      {
        name: 'idx_ingestion_jobs_claim',
        partialFilterExpression: { status: 'PENDING' },
      }
    );
    // NOTE: the worker's SELECT ... FOR UPDATE SKIP LOCKED claim becomes an
    // atomic findOneAndUpdate (status PENDING → PROCESSING) in MongoDB; the
    // tenant round-robin fairness logic stays in application code.

    // ------------------------------------------------------------------
    // departments / security_groups and their memberships
    // ------------------------------------------------------------------
    await db.collection('departments').createIndex(
      { tenantId: 1, name: 1 },
      { unique: true, name: 'idx_departments_tenant_name' }
    );
    await db.collection('security_groups').createIndex(
      { tenantId: 1, name: 1 },
      { unique: true, name: 'idx_security_groups_tenant_name' }
    );
    await db.collection('department_memberships').createIndex(
      { departmentId: 1, userId: 1 },
      { unique: true, name: 'idx_department_memberships_pk' }
    );
    await db.collection('security_group_memberships').createIndex(
      { groupId: 1, userId: 1 },
      { unique: true, name: 'idx_security_group_memberships_pk' }
    );
  },
};
