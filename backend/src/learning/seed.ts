/**
 * seed.ts — curator-authored SFT seed datasets (ADR-015, additive path).
 *
 * The feedback-derived builder in dataset.ts only builds from APPROVED
 * feedback rows, which means a fresh tenant starts with no training data.
 * This module seeds a dataset from a curator-authored JSONL file instead:
 * one SFT example per line, `{"messages": [{"role":"user",...},
 * {"role":"assistant",...}]}`. The file format is identical to what
 * `datasetToJsonl` produces, so curators can extend the seed by hand and
 * the training-upload path treats both sources the same.
 *
 * Provenance: seed examples get `sourceFeedbackId` values of the form
 * `seed:<dataset-name>:<n>` — never a feedback row id — so audits can
 * always distinguish curator-authored examples from feedback-derived ones.
 * Seed datasets are immutable once inserted (`status: 'ready'`), exactly
 * like feedback-derived ones, and `seedDataset` is idempotent per
 * (tenantId, name).
 */
import { randomUUID } from 'node:crypto';
import { tenantOp } from '../db/mongo.js';
import { Errors } from '../errors.js';
import {
  FinetuneDatasetDoc,
  MAX_DATASET_EXAMPLES,
  SftExample,
  SftMessage,
} from './dataset.js';

/** Default seed dataset name; the script accepts an override. */
export const SEED_DATASET_NAME = 'syteline-expert-seed-v1';

export interface SeedContext {
  tenantId: string;
  userId: string;
}

export interface SeedDatasetInput {
  name: string;
  classification: SftExample['classification'];
  createdBy: string;
}

/**
 * Parse and validate a seed JSONL file. Throws badRequest on the first
 * problem found (line number included). Returns the validated message
 * arrays in file order.
 */
export function parseSeedJsonl(text: string): SftMessage[][] {
  const messageSets: SftMessage[][] = [];
  const seenQuestions = new Set<string>();
  const lines = text.split('\n');
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line) return;
    const lineNo = idx + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw Errors.badRequest('INVALID_SEED_JSONL', `Seed line ${lineNo}: not valid JSON`);
    }
    const messages = (parsed as { messages?: unknown }).messages;
    if (!Array.isArray(messages) || messages.length < 2) {
      throw Errors.badRequest('INVALID_SEED_JSONL', `Seed line ${lineNo}: messages must be an array of at least 2`);
    }
    const first = messages[0] as SftMessage;
    const last = messages[messages.length - 1] as SftMessage;
    if (first.role !== 'user' || last.role !== 'assistant') {
      throw Errors.badRequest(
        'INVALID_SEED_JSONL',
        `Seed line ${lineNo}: first message must be role 'user' and last must be role 'assistant'`
      );
    }
    for (const m of messages as SftMessage[]) {
      if ((m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string' || !m.content.trim()) {
        throw Errors.badRequest('INVALID_SEED_JSONL', `Seed line ${lineNo}: every message needs role user|assistant and non-empty content`);
      }
    }
    if (seenQuestions.has(first.content)) {
      throw Errors.badRequest('INVALID_SEED_JSONL', `Seed line ${lineNo}: duplicate user question`);
    }
    seenQuestions.add(first.content);
    messageSets.push(messages as SftMessage[]);
  });
  if (messageSets.length === 0) {
    throw Errors.badRequest('SEED_DATASET_EMPTY', 'Seed file contains no usable examples');
  }
  if (messageSets.length > MAX_DATASET_EXAMPLES) {
    throw Errors.badRequest(
      'SEED_DATASET_TOO_LARGE',
      `Seed file has ${messageSets.length} examples; max is ${MAX_DATASET_EXAMPLES}`
    );
  }
  return messageSets;
}

/** Build the immutable FinetuneDatasetDoc for validated seed examples. */
export function buildSeedDatasetDoc(
  ctx: SeedContext,
  input: SeedDatasetInput,
  messageSets: SftMessage[][]
): FinetuneDatasetDoc {
  const examples: SftExample[] = messageSets.map((messages, i) => ({
    messages,
    sourceFeedbackId: `seed:${input.name}:${i + 1}`,
    classification: input.classification,
  }));
  const now = new Date();
  return {
    _id: randomUUID(),
    tenantId: ctx.tenantId,
    name: input.name,
    status: 'ready',
    examples,
    exampleCount: examples.length,
    skippedCount: 0,
    createdBy: input.createdBy,
    createdAt: now,
  };
}

/**
 * Insert the seed dataset, idempotently: if a dataset with this name
 * already exists for the tenant it is returned untouched (`skipped: true`).
 */
export async function seedDataset(
  ctx: SeedContext,
  input: SeedDatasetInput,
  messageSets: SftMessage[][]
): Promise<{ doc: FinetuneDatasetDoc; skipped: boolean }> {
  const existing = await tenantOp(ctx.tenantId, (db) =>
    db.collection<FinetuneDatasetDoc>('finetune_datasets').findOne({ tenantId: ctx.tenantId, name: input.name })
  );
  if (existing) return { doc: existing, skipped: true };
  const doc = buildSeedDatasetDoc(ctx, input, messageSets);
  await tenantOp(ctx.tenantId, (db) => db.collection<FinetuneDatasetDoc>('finetune_datasets').insertOne(doc));
  return { doc, skipped: false };
}
