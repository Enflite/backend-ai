/**
 * 005_repos_memory — repository code index, user memory and retention
 * collections (ADR-014).
 *
 * Ports SQL migrations 026_repo_index (repos, repo_code_chunks, repo_files,
 * repo permissions — the permission/grant rows live in 001_init), 021_retention
 * (retention_policies) and 027_user_memory (memory_facts).
 *
 * `_id` conventions:
 *  - retention_policies: `_id` IS the tenantId string (was PK(tenant_id)).
 *
 * VECTOR SEARCH: the HNSW index on `repo_code_chunks.embedding`
 * (1536 dims, cosine) becomes an Atlas Vector Search index, which CANNOT be
 * created through the MongoDB driver. Provision it with
 * `backend/src/db/createVectorIndexes.ts` (Atlas Admin API) — see the comment
 * on the repo_code_chunks section below.
 *
 * Application-level invariants replacing PG CHECK constraints (documented
 * for the data-layer port; NOT enforced by these migrations):
 *  - repos: exactly one of gitUrl / localPath is set.
 *  - memory_facts.fact: 1–2000 chars; category ∈ preference/fact/project.
 *  - memory_facts writes are scoped by (tenantId, userId) — a user can only
 *    ever touch their own rows; no role is granted another user's memories.
 */

import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';

export const migration005: Migration = {
  version: '005_repos_memory',
  description:
    'Repository code index (repos, chunks, files), user memory facts and retention policies with indexes',

  up: async (db: Db): Promise<void> => {
    // ------------------------------------------------------------------
    // repos
    // ------------------------------------------------------------------
    await db
      .collection('repos')
      .createIndex(
        { tenantId: 1, name: 1 },
        { unique: true, name: 'idx_repos_tenant_name' }
      );
    await db
      .collection('repos')
      .createIndex({ tenantId: 1, status: 1 }, { name: 'idx_repos_tenant_status' });

    // ------------------------------------------------------------------
    // repo_code_chunks
    // ------------------------------------------------------------------
    await db.collection('repo_code_chunks').createIndex(
      { repoId: 1, path: 1, chunkIndex: 1 },
      { unique: true, name: 'idx_repo_code_chunks_unique' }
    );
    await db
      .collection('repo_code_chunks')
      .createIndex(
        { tenantId: 1, repoId: 1 },
        { name: 'idx_repo_code_chunks_tenant_repo' }
      );
    // VECTOR SEARCH INDEX (Atlas-only):
    //   name:       idx_repo_code_chunks_embedding_vector
    //   collection: repo_code_chunks
    //   field:      embedding — vector, 1536 dimensions, cosine similarity
    // The MongoDB driver cannot create Atlas Search indexes; run
    // `backend/src/db/createVectorIndexes.ts` (Atlas Admin API) or create it
    // in the Atlas UI. The $vectorSearch `filter` carries the tenant / repo
    // status / classification / embedding-provenance predicates.
    //
    // `embedding` is stored as a plain number array of length 1536.

    // ------------------------------------------------------------------
    // repo_files — the unique index doubles as the (tenantId, repoId, path)
    // lookup index (it was a strict prefix duplicate in PG as well).
    // ------------------------------------------------------------------
    await db.collection('repo_files').createIndex(
      { tenantId: 1, repoId: 1, path: 1 },
      { unique: true, name: 'idx_repo_files_tenant_repo_path' }
    );

    // ------------------------------------------------------------------
    // memory_facts — most-recent-first per-user listing drives the prompt
    // injection path (ORDER BY updatedAt DESC).
    // ------------------------------------------------------------------
    await db.collection('memory_facts').createIndex(
      { tenantId: 1, userId: 1, updatedAt: -1 },
      { name: 'idx_memory_facts_tenant_user' }
    );

    // ------------------------------------------------------------------
    // retention_policies — _id is the tenantId (one row per tenant).
    // Upserts become updateOne({ _id: tenantId }, ..., { upsert: true }).
    // ------------------------------------------------------------------
  },
};
