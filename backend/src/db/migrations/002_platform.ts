/**
 * 002_platform — conversations, models, audit collections (ADR-014).
 *
 * Ports SQL migrations 001_init (conversations/messages/models/audit_events
 * DDL), 003_enterprise_platform (model_access, sessions moved to 001,
 * documents moved to 003), 007_model_tuning, 015_message_metadata,
 * 017_model_lifecycle (model_serving_defaults), 021_retention (legal_hold
 * columns, purge indexes), 024_capability_routing, 025_capability_routing_rls.
 *
 * Composite-key tables use a deterministic string `_id` so "primary key"
 * uniqueness is enforced by MongoDB itself:
 *  - model_serving_defaults:  `_id = "<tenantId>:<capability>"`
 *  - model_routing_policies: `_id = "<tenantId>:<capability>"`
 *
 * The `model_access` UNIQUE NULLS NOT DISTINCT (tenant_id, model_id,
 * role_id, user_id) becomes a SPARSE unique index: exactly one of roleId /
 * userId must be present per document, and the ABSENT field must be omitted
 * (not stored as null) — sparse indexes only skip documents where the field
 * is missing. The "exactly one principal" check is application-level.
 *
 * RLS policies are not ported (defense in depth only); every application
 * query filters `tenantId` explicitly.
 */

import { randomUUID } from 'crypto';
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll } from './helpers.js';

/** The 002_seed.sql APPROVED model row. 017 remapped legacy APPROVED → ACTIVE,
 *  so fresh MongoDB databases seed the post-017 final state directly. */
const SEED_MODEL = {
  name: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  version: '1.0',
  provider: 'vllm',
  endpoint: 'http://vllm:8000/v1',
  status: 'ACTIVE',
  license: 'llama3.1',
  source: 'meta',
  contextWindow: 131072,
  capabilities: { chat: true, streaming: true },
  classification: 'INTERNAL',
  // 003 backfilled model_identifier = name and made it NOT NULL.
  modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct',
  enabled: true,
  deployment: {},
  allowedClassifications: ['PUBLIC', 'INTERNAL'],
} as const;

export const migration002: Migration = {
  version: '002_platform',
  description:
    'Conversations, messages, models, model access/routing, audit events, tool executions with indexes and the seed model',

  up: async (db: Db): Promise<void> => {
    // ------------------------------------------------------------------
    // conversations
    // ------------------------------------------------------------------
    await db.collection('conversations').createIndex(
      { tenantId: 1, userId: 1, updatedAt: -1 },
      { name: 'idx_conversations_tenant_user' }
    );
    // Retention purge scan (021): expired rows per tenant excluding holds.
    await db.collection('conversations').createIndex(
      { tenantId: 1, updatedAt: 1 },
      {
        name: 'idx_conversations_retention_purge',
        partialFilterExpression: { legalHold: false },
      }
    );

    // ------------------------------------------------------------------
    // messages
    // ------------------------------------------------------------------
    await db.collection('messages').createIndex(
      { conversationId: 1, createdAt: 1 },
      { name: 'idx_messages_conversation' }
    );
    await db
      .collection('messages')
      .createIndex(
        { tenantId: 1, createdAt: 1 },
        { name: 'idx_messages_retention_purge' }
      );

    // ------------------------------------------------------------------
    // models
    // ------------------------------------------------------------------
    await db
      .collection('models')
      .createIndex({ name: 1 }, { unique: true, name: 'idx_models_name' });
    await db
      .collection('models')
      .createIndex({ status: 1 }, { name: 'idx_models_status' });
    // Gateway servable-set filter (017): only ACTIVE/CANARY serve traffic.
    await db.collection('models').createIndex(
      { status: 1 },
      {
        name: 'idx_models_lifecycle_status',
        partialFilterExpression: { status: { $in: ['ACTIVE', 'CANARY'] } },
      }
    );

    // ------------------------------------------------------------------
    // model_access — tenant/model grant to exactly one of (role, user)
    // ------------------------------------------------------------------
    await db
      .collection('model_access')
      .createIndex(
        { tenantId: 1, modelId: 1 },
        { name: 'idx_model_access_tenant_model' }
      );
    // OR-condition legs on the hot chat path (008): bitmapOr-able equality
    // legs with tenant scoping.
    await db
      .collection('model_access')
      .createIndex(
        { tenantId: 1, userId: 1 },
        { name: 'idx_model_access_tenant_user' }
      );
    await db
      .collection('model_access')
      .createIndex(
        { tenantId: 1, roleId: 1 },
        { name: 'idx_model_access_tenant_role' }
      );
    // UNIQUE NULLS NOT DISTINCT → sparse unique; the absent principal field
    // must be omitted (not null) for the sparse index to permit multiples.
    await db.collection('model_access').createIndex(
      { tenantId: 1, modelId: 1, roleId: 1, userId: 1 },
      { unique: true, sparse: true, name: 'idx_model_access_principal_unique' }
    );

    // ------------------------------------------------------------------
    // model_serving_defaults / model_routing_policies
    // (composite _id enforces the former PKs; upserts become updateOne with
    //  upsert:true on _id)
    // ------------------------------------------------------------------
    await db
      .collection('model_routing_policies')
      .createIndex({ tenantId: 1 }, { name: 'idx_model_routing_policies_tenant' });

    // ------------------------------------------------------------------
    // audit_events
    // ------------------------------------------------------------------
    await db.collection('audit_events').createIndex(
      { tenantId: 1, createdAt: -1 },
      { name: 'idx_audit_events_tenant_created' }
    );
    await db.collection('audit_events').createIndex(
      { tenantId: 1, action: 1, createdAt: -1 },
      { name: 'idx_audit_events_tenant_action_created' }
    );
    await db.collection('audit_events').createIndex(
      { tenantId: 1, createdAt: 1 },
      {
        name: 'idx_audit_events_retention_purge',
        partialFilterExpression: { legalHold: false },
      }
    );
    // NOTE: audit_events.tenantId is nullable by design — the custom PG RLS
    // policy allowed tenant-less (global) audit rows. MongoDB queries must
    // handle `tenantId: null` explicitly where global reads are intended.

    // ------------------------------------------------------------------
    // tool_executions
    // ------------------------------------------------------------------
    await db.collection('tool_executions').createIndex(
      { tenantId: 1, createdAt: -1 },
      { name: 'idx_tool_executions_tenant_created' }
    );

    // ------------------------------------------------------------------
    // Seed: the APPROVED model row (idempotent by unique name)
    // ------------------------------------------------------------------
    // 003 also seeded model_access (tenants × APPROVED models × staff roles);
    // on a fresh database there are no tenants yet, so that cross-product
    // seed is a no-op and is intentionally not reproduced here. Tenant staff
    // grants are created when tenants are provisioned.
    const existing = await coll(db, 'models').findOne(
      { name: SEED_MODEL.name },
      { projection: { _id: 1 } }
    );
    if (!existing) {
      const now = new Date();
      await coll(db, 'models').insertOne({
        _id: randomUUID(),
        ...SEED_MODEL,
        // 007 tuning columns default to "provider decides".
        requestTimeoutMs: null,
        maxTokens: null,
        temperature: null,
        fallbackModelId: null,
        lifecycleUpdatedAt: now,
        approvedBy: null,
        approvedAt: null,
        lastEvalRunId: null,
        createdAt: now,
      });
    }
  },
};
