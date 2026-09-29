import { randomUUID } from 'node:crypto';
import { getDb, tenantOp } from '../../db/mongo.js';
import { Errors } from '../../errors.js';
import { Classification } from '../../authz/permissions.js';
import { config } from '../../config.js';
import type { ProviderGroup } from '../providers/providerDisplay.js';

/**
 * Canonical tenant default model. Default-open serving: this model is
 * implicitly available to every user in every tenant — no `model_access`
 * grant row required — unless explicitly revoked for their principal.
 * It is also the last-resort fallback for model resolution, so chat can
 * never dead-end on NO_APPROVED_MODEL in normal operation.
 */
export const DEFAULT_MODEL_NAME = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

/**
 * Canonical name of the platform vision model (ADR-017). Image attachments
 * are routed to this model automatically: the text default is text-only and
 * must never receive image payloads.
 */
export const VISION_MODEL_NAME = 'qwen/Qwen2.5-VL-7B-Instruct';
/** Ollama tag pulled for the vision model (see backend/scripts/setup-ollama-windows.ps1). */
export const VISION_MODEL_OLLAMA_TAG = 'qwen2.5vl:7b';

/** Statuses the gateway will serve traffic to (mirrors modelLifecycle). */
const SERVABLE_STATUSES = ['ACTIVE', 'CANARY'] as const;

export interface ApprovedModel {
  id: string;
  name: string;
  version: string;
  provider: string;
  endpoint: string;
  modelIdentifier: string;
  /** Lifecycle status; the gateway only serves ACTIVE and CANARY models. */
  status: 'ACTIVE' | 'CANARY';
  license: string | null;
  source: string | null;
  sha256: string | null;
  contextWindow: number;
  capabilities: Record<string, unknown>;
  allowedClassifications: Classification[];
  deployment: Record<string, unknown>;
  /** Per-model inference timeout override (ms); null = server default. */
  requestTimeoutMs: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  maxTokens: number | null;
  /** Passed to OpenAI-compatible providers; null = provider default. */
  temperature: number | null;
  /** Fail over to this model (once, no chains) when the primary fails. */
  fallbackModelId: string | null;
  createdAt: Date;
  /** Cloud provider's preferred chat model (used by the UI provider switcher). */
  isProviderDefault?: boolean;
}

/**
 * MongoDB document shape for the `models` collection: camelCase fields,
 * `_id` is the UUID string (ADR-014). `enabled` and `isDefault` are
 * storage-only — they are not part of the ApprovedModel view.
 */
type ModelDoc = Omit<ApprovedModel, 'id'> & {
  _id: string;
  enabled: boolean;
  /** Marks the tenant default model (set by migration 029; self-healed by ensure). */
  isDefault?: boolean;
  /** Marks the platform vision default model (self-healed by ensure). */
  isVisionDefault?: boolean;
  /** Marks a cloud provider's default chat model (preferred on provider switch). */
  isProviderDefault?: boolean;
  /** Marks platform cloud seeds ('claude' | 'openai'): default-open, unlike admin-registered models. */
  seededProvider?: string;
};

/** MongoDB document shape for the `model_access` collection. */
interface ModelAccessDoc {
  _id: string;
  tenantId: string;
  modelId: string;
  userId?: string;
  roleId?: string;
  /**
   * Explicit denial for this principal+model. Default-open serving treats a
   * missing row as "allowed" for the default model, so revocation must be
   * written explicitly — deleting a grant row no longer revokes the default.
   */
  revoked?: boolean;
  createdAt: Date;
}

function toApprovedModel(doc: ModelDoc): ApprovedModel {
  const { _id, enabled: _enabled, isDefault: _isDefault, isVisionDefault: _isVisionDefault, seededProvider: _seededProvider, ...rest } = doc;
  return { id: _id, ...rest };
}

/** True when this model doc is the tenant default (flag or canonical name). */
export function isDefaultModelDoc(doc: { name: string; isDefault?: boolean }): boolean {
  return doc.isDefault === true || doc.name === DEFAULT_MODEL_NAME;
}

/** True when this model doc is the platform vision default (flag or canonical name). */
export function isVisionDefaultModelDoc(doc: { name: string; isVisionDefault?: boolean }): boolean {
  return doc.isVisionDefault === true || doc.name === VISION_MODEL_NAME;
}

/** True when the approved model advertises vision capability. */
export function isVisionCapableModel(model: { capabilities?: Record<string, unknown> }): boolean {
  return model.capabilities?.['vision'] === true;
}

type MinimalDb = {
  collection<T>(name: string): {
    findOne(filter: unknown, options?: unknown): Promise<T | null>;
    find(filter: unknown): { sort(spec: unknown): { toArray(): Promise<T[]> } };
    updateOne(filter: unknown, update: unknown): Promise<unknown>;
    updateMany(filter: unknown, update: unknown): Promise<unknown>;
    insertOne(doc: unknown): Promise<unknown>;
  };
};

/** The servable tenant default model doc, if one exists. Prefers an
 * operator-flagged default (`isDefault`) over the canonical seed name. */
async function findServableDefaultModel(db: MinimalDb): Promise<ModelDoc | null> {
  const flagged = await db.collection<ModelDoc>('models').findOne({
    isDefault: true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
  if (flagged) return flagged;
  return db.collection<ModelDoc>('models').findOne({
    name: DEFAULT_MODEL_NAME,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
}

/**
 * Seed shape for the platform default model (mirrors migration 002's seed
 * with migration 028's Ollama repoint). Used only by ensureTenantDefaultModel
 * when the `models` collection has no default at all.
 *
 * The endpoint comes from config.OLLAMA_BASE_URL — never a hardcoded docker
 * URL — so native (non-docker) deployments seed a reachable endpoint.
 */
function defaultModelSeed(now: Date): Record<string, unknown> {
  return {
    _id: randomUUID(),
    name: DEFAULT_MODEL_NAME,
    version: '1.0',
    provider: 'ollama',
    endpoint: config.OLLAMA_BASE_URL,
    modelIdentifier: 'llama3.1:8b',
    status: 'ACTIVE',
    license: 'llama3.1',
    source: 'meta',
    sha256: null,
    contextWindow: 131072,
    capabilities: { chat: true, streaming: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    isDefault: true,
    enabled: true,
    lifecycleUpdatedAt: now,
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: now,
  };
}

/**
 * The docker-compose Ollama URL baked into pre-fix seeds (and migration
 * 028). On a native (non-docker) deployment the chat path uses the model
 * doc's endpoint, so a doc still pointing here could never reach Ollama no
 * matter what OLLAMA_BASE_URL was set to — and the admin API had no way to
 * change it. When the configured OLLAMA_BASE_URL differs, a doc pointing at
 * exactly this URL is stale (never a deliberate choice: 'ollama' is the
 * compose service name) and is refreshed on read. Admin-customized
 * endpoints — anything other than this exact URL — are never touched.
 */
const STALE_DOCKER_OLLAMA_ENDPOINT = 'http://ollama:11434';

function normalizeEndpoint(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value.replace(/\/+$/, '') : null;
}

/** True when the doc's endpoint is the stale docker URL and config says otherwise. */
export function isStaleOllamaEndpoint(docEndpoint: unknown): boolean {
  const doc = normalizeEndpoint(docEndpoint);
  const configured = normalizeEndpoint(config.OLLAMA_BASE_URL);
  return doc === STALE_DOCKER_OLLAMA_ENDPOINT && configured !== null && configured !== STALE_DOCKER_OLLAMA_ENDPOINT;
}

/**
 * Refresh a stale docker Ollama endpoint on a platform seed doc in memory.
 * Returns true when the doc was stale; the caller folds the endpoint into
 * its own $set so there is exactly one write.
 */
function staleOllamaEndpointRefresh(doc: ModelDoc): boolean {
  if (!isStaleOllamaEndpoint(doc.endpoint)) return false;
  doc.endpoint = config.OLLAMA_BASE_URL;
  return true;
}

/**
 * Ensure the tenant default model exists and is servable (create-on-read).
 * Idempotent: safe to call on every resolution miss.
 *
 * - Returns the servable default when one exists (self-healing the
 *   `isDefault` flag on the canonical seed doc when needed, and refreshing
 *   a stale docker Ollama endpoint to the configured OLLAMA_BASE_URL).
 * - Returns null WITHOUT creating anything when the default-named doc
 *   exists but is not servable: an admin deliberately disabled it, and
 *   resurrecting it would override that decision.
 * - Inserts the seed default only when no model doc exists at all
 *   (wiped/dev database); a duplicate-key race re-reads instead of failing.
 */
export async function ensureTenantDefaultModel(): Promise<ApprovedModel | null> {
  // Claude-only launch: the tenant default is the Claude model, never the
  // Ollama seed — no Ollama doc is created, resolved, or flagged default.
  if (!config.OLLAMA_ENABLED) return ensureTenantDefaultCloudModel();
  const db = (await getDb()) as unknown as MinimalDb;
  const existing = await findServableDefaultModel(db);
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (existing.isDefault !== true) updates.isDefault = true;
    if (staleOllamaEndpointRefresh(existing)) updates.endpoint = existing.endpoint;
    if (Object.keys(updates).length > 0) {
      await db.collection<ModelDoc>('models').updateOne({ _id: existing._id }, { $set: updates });
    }
    return toApprovedModel(existing);
  }
  const named = await db
    .collection<ModelDoc>('models')
    .findOne({ name: DEFAULT_MODEL_NAME }, { projection: { _id: 1 } });
  if (named) return null;
  const now = new Date();
  try {
    const seed = defaultModelSeed(now);
    await db.collection<ModelDoc>('models').insertOne(seed);
    return toApprovedModel(seed as unknown as ModelDoc);
  } catch (err) {
    if ((err as { code?: number })?.code !== 11000) throw err;
    const raced = await findServableDefaultModel(db);
    return raced ? toApprovedModel(raced) : null;
  }
}

/**
 * Tenant default for the Claude-only launch (OLLAMA_ENABLED=false).
 *
 * The default is the configured Claude model — flagged `isDefault` so
 * later reads find it by flag. An admin-flagged default of any still-
 * servable provider wins; a stale Ollama default flag (from before the
 * flag was flipped) is retired because an Ollama doc cannot serve while
 * the flag is off. No Ollama doc is ever created on this path.
 *
 * Returns null when no servable default exists (Claude not configured):
 * the caller surfaces MODEL_UNAVAILABLE rather than a dead model.
 */
async function ensureTenantDefaultCloudModel(): Promise<ApprovedModel | null> {
  const db = (await getDb()) as unknown as MinimalDb;
  await db
    .collection<ModelDoc>('models')
    .updateMany({ provider: 'ollama', isDefault: true }, { $set: { isDefault: false } });
  const existing = await findServableDefaultModel(db);
  if (existing && existing.provider !== 'ollama') {
    return toApprovedModel(existing);
  }
  if (!isClaudeConfigured()) return null;
  await ensureCloudProviderModels();
  const claude = await db.collection<ModelDoc>('models').findOne({
    provider: 'claude',
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
  if (!claude) return null;
  if (claude.isDefault !== true) {
    await db.collection<ModelDoc>('models').updateOne({ _id: claude._id }, { $set: { isDefault: true } });
  }
  return toApprovedModel({ ...claude, isDefault: true });
}

/** The servable vision default model doc, if one exists. Prefers an
 * operator-flagged vision default (`isVisionDefault`) over the canonical
 * seed name. Both legs require the vision capability: a text-only model in
 * the vision slot must never be returned for an image turn (a misconfigured
 * admin default falls through to the canonical seed instead). */
async function findServableVisionModel(db: MinimalDb): Promise<ModelDoc | null> {
  const flagged = await db.collection<ModelDoc>('models').findOne({
    isVisionDefault: true,
    'capabilities.vision': true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
  if (flagged) return flagged;
  return db.collection<ModelDoc>('models').findOne({
    name: VISION_MODEL_NAME,
    'capabilities.vision': true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
}

/**
 * Seed shape for the platform vision model. Served by Ollama under the
 * `qwen2.5vl:7b` tag; image attachments are routed to this model
 * automatically. Context window is the model's native 32k.
 *
 * The endpoint comes from config.OLLAMA_BASE_URL — never a hardcoded docker
 * URL — so native (non-docker) deployments seed a reachable endpoint.
 */
function visionModelSeed(now: Date): Record<string, unknown> {
  return {
    _id: randomUUID(),
    name: VISION_MODEL_NAME,
    version: '1.0',
    provider: 'ollama',
    endpoint: config.OLLAMA_BASE_URL,
    modelIdentifier: VISION_MODEL_OLLAMA_TAG,
    status: 'ACTIVE',
    license: 'apache-2.0',
    source: 'qwen',
    sha256: null,
    contextWindow: 32768,
    capabilities: { chat: true, streaming: true, vision: true },
    classification: 'INTERNAL',
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    isDefault: false,
    isVisionDefault: true,
    enabled: true,
    lifecycleUpdatedAt: now,
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: now,
  };
}

/**
 * Ensure the platform vision model exists and is servable (create-on-read).
 * Idempotent: safe to call on every resolution miss.
 *
 * - Returns the servable vision model when one exists (self-healing the
 *   `isVisionDefault` flag on the canonical seed doc when needed, and
 *   refreshing a stale docker Ollama endpoint to the configured
 *   OLLAMA_BASE_URL).
 * - Returns null WITHOUT creating anything when the vision-named doc
 *   exists but is not servable: an admin deliberately disabled it, and
 *   resurrecting it would override that decision.
 * - Inserts the seed vision model only when no vision-capable servable doc
 *   exists; a duplicate-key race re-reads instead of failing.
 */
export async function ensureVisionModel(): Promise<ApprovedModel | null> {
  // Claude-only launch: the Qwen vision seed must never be created —
  // image turns resolve the configured Claude vision model instead (see
  // resolveVisionModel in capabilityRouter.ts).
  if (!config.OLLAMA_ENABLED) return null;
  const db = (await getDb()) as unknown as MinimalDb;
  const existing = await findServableVisionModel(db);
  if (existing) {
    const updates: Record<string, unknown> = {};
    if (existing.isVisionDefault !== true) updates.isVisionDefault = true;
    if (staleOllamaEndpointRefresh(existing)) updates.endpoint = existing.endpoint;
    if (Object.keys(updates).length > 0) {
      await db.collection<ModelDoc>('models').updateOne({ _id: existing._id }, { $set: updates });
    }
    return toApprovedModel(existing);
  }
  const named = await db
    .collection<ModelDoc>('models')
    .findOne({ name: VISION_MODEL_NAME }, { projection: { _id: 1 } });
  if (named) return null;
  const now = new Date();
  try {
    const seed = visionModelSeed(now);
    await db.collection<ModelDoc>('models').insertOne(seed);
    return toApprovedModel(seed as unknown as ModelDoc);
  } catch (err) {
    if ((err as { code?: number })?.code !== 11000) throw err;
    const raced = await findServableVisionModel(db);
    return raced ? toApprovedModel(raced) : null;
  }
}

/** Principal legs for `model_access` queries: exactly one of userId/roleId. */
function principalOr(userId: string, roleId: string): Array<Record<string, string>> {
  return [{ userId }, { roleId }];
}

export async function listApprovedModelsForUser(tenantId: string, userId: string, roleId: string): Promise<ApprovedModel[]> {
  return tenantOp(tenantId, async (db) => {
    // A grant row is (tenantId, modelId) plus exactly one of userId/roleId.
    // Rows marked revoked are explicit denials, not grants.
    const grants = await db
      .collection<ModelAccessDoc>('model_access')
      .find({ tenantId, $or: principalOr(userId, roleId), revoked: { $ne: true } })
      .toArray();
    const modelIds = [...new Set(grants.map((g) => g.modelId))];
    // Default-open: the tenant default model is implicitly available to
    // every user in the tenant — no grant row needed — unless explicitly
    // revoked for their principal. Ensure-on-read: a fresh tenant (or a
    // wiped/never-migrated registry) gets its default model created here,
    // so /models never comes back empty for lack of one. (The chat path
    // ensures independently; the model list must not depend on a chat
    // having happened first.)
    await ensureTenantDefaultModel();
    const defaultDoc = await findServableDefaultModel(db as unknown as MinimalDb);
    if (defaultDoc && !modelIds.includes(defaultDoc._id)) {
      const revocation = await db.collection<ModelAccessDoc>('model_access').findOne(
        { tenantId, modelId: defaultDoc._id, $or: principalOr(userId, roleId), revoked: true },
        { projection: { _id: 1 } }
      );
      if (!revocation) modelIds.push(defaultDoc._id);
    }
    // Default-open vision: the platform vision model is implicitly available
    // to every user in the tenant — no grant row needed — unless explicitly
    // revoked for their principal. Ensure-on-read so /models lists it even
    // before the first image turn seeded it. Skipped entirely while
    // OLLAMA_ENABLED=false: the Qwen seed is never created and image turns
    // resolve the Claude vision model instead.
    if (config.OLLAMA_ENABLED) {
      await ensureVisionModel();
      const visionDoc = await findServableVisionModel(db as unknown as MinimalDb);
      if (visionDoc && !modelIds.includes(visionDoc._id)) {
        const revocation = await db.collection<ModelAccessDoc>('model_access').findOne(
          { tenantId, modelId: visionDoc._id, $or: principalOr(userId, roleId), revoked: true },
          { projection: { _id: 1 } }
        );
        if (!revocation) modelIds.push(visionDoc._id);
      }
    }
    // Default-open cloud providers: every servable platform cloud seed is
    // implicitly available — no grant row needed — unless explicitly
    // revoked. (Admin-registered cloud models stay fail-closed; only
    // `seededProvider` docs get this treatment.) Ensure-on-read so /models
    // lists Claude/OpenAI models as soon as their API key is configured.
    // Skipped entirely when no cloud provider is configured — the common
    // case — so the default path pays no extra queries.
    if (isClaudeConfigured() || isOpenAIConfigured()) {
      await ensureCloudProviderModels();
      const cloudSeeds = await db
        .collection<ModelDoc>('models')
        .find({ seededProvider: { $in: ['claude', 'openai'] }, status: { $in: [...SERVABLE_STATUSES] }, enabled: true })
        .sort({ name: 1 })
        .toArray();
      for (const doc of cloudSeeds) {
        if (modelIds.includes(doc._id)) continue;
        // Per-provider gate: with only OpenAI configured, stale Claude
        // seeds already in the DB must not be listed or served.
        if (!cloudProviderServingAllowed(doc.provider)) continue;
        const revocation = await db.collection<ModelAccessDoc>('model_access').findOne(
          { tenantId, modelId: doc._id, $or: principalOr(userId, roleId), revoked: true },
          { projection: { _id: 1 } }
        );
        if (!revocation) modelIds.push(doc._id);
      }
    }
    if (modelIds.length === 0) return [];
    const docs = await db
      .collection<ModelDoc>('models')
      .find({ _id: { $in: modelIds }, status: { $in: ['ACTIVE', 'CANARY'] }, enabled: true })
      .sort({ name: 1 })
      .toArray();
    // A disabled cloud provider's models are never listed — seeded or
    // admin-registered.
    return docs.filter((d) => cloudProviderServingAllowed(d.provider)).map(toApprovedModel);
  });
}

export async function getApprovedModelForUser(modelId: string, tenantId: string, userId: string, roleId: string): Promise<ApprovedModel> {
  return tenantOp(tenantId, async (db) => {
    const doc = await db.collection<ModelDoc>('models').findOne({ _id: modelId });
    if (!doc || (doc.status !== 'ACTIVE' && doc.status !== 'CANARY') || !doc.enabled) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
    }
    // A provider the admin disabled (or whose key was removed) serves
    // nothing — even when a client passes the model id directly.
    if (!cloudProviderServingAllowed(doc.provider)) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model provider is not enabled');
    }
    const access = await db.collection<ModelAccessDoc>('model_access').findOne({
      tenantId,
      modelId,
      $or: principalOr(userId, roleId),
    });
    // An explicit revocation always wins, including for the default model.
    if (access?.revoked === true) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model access has been revoked for this user and tenant');
    }
    // Default-open: the tenant default model needs no grant row.
    if (isDefaultModelDoc(doc)) return toApprovedModel(doc);
    // Default-open vision: the platform vision default needs no grant row.
    if (isVisionDefaultModelDoc(doc)) return toApprovedModel(doc);
    // Default-open cloud seeds: platform Claude/OpenAI seeds need no grant
    // row (the admin opted in with an API key). Admin-registered models of
    // any provider still need an explicit grant.
    if (typeof doc.seededProvider === 'string' && doc.seededProvider.length > 0) {
      return toApprovedModel(doc);
    }
    // Non-default models stay fail-closed: an explicit grant is required.
    if (!access) {
      throw Errors.forbidden('MODEL_NOT_APPROVED', 'Model is not approved for this user and tenant');
    }
    return toApprovedModel(doc);
  });
}

/* ------------------------------------------------------------------ *
 * Cloud providers (Claude / OpenAI) — ensure-on-read seeds.
 *
 * A cloud provider is "configured" only when its API key is set and it
 * has not been explicitly disabled: without a key the UI shows the
 * provider disabled with a hint, never as a dead button. Seeding is
 * idempotent and follows the same create-on-read pattern as the tenant
 * default and vision seeds above.
 *
 * Security posture for cloud seeds (see ADR-018):
 * - Seeds are inserted only when the admin opted in with an API key.
 * - The model's endpoint origin must be on AI_PROVIDER_ALLOWED_ORIGINS;
 *   a locked-down config never gains cloud models from this path.
 * - Cloud models are default-open within the tenant (same as the vision
 *   default) via the `isProviderDefault` flag, so switching providers is
 *   one tap — but their allowed classifications cap at INTERNAL: an admin
 *   must explicitly widen a cloud model to serve CONFIDENTIAL or above.
 * - Explicit revocation via model_access works exactly as for defaults.
 * ------------------------------------------------------------------ */

/** True when the Claude provider may serve traffic: key set, not disabled. */
export function isClaudeConfigured(): boolean {
  return config.CLAUDE_ENABLED && config.ANTHROPIC_API_KEY.trim().length > 0;
}

/** True when the OpenAI provider may serve traffic: key set, not disabled. */
export function isOpenAIConfigured(): boolean {
  return config.OPENAI_ENABLED && config.OPENAI_API_KEY.trim().length > 0;
}

/**
 * A provider's model docs may only be listed or served while the provider
 * is enabled. Cloud providers are enabled by API key (not admin-disabled);
 * the local Ollama provider is enabled by the OLLAMA_ENABLED flag.
 * Enforced at approval time — the UI hides disabled providers, but the API
 * must reject them too, even when a client passes a model id directly
 * (e.g. a stored conversation model). Other providers are unaffected.
 */
export function cloudProviderServingAllowed(provider: string): boolean {
  if (provider === 'claude') return isClaudeConfigured();
  if (provider === 'openai') return isOpenAIConfigured();
  // Claude-only launch: while OLLAMA_ENABLED=false no Ollama doc — seeded
  // or admin-registered — may be listed or served.
  if (provider === 'ollama') return config.OLLAMA_ENABLED;
  return true;
}

interface CloudSeedSpec {
  name: string;
  provider: 'claude' | 'openai';
  modelIdentifier: string;
  contextWindow: number;
  vision: boolean;
  license: string;
  source: string;
}

/**
 * Cloud seed endpoints come from the configured base URLs (still
 * allowlisted before insert): an operator pointing ANTHROPIC_BASE_URL at a
 * proxy gets seeds that actually use it, instead of seeds that silently
 * ignore their own config.
 */
function cloudSeedEndpoint(provider: 'claude' | 'openai'): string {
  return provider === 'claude' ? config.ANTHROPIC_BASE_URL : config.OPENAI_BASE_URL;
}

const CLOUD_SEEDS: CloudSeedSpec[] = [
  {
    name: 'Claude Sonnet 4',
    provider: 'claude',
    modelIdentifier: 'claude-sonnet-4-20250514',
    contextWindow: 200000,
    vision: true,
    license: 'proprietary',
    source: 'anthropic',
  },
  {
    name: 'GPT-4o',
    provider: 'openai',
    modelIdentifier: 'gpt-4o',
    contextWindow: 128000,
    vision: true,
    license: 'proprietary',
    source: 'openai',
  },
  {
    name: 'GPT-4o Mini',
    provider: 'openai',
    modelIdentifier: 'gpt-4o-mini',
    contextWindow: 128000,
    vision: false,
    license: 'proprietary',
    source: 'openai',
  },
];

function cloudSeedDoc(spec: CloudSeedSpec, now: Date, providerDefault: boolean): Record<string, unknown> {
  return {
    _id: randomUUID(),
    name: spec.name,
    version: '1.0',
    provider: spec.provider,
    endpoint: cloudSeedEndpoint(spec.provider),
    modelIdentifier: spec.modelIdentifier,
    status: 'ACTIVE',
    license: spec.license,
    source: spec.source,
    sha256: null,
    contextWindow: spec.contextWindow,
    capabilities: spec.vision
      ? { chat: true, streaming: true, vision: true }
      : { chat: true, streaming: true },
    classification: 'INTERNAL',
    // Cloud models cap at INTERNAL by default: prompts leave the
    // operator's infrastructure, so CONFIDENTIAL and above require an
    // explicit admin widening of allowedClassifications.
    allowedClassifications: ['PUBLIC', 'INTERNAL'],
    deployment: {},
    requestTimeoutMs: null,
    maxTokens: null,
    temperature: null,
    fallbackModelId: null,
    isDefault: false,
    isVisionDefault: false,
    isProviderDefault: providerDefault,
    // Marks platform cloud seeds: they are default-open within the tenant
    // (unlike admin-registered models, which stay fail-closed). Stripped
    // from the ApprovedModel view in toApprovedModel.
    seededProvider: spec.provider,
    enabled: true,
    lifecycleUpdatedAt: now,
    approvedBy: null,
    approvedAt: null,
    lastEvalRunId: null,
    createdAt: now,
  };
}

/** True when this model doc is a provider's default-open chat model. */
export function isProviderDefaultModelDoc(doc: { name: string; isProviderDefault?: boolean }): boolean {
  return doc.isProviderDefault === true;
}

function endpointOriginAllowlisted(endpoint: string): boolean {
  let origin: string;
  try {
    origin = new URL(endpoint).origin;
  } catch {
    return false;
  }
  const allowed = new Set(config.AI_PROVIDER_ALLOWED_ORIGINS.split(',').map((v) => v.trim()));
  return allowed.has(origin);
}

/**
 * Ensure servable seed models exist for every configured cloud provider.
 * Idempotent: inserts only when the provider has no servable model doc at
 * all. The first chat (non-vision) seed per provider is flagged
 * `isProviderDefault` for default-open serving.
 */
export async function ensureCloudProviderModels(): Promise<void> {
  const db = (await getDb()) as unknown as MinimalDb;
  const now = new Date();
  const groups: Array<{ provider: 'claude' | 'openai'; configured: boolean }> = [
    { provider: 'claude', configured: isClaudeConfigured() },
    { provider: 'openai', configured: isOpenAIConfigured() },
  ];
  for (const { provider, configured } of groups) {
    if (!configured) continue;
    const existing = await db.collection<ModelDoc>('models').findOne({
      provider,
      status: { $in: [...SERVABLE_STATUSES] },
      enabled: true,
    });
    if (existing) continue;
    const seeds = CLOUD_SEEDS.filter((s) => s.provider === provider);
    // Respect a locked-down egress config: never seed a cloud model whose
    // endpoint the gateway would refuse to call. The endpoint is the
    // configured base URL, not a hardcoded value.
    if (!endpointOriginAllowlisted(cloudSeedEndpoint(provider))) continue;
    // Exactly one provider default: prefer the first vision-capable seed —
    // the flagship model, which also serves image turns without a switch —
    // else the first seed.
    const defaultSpec = seeds.find((s) => s.vision) ?? seeds[0];
    for (const spec of seeds) {
      try {
        await db.collection<ModelDoc>('models').insertOne(cloudSeedDoc(spec, now, spec === defaultSpec));
      } catch (err) {
        if ((err as { code?: number })?.code !== 11000) throw err;
      }
    }
  }
}

/**
 * The servable vision model for a provider group. 'enflite' reuses the
 * platform vision model; cloud groups resolve their own vision-capable
 * seed (ensured on read). Returns null when the group has no servable
 * vision model — the caller falls back to the Enflite vision model.
 */
export async function findServableVisionModelForGroup(group: ProviderGroup): Promise<ModelDoc | null> {
  const db = (await getDb()) as unknown as MinimalDb;
  if (group === 'enflite') {
    return findServableVisionModel(db);
  }
  const provider = group; // 'claude' | 'openai'
  const configured = provider === 'claude' ? isClaudeConfigured() : isOpenAIConfigured();
  if (!configured) return null;
  await ensureCloudProviderModels();
  return db.collection<ModelDoc>('models').findOne({
    provider,
    'capabilities.vision': true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  });
}

/**
 * Finds the preferred servable chat (non-vision) model for a cloud
 * provider group. Prefer the provider's flagship default (`isProviderDefault`
 * — e.g. claude-sonnet-4-20250514 for Claude), falling back to any servable
 * chat-capable model for the group. Returns null when the provider is not
 * configured.
 */
export async function findServableChatModelForGroup(group: 'claude' | 'openai'): Promise<ModelDoc | null> {
  const db = (await getDb()) as unknown as MinimalDb;
  const configured = group === 'claude' ? isClaudeConfigured() : isOpenAIConfigured();
  if (!configured) return null;
  await ensureCloudProviderModels();
  const query = {
    provider: group,
    'capabilities.chat': true,
    status: { $in: [...SERVABLE_STATUSES] },
    enabled: true,
  };
  const preferred = await db.collection<ModelDoc>('models').findOne({ ...query, isProviderDefault: true });
  if (preferred) return preferred;
  return db.collection<ModelDoc>('models').findOne(query);
}
