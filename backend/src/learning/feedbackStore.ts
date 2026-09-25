/**
 * feedbackStore.ts — tenant-scoped feedback capture (ADR-015, stage 1).
 *
 * Users rate assistant messages (up/down) and may supply a corrected answer.
 * An approved `down` + correction is the raw material for SFT datasets
 * (see dataset.ts). Feedback is NEVER training data until a curator approves
 * it — the store enforces the pending → approved/rejected lifecycle, and the
 * dataset builder only reads `approved` rows.
 *
 * Tenant isolation: every operation binds tenantId from the caller's auth
 * context. In v1, listing and curating are curator-only (`feedback:curate`);
 * authors submit via `feedback:submit`.
 */
import { randomUUID } from 'node:crypto';
import { tenantOp } from '../db/mongo.js';
import { CLASSIFICATIONS, Classification, canAccessClassification } from '../authz/permissions.js';
import { Errors } from '../errors.js';

export const FEEDBACK_RATINGS = ['up', 'down'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];

/** MongoDB document shape for the `feedback` collection (ADR-014). */
export interface FeedbackDoc {
  _id: string;
  tenantId: string;
  userId: string;
  conversationId: string;
  messageId: string;
  modelId?: string;
  rating: FeedbackRating;
  /** Corrected assistant answer supplied by the user (untrusted input). */
  correction?: string;
  comment?: string;
  classification: Classification;
  status: FeedbackStatus;
  reviewedBy?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface FeedbackContext {
  tenantId: string;
  userId: string;
  clearance: Classification;
}

export interface CreateFeedbackInput {
  conversationId: string;
  messageId: string;
  modelId?: string;
  rating: FeedbackRating;
  correction?: string;
  comment?: string;
  classification?: Classification;
}

export interface ListFeedbackOptions {
  status?: FeedbackStatus;
  rating?: FeedbackRating;
  limit?: number;
  offset?: number;
}

function resolveClassification(
  requested: Classification | undefined,
  ctx: FeedbackContext
): Classification {
  // Omitted classification resolves to the caller's clearance (same
  // convention as memory routes): feedback can never be labeled above what
  // the author is cleared for.
  const classification = requested ?? ctx.clearance;
  if (!CLASSIFICATIONS.includes(classification) || classification === 'UNKNOWN') {
    throw Errors.badRequest('INVALID_CLASSIFICATION', 'Invalid classification');
  }
  if (!canAccessClassification(ctx.clearance, classification)) {
    throw Errors.forbidden('CLASSIFICATION_ABOVE_CLEARANCE', 'Classification exceeds your clearance');
  }
  return classification;
}

export async function createFeedback(
  ctx: FeedbackContext,
  input: CreateFeedbackInput
): Promise<FeedbackDoc> {
  const classification = resolveClassification(input.classification, ctx);
  if (input.rating === 'down' && input.correction) {
    const trimmed = input.correction.trim();
    if (trimmed.length === 0 || trimmed.length > 8000) {
      throw Errors.badRequest('INVALID_CORRECTION', 'Correction must be 1–8000 characters');
    }
  }
  const now = new Date();
  const doc: FeedbackDoc = {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    conversationId: input.conversationId,
    messageId: input.messageId,
    rating: input.rating,
    classification,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  if (input.modelId) doc.modelId = input.modelId;
  if (input.correction?.trim()) doc.correction = input.correction.trim();
  if (input.comment?.trim()) doc.comment = input.comment.trim().slice(0, 2000);
  await tenantOp(ctx.tenantId, (db) => db.collection<FeedbackDoc>('feedback').insertOne(doc));
  return doc;
}

export async function listFeedback(
  ctx: FeedbackContext,
  options: ListFeedbackOptions = {}
): Promise<FeedbackDoc[]> {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (options.status) filter.status = options.status;
  if (options.rating) filter.rating = options.rating;
  return tenantOp(ctx.tenantId, (db) =>
    db
      .collection<FeedbackDoc>('feedback')
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(offset)
      .limit(limit)
      .toArray()
  );
}

export async function getFeedback(ctx: FeedbackContext, id: string): Promise<FeedbackDoc | null> {
  return tenantOp(ctx.tenantId, (db) =>
    db.collection<FeedbackDoc>('feedback').findOne({ _id: id, tenantId: ctx.tenantId })
  );
}

/**
 * Curate one feedback row: approve it into (or reject it from) the training
 * pipeline. Only forward transitions are allowed — approved/rejected is
 * terminal, so a rejected-then-reconsidered row must be re-submitted.
 */
export async function curateFeedback(
  ctx: FeedbackContext,
  id: string,
  status: Extract<FeedbackStatus, 'approved' | 'rejected'>
): Promise<FeedbackDoc> {
  const now = new Date();
  const doc = await tenantOp(ctx.tenantId, (db) =>
    db.collection<FeedbackDoc>('feedback').findOneAndUpdate(
      { _id: id, tenantId: ctx.tenantId, status: 'pending' },
      { $set: { status, reviewedBy: ctx.userId, reviewedAt: now, updatedAt: now } },
      { returnDocument: 'after' }
    )
  );
  if (!doc) {
    throw Errors.notFound('FEEDBACK_NOT_FOUND', 'Feedback not found or already curated');
  }
  return doc;
}
