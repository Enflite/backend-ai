/**
 * dataset.ts — training-dataset curation (ADR-015, stage 2).
 *
 * Builds an immutable, versioned SFT (supervised fine-tuning) dataset from
 * APPROVED feedback rows. Each example is reconstructed from the `messages`
 * collection:
 *
 *   - user turn: the most recent `user` message before the rated assistant
 *     message in the same conversation
 *   - assistant turn: the approved correction when one was supplied
 *     (regardless of rating), otherwise the original assistant message
 *
 * `down` ratings WITHOUT a correction carry no training signal and are
 * skipped — they are still useful as eval cases, but not as SFT pairs.
 *
 * Datasets are immutable once built (`status: 'ready'`). A dataset is the
 * unit a fine-tune job trains on; rebuilding with a new name versions it.
 */
import { randomUUID } from 'node:crypto';
import { tenantOp } from '../db/mongo.js';
import { Classification } from '../authz/permissions.js';
import { Errors } from '../errors.js';
import { FeedbackDoc, FeedbackContext } from './feedbackStore.js';

/** Cap: keeps dataset documents comfortably under the 16MB BSON limit. */
export const MAX_DATASET_EXAMPLES = 5000;

export interface SftMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface SftExample {
  messages: SftMessage[];
  /** Provenance for audit: which feedback row produced this example. */
  sourceFeedbackId: string;
  classification: Classification;
}

export interface FinetuneDatasetDoc {
  _id: string;
  tenantId: string;
  name: string;
  status: 'ready';
  examples: SftExample[];
  exampleCount: number;
  skippedCount: number;
  createdBy: string;
  createdAt: Date;
}

interface MessageDoc {
  _id: string;
  conversationId: string;
  tenantId: string;
  role: string;
  content: string;
  createdAt: Date;
}

export interface BuildDatasetInput {
  name: string;
}

/**
 * Reconstruct one SFT example from an approved feedback row. Returns null
 * when the row carries no usable training signal (down without correction)
 * or when the source messages are gone.
 */
export async function buildExample(
  ctx: FeedbackContext,
  feedback: FeedbackDoc
): Promise<{ example: SftExample | null; skipped: boolean }> {
  // A correction is the training signal regardless of rating (a user may
  // thumbs-up an answer while fixing a detail). A `down` without correction
  // carries no signal and is skipped.
  const correction = feedback.correction?.trim() || undefined;
  if (feedback.rating === 'down' && !correction) {
    return { example: null, skipped: true };
  }

  const docs = await tenantOp(ctx.tenantId, (db) =>
    db
      .collection<MessageDoc>('messages')
      .find({ tenantId: ctx.tenantId, conversationId: feedback.conversationId })
      .sort({ createdAt: 1 })
      .toArray()
  );
  const assistantIdx = docs.findIndex((m) => String(m._id) === feedback.messageId);
  if (assistantIdx < 0) return { example: null, skipped: true };

  const assistantMsg = docs[assistantIdx];
  if (!assistantMsg) return { example: null, skipped: true };
  const finalAssistant = (correction ?? assistantMsg.content).trim();
  if (!finalAssistant) return { example: null, skipped: true };

  // The user turn is the latest user message before the rated assistant turn.
  let userContent: string | null = null;
  for (let i = assistantIdx - 1; i >= 0; i--) {
    const msg = docs[i];
    if (msg && msg.role === 'user' && msg.content.trim()) {
      userContent = msg.content.trim();
      break;
    }
  }
  if (!userContent) return { example: null, skipped: true };

  return {
    example: {
      messages: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: finalAssistant },
      ],
      sourceFeedbackId: feedback._id,
      classification: feedback.classification,
    },
    skipped: false,
  };
}

export async function buildDataset(
  ctx: FeedbackContext,
  input: BuildDatasetInput
): Promise<FinetuneDatasetDoc> {
  const name = input.name.trim();
  if (!name || name.length > 120) {
    throw Errors.badRequest('INVALID_DATASET_NAME', 'Dataset name must be 1–120 characters');
  }
  const existing = await tenantOp(ctx.tenantId, (db) =>
    db.collection<FinetuneDatasetDoc>('finetune_datasets').findOne({ tenantId: ctx.tenantId, name })
  );
  if (existing) {
    throw Errors.badRequest('DATASET_NAME_TAKEN', 'A dataset with this name already exists');
  }

  const approved = await tenantOp(ctx.tenantId, (db) =>
    db
      .collection<FeedbackDoc>('feedback')
      .find({ tenantId: ctx.tenantId, status: 'approved' })
      .sort({ createdAt: 1 })
      .limit(MAX_DATASET_EXAMPLES)
      .toArray()
  );

  const examples: SftExample[] = [];
  let skippedCount = 0;
  for (const fb of approved) {
    const { example, skipped } = await buildExample(ctx, fb);
    if (example) examples.push(example);
    if (skipped) skippedCount++;
  }
  if (examples.length === 0) {
    throw Errors.badRequest('DATASET_EMPTY', 'No usable approved feedback to build a dataset from');
  }

  const now = new Date();
  const doc: FinetuneDatasetDoc = {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    name,
    status: 'ready',
    examples,
    exampleCount: examples.length,
    skippedCount,
    createdBy: ctx.userId,
    createdAt: now,
  };
  await tenantOp(ctx.tenantId, (db) => db.collection<FinetuneDatasetDoc>('finetune_datasets').insertOne(doc));
  return doc;
}

export async function getDataset(ctx: FeedbackContext, id: string): Promise<FinetuneDatasetDoc | null> {
  return tenantOp(ctx.tenantId, (db) =>
    db.collection<FinetuneDatasetDoc>('finetune_datasets').findOne({ _id: id, tenantId: ctx.tenantId })
  );
}

export async function listDatasets(ctx: FeedbackContext): Promise<FinetuneDatasetDoc[]> {
  return tenantOp(ctx.tenantId, (db) =>
    db
      .collection<FinetuneDatasetDoc>('finetune_datasets')
      .find({ tenantId: ctx.tenantId })
      .sort({ createdAt: -1 })
      .toArray()
  );
}

/** Render a dataset as JSONL (one SFT example per line) for training upload. */
export function datasetToJsonl(doc: FinetuneDatasetDoc): string {
  return doc.examples.map((e) => JSON.stringify({ messages: e.messages })).join('\n') + '\n';
}
