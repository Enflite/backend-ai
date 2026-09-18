import { z } from 'zod';

try {
  // Built-in in Node 20.12+ / 22+. Loads backend/.env into process.env when
  // running locally (npm run dev / migrate). Deployment-provided environment
  // variables always take precedence because loadEnvFile never overrides them.
  process.loadEnvFile?.();
} catch {
  // .env file does not exist or is unreadable; rely on the real environment.
}

/**
 * Validate a single CORS_ORIGIN entry. '*' combined with credentials:true
 * makes @fastify/cors emit Access-Control-Allow-Origin: *, which browsers
 * reject for credentialed requests, so wildcards (and the opaque 'null'
 * origin) are refused and every entry must parse as a bare http(s) origin
 * (scheme://host[:port], no path, query, or fragment).
 */
export function isValidCorsOrigin(entry: string): boolean {
  const origin = entry.trim();
  if (!origin || origin === '*' || origin.toLowerCase() === 'null') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.origin === origin;
  } catch {
    return false;
  }
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >=32 chars'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  REFRESH_TOKEN_EXPIRES_DAYS: z.coerce.number().int().min(1).max(90).default(7),
  COOKIE_SECURE: z
    .preprocess((val) => val === true || val === 'true' || val === '1', z.boolean())
    .default(false),
  CORS_ORIGIN: z.string().default('http://localhost:8443').refine(
    (value) => value.split(',').every(isValidCorsOrigin),
    'CORS_ORIGIN must be a comma-separated list of valid http(s) origins; wildcards are not allowed with credentialed CORS'
  ),
  // Audit fail-closed: when true, a database outage that prevents persisting
  // an audit event fails the request (503) instead of silently dropping the
  // audit trail. Defaults to true in production and false elsewhere so local
  // development keeps velocity when the audit table is unavailable.
  AUDIT_FAIL_CLOSED: z
    .preprocess(
      (val) => (val === undefined || val === null || val === '' ? undefined : val === true || val === 'true' || val === '1'),
      z.boolean()
    )
    .default(process.env.NODE_ENV === 'production'),
  VLLM_API_KEY: z.string().optional().default(''),
  AI_PROVIDER_ALLOWED_ORIGINS: z.string().default('http://localhost:8000,http://vllm:8000'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  // Upper bound on streamed model output per chat turn. A compromised or
  // misbehaving provider could otherwise stream unbounded content, exhausting
  // server memory (the stream is accumulated for persistence) and database storage.
  AI_MAX_RESPONSE_CHARS: z.coerce.number().int().min(1024).max(1000000).default(65536),
  // Agentic tool loop guard: maximum tool-call rounds per chat turn. Each round
  // may execute several tool calls in parallel; the cap bounds total provider
  // round-trips and prevents runaway loops.
  AI_MAX_TOOL_ITERATIONS: z.coerce.number().int().min(0).max(10).default(5),
  // Tool outputs are untrusted external data; truncate each result before it
  // enters model context so one huge response cannot evict the conversation.
  AI_TOOL_OUTPUT_MAX_CHARS: z.coerce.number().int().min(256).max(100000).default(8000),
  // Per-tool execution timeout, enforced inside runToolCall on top of the
  // caller's (client-disconnect) signal, so a hung tool cannot hold a chat
  // turn or worker slot indefinitely.
  AI_TOOL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(60000),
  // ---------------------------------------------------------------------------
  // Gateway fairness (Phase 4b): in-flight concurrency caps and request-rate
  // limits on the expensive AI endpoints. Hitting a concurrency cap returns a
  // friendly HTTP 429 'busy' body (see src/ai/gateway/limits.ts), never a
  // silent drop. Rate-limit 429s from @fastify/rate-limit use the same body.
  // ---------------------------------------------------------------------------
  // In-flight chat streams per tenant / per user. A slot is held for the
  // whole SSE stream (including agentic tool rounds) and released on
  // close/error/abort. In-process per instance; front multi-instance
  // deployments with a shared limiter (see docs/deployment.md).
  AI_MAX_CONCURRENT_PER_TENANT: z.coerce.number().int().min(1).max(10000).default(20),
  AI_MAX_CONCURRENT_PER_USER: z.coerce.number().int().min(1).max(1000).default(5),
  // In-flight direct tool executions per user. Tool calls fan out, so this is
  // deliberately looser than the chat-stream user cap.
  AI_MAX_CONCURRENT_TOOLS_PER_USER: z.coerce.number().int().min(1).max(10000).default(10),
  // Sustained request rates: @fastify/rate-limit per-route buckets keyed by
  // session token (or IP). The chat stream is long-lived, so its per-minute
  // request rate is lower than the cheap, bursty tool endpoint's.
  CHAT_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(10000).default(30),
  TOOL_RATE_LIMIT_PER_MIN: z.coerce.number().int().min(1).max(100000).default(120),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_MODEL_VERSION: z.string().default('1'),
  EMBEDDING_API_KEY: z.string().optional().default(''),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096).default(1536),
  // Which embedding backend the factory resolves. 'openai-compatible' is the
  // production path (vLLM /v1/embeddings or another approved endpoint);
  // 'ollama' is local-dev only and additionally requires ALLOW_DEV_PROVIDERS.
  EMBEDDING_PROVIDER: z.enum(['openai-compatible', 'ollama']).default('openai-compatible'),
  EMBEDDING_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  // ---------------------------------------------------------------------------
  // Local-dev inference (Ollama). DEV ONLY: ALLOW_DEV_PROVIDERS must be
  // explicitly enabled, and the gateway still refuses ollama-backed models
  // unless the server is a dev server. Ollama is a workstation convenience,
  // never a security boundary and never a production path.
  // ---------------------------------------------------------------------------
  ALLOW_DEV_PROVIDERS: z
    .preprocess(
      (val) => (val === undefined || val === null || val === '' ? undefined : val === true || val === 'true' || val === '1'),
      z.boolean()
    )
    .default(false),
  OLLAMA_BASE_URL: z.string().url().default('http://localhost:11434'),
  OLLAMA_EMBEDDING_MODEL: z.string().min(1).default('nomic-embed-text'),
  OLLAMA_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096).default(768),
  // Allowlist for `ollama pull` via the artifact API. No arbitrary model
  // URLs: only these exact model names may be fetched locally.
  OLLAMA_ALLOWED_MODELS: z.string().default('llama3.1:8b,nomic-embed-text'),
  // Allowlist of origins a registry model's `source` URL may point at.
  // Model registration with any other source origin is rejected.
  MODEL_SOURCE_ALLOWLIST: z.string().default('https://huggingface.co'),
  OBJECT_STORAGE_ENDPOINT: z.string().url().optional(),
  OBJECT_STORAGE_REGION: z.string().default('us-east-1'),
  OBJECT_STORAGE_BUCKET: z.string().min(1).default('enflite-ai-documents'),
  OBJECT_STORAGE_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_SECRET_KEY: z.string().optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z
    .preprocess((val) => val === true || val === 'true' || val === '1', z.boolean())
    .default(true),
  MAX_UPLOAD_BYTES: z.coerce.number().int().min(1024).max(104857600).default(26214400),
  MAX_EXTRACTED_CHARACTERS: z.coerce.number().int().min(1000).max(20000000).default(2000000),
  MAX_ARCHIVE_ENTRIES: z.coerce.number().int().min(1).max(10000).default(1000),
  MAX_ARCHIVE_UNCOMPRESSED_BYTES: z.coerce.number().int().min(1024).max(268435456).default(52428800),
  MAX_DOCUMENT_CHUNKS: z.coerce.number().int().min(1).max(10000).default(2000),
  EMBEDDING_BATCH_SIZE: z.coerce.number().int().min(1).max(256).default(32),
  RAG_TOP_K_MAX: z.coerce.number().int().min(1).max(50).default(20),
  RAG_SIMILARITY_THRESHOLD: z.coerce.number().min(0).max(1).default(0),
  RAG_DIVERSITY_LAMBDA: z.coerce.number().min(0).max(1).default(0.3),
  RAG_QUERY_MAX_CHARS: z.coerce.number().int().min(64).max(20000).default(2000),
  RAG_CHUNK_MAX_CHARS: z.coerce.number().int().min(64).max(20000).default(1600),
  RAG_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(5000).default(200),
  MAX_RAG_CONTEXT_CHARACTERS: z.coerce.number().int().min(1000).max(200000).default(24000),
  // ---------------------------------------------------------------------------
  // Ingestion worker pool (backend/src/documents/queue.ts). The pool runs as
  // part of the server process: recoverIngestionJobs() (called at boot) heals
  // crashed jobs and starts the workers.
  // ---------------------------------------------------------------------------
  // Dedicated worker concurrency: how many ingestion jobs may execute at once.
  // The pool claims jobs round-robin across tenants so one tenant's backlog
  // cannot starve the others.
  INGEST_WORKERS: z.coerce.number().int().min(1).max(32).default(4),
  // Attempts before a failed job is quarantined (terminal; never auto-retried,
  // admin requeue only via POST /documents/jobs/:id/requeue).
  INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(5),
  // Exponential backoff between attempts: base * 2^(attempts-1) with ±20%
  // jitter, capped at INGEST_RETRY_MAX_DELAY_MS.
  INGEST_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(1000).max(600000).default(30000),
  INGEST_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(60000).max(3600000).default(900000),
  MALWARE_SCANNER_ENDPOINT: z.string().url().optional(),
  MALWARE_SCAN_MODE: z.enum(['http', 'disabled-development']).default('disabled-development'),
  SYTELINE_BASE_URL: z.string().url().optional(),
  SYTELINE_API_TOKEN: z.string().optional().default(''),
  // ---------------------------------------------------------------------------
  // Observability (backend/src/observability/). /metrics is public in dev and
  // test for easy scraping; in production it defaults to hidden (404) and
  // should be scraped over a private network or fronted with network policy /
  // reverse-proxy auth. Set METRICS_PUBLIC=true explicitly to expose it.
  // ---------------------------------------------------------------------------
  METRICS_PUBLIC: z
    .preprocess(
      (val) => (val === undefined || val === null || val === '' ? undefined : val === true || val === 'true' || val === '1'),
      z.boolean()
    )
    .default(process.env.NODE_ENV !== 'production'),
  // Per-dependency timeout for the /ready checks. Bounded so one hung
  // dependency cannot stall the readiness probe past the orchestrator's own
  // timeout.
  READY_CHECK_TIMEOUT_MS: z.coerce.number().int().min(250).max(30000).default(2000),
  DEV_AUTH_ENABLED: z
    .preprocess((val) => val === true || val === 'true' || val === '1', z.boolean())
    .default(false),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment configuration:', parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;

// jose accepts durations like '15m', '2h', '7d' for setExpirationTime. Validate
// the format at startup so a typo fails fast instead of breaking every login.
const EXPIRES_IN_PATTERN = /^(\d+)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|week|weeks|y|year|years)?$/i;

export function parseExpiresInToMs(value: string): number {
  const match = EXPIRES_IN_PATTERN.exec(value.trim());
  if (!match) throw new Error(`Invalid JWT_EXPIRES_IN format: '${value}'`);
  const amount = Number.parseInt(match[1]!, 10);
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new Error(`JWT_EXPIRES_IN must be a positive duration: '${value}'`);
  }
  const unit = (match[2] ?? 's').toLowerCase();
  const multipliers: Record<string, number> = {
    ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
    h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
    d: 86400000, day: 86400000, days: 86400000,
    w: 604800000, week: 604800000, weeks: 604800000,
    y: 31536000000, year: 31536000000, years: 31536000000,
  };
  return amount * multipliers[unit]!;
}

try {
  parseExpiresInToMs(config.JWT_EXPIRES_IN);
} catch (error) {
  console.error('Configuration error:', (error as Error).message);
  process.exit(1);
}

// Refuse to boot with a documented placeholder secret. The .env.example and
// compose files document obvious placeholder values; accepting one here would
// turn a forgotten configuration step into a production backdoor.
const PLACEHOLDER_SECRETS = new Set([
  '<redacted>',
  'dev-only-secret-do-not-use-in-production-min-32-chars',
  'change-me',
  'changeme',
  'replace-me',
  'secret',
  'test-secret-please-rotate',
]);

export function isPlaceholderSecret(secret: string): boolean {
  return PLACEHOLDER_SECRETS.has(secret.trim().toLowerCase());
}

if (isPlaceholderSecret(config.JWT_SECRET)) {
  // A documented placeholder must never sign tokens in production, but the
  // default local Compose stack ships one for zero-config dev boot; refuse in
  // production and warn loudly everywhere else.
  if (config.NODE_ENV === 'production') {
    console.error('Configuration error: JWT_SECRET is a documented placeholder value; provide a generated secret (>=32 chars)');
    process.exit(1);
  }
  console.warn('SECURITY WARNING: JWT_SECRET is a documented placeholder value. Set a generated secret (>=32 chars) before any non-local use.');
}

if (config.NODE_ENV === 'production' && config.DEV_AUTH_ENABLED) {
  console.error('Configuration error: DEV_AUTH_ENABLED cannot be true when NODE_ENV is production');
  process.exit(1);
}

if (config.NODE_ENV === 'production' && !config.COOKIE_SECURE) {
  console.error('Configuration error: COOKIE_SECURE must be true when NODE_ENV is production');
  process.exit(1);
}

if (config.NODE_ENV === 'production' && config.MALWARE_SCAN_MODE !== 'http') {
  console.error('Configuration error: production requires MALWARE_SCAN_MODE=http');
  process.exit(1);
}

if (config.MALWARE_SCAN_MODE === 'http' && !config.MALWARE_SCANNER_ENDPOINT) {
  console.error('Configuration error: MALWARE_SCANNER_ENDPOINT is required for http malware scanning');
  process.exit(1);
}

if (config.NODE_ENV === 'production' && config.EMBEDDING_DIMENSIONS !== 1536) {
  console.error('Configuration error: this schema requires 1536-dimensional embeddings');
  process.exit(1);
}

if (config.INGEST_RETRY_MAX_DELAY_MS < config.INGEST_RETRY_BASE_DELAY_MS) {
  console.error('Configuration error: INGEST_RETRY_MAX_DELAY_MS must be >= INGEST_RETRY_BASE_DELAY_MS');
  process.exit(1);
}

export type Config = typeof config;
