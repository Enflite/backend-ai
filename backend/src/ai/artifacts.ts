/**
 * ai/artifacts.ts — model artifact management.
 *
 * Two paths, kept deliberately separate:
 *
 * DEV (Ollama): pull/cache models on the developer workstation via the
 * Ollama API. Only model names on the OLLAMA_ALLOWED_MODELS allowlist can
 * be pulled — no arbitrary model URLs, ever. Refused unless
 * ALLOW_DEV_PROVIDERS is enabled.
 *
 * PRODUCTION (vLLM): models are deployed to private vLLM infrastructure by
 * configuration, not by the application. The platform never downloads model
 * weights itself in production; it only records which versioned artifact a
 * registry entry points at (source URL allowlisted, SHA-256 pinned) and
 * serves traffic to the vLLM endpoint that hosts it. See docs/inference.md
 * for the deployment runbook.
 */
import { config } from '../config.js';
import { Errors } from '../errors.js';

export interface OllamaModelStatus {
  name: string;
  present: boolean;
  sizeBytes: number | null;
  details: string | null;
}

function devOnlyGuard(): void {
  if (!config.ALLOW_DEV_PROVIDERS) {
    throw Errors.forbidden(
      'MODEL_ARTIFACT_DEV_ONLY',
      'Model artifact management is for local development only and dev providers are not enabled on this server'
    );
  }
}

function allowedModelOrThrow(name: string): string {
  const normalized = name.trim();
  const allowed = new Set(
    config.OLLAMA_ALLOWED_MODELS.split(',').map((v) => v.trim()).filter(Boolean)
  );
  if (!allowed.has(normalized)) {
    throw Errors.forbidden(
      'MODEL_SOURCE_DENIED',
      'Model is not on the allowed local-dev model list'
    );
  }
  return normalized;
}

/**
 * Eager pre-check for a local model pull: dev-only gate + allowlist.
 * pullLocalModel re-checks on iteration (defense in depth), but callers
 * that switch to raw SSE streaming must run this BEFORE touching
 * reply.raw — afterwards Fastify can no longer render an error as JSON.
 */
export function assertLocalPullAllowed(name: string): string {
  devOnlyGuard();
  return allowedModelOrThrow(name);
}

/** List locally cached Ollama models (dev only). */
export async function listLocalModels(): Promise<OllamaModelStatus[]> {
  devOnlyGuard();
  const response = await fetch(`${config.OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/tags`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    throw Errors.internal('Ollama is not reachable', undefined, 'OLLAMA_UNAVAILABLE');
  }
  const payload = (await response.json()) as { models?: Array<{ name?: string; size?: number; details?: unknown }> };
  return (payload.models ?? []).map((m) => ({
    name: typeof m.name === 'string' ? m.name : 'unknown',
    present: true,
    sizeBytes: typeof m.size === 'number' ? m.size : null,
    details: null,
  }));
}

/**
 * Pull an allowlisted model into the local Ollama cache (dev only).
 * Streams progress events; the caller decides how to surface them.
 */
export async function* pullLocalModel(
  name: string,
  signal?: AbortSignal
): AsyncGenerator<{ status: string; completed?: number; total?: number }, void, unknown> {
  // Re-checked on every iteration: the allowlist/config can change between
  // the route's eager pre-check and stream consumption.
  const model = assertLocalPullAllowed(name);
  const response = await fetch(`${config.OLLAMA_BASE_URL.replace(/\/+$/, '')}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(600000)])
      : AbortSignal.timeout(600000),
  });
  if (!response.ok) {
    await response.text().catch(() => '');
    throw Errors.internal('Ollama model pull failed', undefined, 'OLLAMA_PULL_FAILED');
  }
  if (!response.body) throw Errors.internal('Ollama pull returned no body', undefined, 'OLLAMA_PULL_FAILED');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const emitLine = function* (line: string) {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as { status?: unknown; completed?: unknown; total?: unknown };
      if (typeof parsed.status === 'string') {
        yield {
          status: parsed.status.slice(0, 200),
          ...(typeof parsed.completed === 'number' ? { completed: parsed.completed } : {}),
          ...(typeof parsed.total === 'number' ? { total: parsed.total } : {}),
        };
      }
    } catch {
      // Skip malformed progress lines.
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        yield* emitLine(line);
      }
    }
    // Flush a final progress line that was not newline-terminated so the
    // terminal "success" status is never silently dropped by chunking.
    if (buffer.trim()) {
      yield* emitLine(buffer);
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Validate a registry model source URL against the allowlist. Called when
 * models are registered or updated: arbitrary model URLs are never stored.
 * Empty sources are allowed (local/dev or already-deployed artifacts).
 */
export function assertAllowedModelSource(source: string | null | undefined): void {
  if (!source || !source.trim()) return;
  let origin: string;
  try {
    origin = new URL(source.trim()).origin;
  } catch {
    throw Errors.badRequest('MODEL_SOURCE_INVALID', 'Model source is not a valid URL');
  }
  const allowed = new Set(
    config.MODEL_SOURCE_ALLOWLIST.split(',').map((v) => v.trim()).filter(Boolean)
  );
  if (!allowed.has(origin)) {
    throw Errors.forbidden('MODEL_SOURCE_DENIED', 'Model source origin is not allowlisted');
  }
}
