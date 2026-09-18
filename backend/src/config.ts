import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >=32 chars'),
  JWT_EXPIRES_IN: z.string().default('8h'),
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
