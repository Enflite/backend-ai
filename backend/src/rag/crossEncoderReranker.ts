/**
 * crossEncoderReranker.ts — HTTP cross-encoder reranker implementing the
 * `Reranker` hook from retrieval.ts.
 *
 * Posts the normalized query and up to RERANKER_TOP_N already
 * permission-filtered chunk texts to an operator-configured scoring endpoint
 * (Cohere-rerank-compatible response contract) and reorders the candidates by
 * the returned relevance scores.
 *
 * Security posture:
 * - Runs AFTER authorization filtering; the hook output is untrusted and is
 *   reconstructed from the canonical candidate map in retrieval.ts, so this
 *   reranker can only reorder authorized chunks and propose scores.
 * - Fail-open: any endpoint failure (timeout, HTTP error, malformed
 *   response, allowlist denial, missing config) returns the hybrid order
 *   unchanged, records a `reranker_fallbacks_total` metric with a reason, and
 *   logs a warning. Retrieval never hard-fails because the reranker is down.
 * - No credentials, tenant ids, or user ids are sent to the endpoint — only
 *   the query text and the chunk texts. No Authorization header is attached.
 * - The endpoint origin must be on AI_PROVIDER_ALLOWED_ORIGINS, the same
 *   egress allowlist the AI gateway enforces.
 */
import { config } from '../config.js';
import { recordRerankerFallback, type RerankerFallbackReason } from '../observability/metrics.js';
import type { AuthorizedChunk, Reranker } from './retrieval.js';

/** Endpoint response contract: `{ results: [{ index, relevance_score }] }`. */
interface RerankApiResult {
  index?: unknown;
  relevance_score?: unknown;
  score?: unknown;
}

interface RerankApiResponse {
  results?: unknown;
}

export interface CrossEncoderRerankerConfig {
  url: string;
  model: string;
  timeoutMs: number;
  topN: number;
}

/** Narrow fetch signature the reranker needs: POST with a full RequestInit. */
export type RerankerFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CrossEncoderRerankerOptions {
  /** Override for `config.RERANKER_URL`. */
  url?: string;
  /** Override for `config.RERANKER_MODEL`. */
  model?: string;
  /** Override for `config.RERANKER_TIMEOUT_MS`. */
  timeoutMs?: number;
  /** Override for `config.RERANKER_TOP_N`. */
  topN?: number;
  /** Fetch implementation override; defaults to global fetch. Injectable for tests. */
  fetchImpl?: RerankerFetch;
}

/** Resolve the effective reranker config from the parsed process env. */
export function resolveRerankerConfig(): CrossEncoderRerankerConfig {
  return {
    url: config.RERANKER_URL,
    model: config.RERANKER_MODEL,
    timeoutMs: config.RERANKER_TIMEOUT_MS,
    topN: config.RERANKER_TOP_N,
  };
}

/**
 * Parse a relevance score out of one API result entry. Accepts both
 * `relevance_score` (Cohere rerank) and `score` (TEI / flag-embedding style).
 * Returns null when the entry is unusable; retrieval.ts clamps accepted
 * scores to the [0,1] hybrid-score contract.
 */
function parseScore(entry: RerankApiResult, documentCount: number): { index: number; score: number } | null {
  if (!entry || typeof entry !== 'object') return null;
  const index = entry.index;
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= documentCount) return null;
  const raw = entry.relevance_score ?? entry.score;
  const score = Number(raw);
  if (!Number.isFinite(score)) return null;
  return { index, score: Math.max(0, Math.min(1, score)) };
}

/**
 * Egress allowlist check, mirroring the AI gateway's
 * `AI_PROVIDER_ALLOWED_ORIGINS` enforcement: the endpoint origin must appear
 * in the allowlist. Throws (fail-open) when the URL is invalid or the origin
 * is not allowed.
 */
function assertEndpointAllowed(url: string): void {
  const allowedOrigins = new Set(
    config.AI_PROVIDER_ALLOWED_ORIGINS.split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0)
  );
  let endpointOrigin: string;
  try {
    endpointOrigin = new URL(url).origin;
  } catch {
    throw new Error('RERANKER_URL is not a valid URL');
  }
  if (!allowedOrigins.has(endpointOrigin)) {
    throw new Error('RERANKER_URL origin is outside the server allowlist');
  }
}

/**
 * Create the cross-encoder reranker. Construction performs no network I/O;
 * everything happens (fail-open) inside rerank().
 */
export function createCrossEncoderReranker(options: CrossEncoderRerankerOptions = {}): Reranker {
  const resolved = resolveRerankerConfig();
  const url = options.url ?? resolved.url;
  const model = options.model ?? resolved.model;
  const timeoutMs = options.timeoutMs ?? resolved.timeoutMs;
  const topN = options.topN ?? resolved.topN;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  const fallBack = (reason: RerankerFallbackReason): void => {
    recordRerankerFallback(reason);
    // No query text, chunk content, or endpoint URL in the log line: the
    // reason alone is enough for an operator to act on.
    console.warn(`Cross-encoder reranker fell back to hybrid order (reason: ${reason})`);
  };

  const reranker: Reranker = {
    name: 'cross-encoder',
    rerank: async (queryText: string, chunks: AuthorizedChunk[]): Promise<AuthorizedChunk[]> => {
      if (chunks.length === 0) return [];
      if (!url) {
        fallBack('not_configured');
        return chunks;
      }
      try {
        assertEndpointAllowed(url);
      } catch {
        fallBack('not_allowed');
        return chunks;
      }

      // Score only the top hybrid candidates: cross-encoders are the most
      // expensive stage per document. Candidates beyond topN are never sent
      // for scoring and are appended back in their original relative order
      // below, so the reranker only ever reorders the authorized set.
      const documents = chunks.slice(0, topN);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response;
      try {
        // Payload carries only the query and already permission-filtered
        // chunk texts: no credentials, tenant ids, user ids, or headers.
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model, query: queryText, documents: documents.map((chunk) => chunk.text) }),
          signal: controller.signal,
        });
      } catch (error) {
        clearTimeout(timer);
        fallBack(error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'http_error');
        return chunks;
      }
      clearTimeout(timer);

      if (!response.ok) {
        fallBack('http_error');
        return chunks;
      }

      let parsed: RerankApiResponse;
      try {
        parsed = (await response.json()) as RerankApiResponse;
      } catch {
        fallBack('invalid_response');
        return chunks;
      }
      const entries = Array.isArray(parsed?.results) ? parsed.results : null;
      if (!entries) {
        fallBack('invalid_response');
        return chunks;
      }

      // Map valid (index -> score) pairs; later duplicates win deterministically.
      const scores = new Map<number, number>();
      for (const entry of entries) {
        const scored = parseScore(entry as RerankApiResult, documents.length);
        if (scored) scores.set(scored.index, scored.score);
      }
      if (scores.size === 0) {
        fallBack('invalid_response');
        return chunks;
      }

      // Reorder: scored documents by score descending (ties keep hybrid order
      // via the stable original index), unscored documents appended in their
      // original relative order, then any chunks beyond topN that were never
      // sent for scoring. The reranker only reorders — it never widens or
      // narrows the authorized candidate set. Scored chunks get a validated
      // [0,1] score proposed (retrieval.ts clamps again and always rebuilds
      // text/document/citation from the canonical candidate map).
      const ordered = documents
        .map((chunk, index) => {
          const score = scores.get(index);
          return { chunk: score === undefined ? chunk : { ...chunk, score }, index, score };
        })
        .sort((a, b) => {
          if (a.score === undefined && b.score === undefined) return a.index - b.index;
          if (a.score === undefined) return 1;
          if (b.score === undefined) return -1;
          return b.score !== a.score ? b.score - a.score : a.index - b.index;
        })
        .map(({ chunk }) => chunk);
      return [...ordered, ...chunks.slice(documents.length)];
    },
  };
  return reranker;
}
