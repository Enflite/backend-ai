/**
 * prefixCache.ts — deterministic prompt-prefix contract for vLLM automatic
 * prefix caching.
 *
 * vLLM reuses KV-cache blocks server-side whenever the token prefix of a
 * request is byte-identical to a previously seen prefix — no client
 * configuration needed (the V1 engine enables prefix caching by default).
 * The chat path rebuilds a large static prefix every turn (the charter
 * system prompt from `chat/systemPrompt.ts`, plus the SyteLine expert
 * knowledge pack on SyteLine turns). This module is the contract that keeps
 * that prefix byte-stable:
 *
 * - `buildSystemPrompt` emits the byte-stable static head first
 *   (`buildStaticPromptHead`) and the per-turn dynamic tail after. Anything
 *   dynamic — serving-model identity, tool guidance, the SyteLine pack,
 *   coding guidance — goes AFTER the static head, never inside it.
 * - `buildCacheableSystemPrompt` assembles a turn's system prompt through
 *   that contract, asserts the layout, and exposes the prompt's SHA-256 hash
 *   so operators can correlate requests with vLLM server-side cache metrics.
 * - The gateway records `prefixHash` + estimated `promptTokens` in the
 *   per-request telemetry (MODEL_USED audit metadata). Actual hit/miss rates
 *   come from the vLLM server's `/metrics` endpoint — this module never
 *   invents cache statistics.
 *
 * `PROMPT_CACHE_ENABLED` (default true) governs the client-side contract and
 * telemetry. It is safe to leave on: it changes prompt *ordering*, never
 * prompt *content*. When false, prompts are assembled the legacy way with no
 * assertion and no telemetry. Either way the model receives the same content;
 * vLLM's server-side caching itself is automatic and unaffected by the flag.
 *
 * Tenant isolation note: the static head contains no tenant data by
 * construction (systemPrompt.ts accepts only tenant-safe metadata), and a
 * prefix-cache hit requires a byte-identical token prefix — one tenant's
 * conversation history can never produce a hit for another tenant's
 * different bytes.
 */

import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import {
  buildSystemPrompt,
  buildStaticPromptHead,
  type SystemPromptOptions,
} from '../../chat/systemPrompt.js';

/** A turn's system prompt plus the hash identifying its cacheable prefix. */
export interface CacheableSystemPrompt {
  /** The exact system-prompt text sent as the provider's system message. */
  text: string;
  /**
   * SHA-256 hex of `text`. Stable across turns for identical prompts, so
   * operators can group requests by prefix when reading vLLM `/metrics`.
   * Empty when `PROMPT_CACHE_ENABLED` is false.
   */
  hash: string;
}

/**
 * SHA-256 hex digest identifying a prompt prefix. vLLM itself hashes cache
 * blocks server-side; this digest is only an operator-facing label for
 * correlating our requests with the server's cache metrics.
 */
export function hashPromptPrefix(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Asserts an assembled system prompt starts with the byte-stable static head.
 * Throws on violation: a dynamic value leaking into the cached region would
 * silently fragment vLLM's prefix cache (every turn becomes a distinct
 * prefix), so a layout bug fails fast instead of degrading cache hit rate.
 */
export function assertStaticPrefix(text: string): void {
  if (!text.startsWith(buildStaticPromptHead())) {
    throw new Error(
      'prompt prefix-cache violation: system prompt does not start with the byte-stable static head'
    );
  }
}

/**
 * Assembles a turn's system prompt through the deterministic prefix-cache
 * contract: static charter head first, per-turn dynamic tail after. Returns
 * the text plus its SHA-256 hash for telemetry.
 *
 * When `PROMPT_CACHE_ENABLED` is false this is plain `buildSystemPrompt`
 * with no assertion and an empty hash (legacy path). The model-visible
 * content is identical either way — only the stability contract and the
 * telemetry differ.
 */
export function buildCacheableSystemPrompt(options: SystemPromptOptions = {}): CacheableSystemPrompt {
  const text = buildSystemPrompt(options);
  if (!config.PROMPT_CACHE_ENABLED) {
    return { text, hash: '' };
  }
  assertStaticPrefix(text);
  return { text, hash: hashPromptPrefix(text) };
}

/**
 * Determinism check: the same options must always assemble byte-identical
 * text (no timestamps, request IDs, randomness, or map-ordering hazards in
 * the template). Cheap and pure — safe to call in tests and in production.
 */
export function verifyPrefixDeterministic(options: SystemPromptOptions = {}): boolean {
  return buildSystemPrompt(options) === buildSystemPrompt(options);
}
