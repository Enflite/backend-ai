/**
 * 028_ollama_primary_seed — Ollama becomes the primary inference provider.
 *
 * Repoints the platform seed model (002: 'meta-llama/Meta-Llama-3.1-8B-Instruct')
 * at Ollama instead of vLLM:
 *   provider:        'vllm'  → 'ollama'
 *   endpoint:        'http://vllm:8000/v1' → 'http://ollama:11434'
 *   modelIdentifier: 'meta-llama/Meta-Llama-3.1-8B-Instruct' → 'llama3.1:8b'
 *                    (the name Ollama serves it under; this is what the
 *                    provider sends as `model` on /api/chat).
 *
 * The registry `name` is intentionally unchanged: it is the stable lookup
 * key used by provisioning scripts and the unique index on models.name.
 * Endpoint uses the docker-compose service name; on a native Windows host
 * the same model is registered with http://localhost:11434 instead (see
 * backend/scripts/setup-ollama-windows.ps1 and docs/inference.md).
 *
 * Idempotent: only rows still on the old vLLM seed values are touched, so
 * operator-customized models are never overwritten.
 */
import type { Db } from 'mongodb';
import type { Migration } from '../migrate.js';
import { coll } from './helpers.js';

const SEED_MODEL_NAME = 'meta-llama/Meta-Llama-3.1-8B-Instruct';

export const migration028: Migration = {
  version: '028_ollama_primary_seed',
  description: 'Repoint the platform seed model at Ollama (primary inference provider)',

  up: async (db: Db): Promise<void> => {
    await coll(db, 'models').updateOne(
      {
        name: SEED_MODEL_NAME,
        provider: 'vllm',
        endpoint: 'http://vllm:8000/v1',
      },
      {
        $set: {
          provider: 'ollama',
          endpoint: 'http://ollama:11434',
          modelIdentifier: 'llama3.1:8b',
        },
      }
    );
  },
};
