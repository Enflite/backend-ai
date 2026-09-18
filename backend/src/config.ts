import { z } from 'zod';

try {
  // Built-in in Node 20.12+ / 22+. Loads backend/.env into process.env when
  // running locally (npm run dev / migrate). Deployment-provided environment
  // variables always take precedence because loadEnvFile never overrides them.
  process.loadEnvFile?.();
} catch {
  // .env file does not exist or is unreadable; rely on the real environment.
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
  CORS_ORIGIN: z.string().default('http://localhost:8443'),
  VLLM_BASE_URL: z.string().default('http://localhost:8000/v1'),
  VLLM_MODEL: z.string().default('meta-llama/Meta-Llama-3.1-8B-Instruct'),
  VLLM_API_KEY: z.string().optional().default(''),
  AI_PROVIDER_ALLOWED_ORIGINS: z.string().default('http://localhost:8000,http://vllm:8000'),
  AI_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600000).default(120000),
  EMBEDDING_BASE_URL: z.string().url().optional(),
  EMBEDDING_MODEL: z.string().optional(),
  EMBEDDING_MODEL_VERSION: z.string().default('1'),
  EMBEDDING_API_KEY: z.string().optional().default(''),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().min(1).max(4096).default(1536),
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
  MAX_RAG_CONTEXT_CHARACTERS: z.coerce.number().int().min(1000).max(200000).default(24000),
  MALWARE_SCANNER_ENDPOINT: z.string().url().optional(),
  MALWARE_SCAN_MODE: z.enum(['http', 'disabled-development']).default('disabled-development'),
  SYTELINE_BASE_URL: z.string().url().optional(),
  SYTELINE_API_TOKEN: z.string().optional().default(''),
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
  console.error('Configuration error: JWT_SECRET is a documented placeholder value; provide a generated secret (>=32 chars)');
  process.exit(1);
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

export type Config = typeof config;
