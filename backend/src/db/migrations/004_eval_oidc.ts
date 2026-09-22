/**
 * 004_eval_oidc — eval framework and OIDC collections (ADR-014).
 *
 * Ports SQL migrations 016_eval_results and 020_oidc_auth_requests /
 * 023_oidc_nonce_identity.
 *
 * Platform-level / pre-auth by design (no tenantId, no tenant isolation):
 *  - eval_runs / eval_case_results are an admin activity (gated by
 *    `model:manage`), intentionally outside tenant policies.
 *  - oidc_auth_requests / oidc_identities exist before any session; request
 *    rows are addressed by unguessable `state` values.
 *
 * `_id` conventions:
 *  - oidc_auth_requests: `_id` IS the `state` string (was the PK).
 *  - oidc_identities:    `_id = "<issuer>:<subject>"` (was PK(issuer, subject)).
 *
 * The PG `idx_oidc_auth_requests_expires` btree becomes a TTL index:
 * documents expire automatically at `expiresAt` (expireAfterSeconds: 0),
 * replacing the opportunistic app-side cleanup.
 */

import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';

export const migration004: Migration = {
  version: '004_eval_oidc',
  description:
    'Eval runs/results and OIDC auth-request/identity collections with indexes (TTL on OIDC request expiry)',

  up: async (db: Db): Promise<void> => {
    // ------------------------------------------------------------------
    // eval_runs / eval_case_results
    // ------------------------------------------------------------------
    await db
      .collection('eval_runs')
      .createIndex({ modelId: 1, createdAt: -1 }, { name: 'idx_eval_runs_model' });
    await db
      .collection('eval_case_results')
      .createIndex({ runId: 1 }, { name: 'idx_eval_case_results_run' });

    // ------------------------------------------------------------------
    // oidc_auth_requests — _id is the unguessable `state` value
    // ------------------------------------------------------------------
    // TTL index: the server deletes the document as soon as expiresAt passes.
    // Only documents where expiresAt is a BSON date are eligible; every auth
    // request row sets it (10-minute lifetime per the 020 design).
    await db.collection('oidc_auth_requests').createIndex(
      { expiresAt: 1 },
      {
        name: 'idx_oidc_auth_requests_expires',
        expireAfterSeconds: 0,
      }
    );

    // ------------------------------------------------------------------
    // oidc_identities — _id = "<issuer>:<subject>"
    // ------------------------------------------------------------------
    await db
      .collection('oidc_identities')
      .createIndex({ userId: 1 }, { name: 'idx_oidc_identities_user' });
  },
};
