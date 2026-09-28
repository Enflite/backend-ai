/**
 * 029_model_default_open — default-open model serving.
 *
 * Flags the platform default model (the seeded Ollama llama3.1:8b doc)
 * with `isDefault: true` so the registry resolves it without a name
 * lookup, and adds a partial index for that lookup.
 *
 * Idempotent: the flag is only set when no model is flagged yet, so an
 * operator-chosen default is never clobbered, and createIndex is a no-op
 * when the name + spec already exist.
 */
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll } from './helpers.js';

const SEED_MODEL_NAME = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

export const migration029: Migration = {
  version: '029_model_default_open',
  description: 'Flag the platform default model (isDefault) for default-open serving',

  up: async (db: Db): Promise<void> => {
    await db
      .collection('models')
      .createIndex(
        { isDefault: 1 },
        { name: 'idx_models_is_default', partialFilterExpression: { isDefault: true } }
      );

    const flagged = await coll(db, 'models').findOne({ isDefault: true }, { projection: { _id: 1 } });
    if (!flagged) {
      await coll(db, 'models').updateOne(
        { name: SEED_MODEL_NAME, isDefault: { $ne: true } },
        { $set: { isDefault: true } }
      );
    }
  },
};
