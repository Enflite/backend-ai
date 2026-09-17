import { z } from 'zod';

try {
  // Built-in in Node 20.12+ / 22+
  process.loadEnvFile?.();
} catch {
  // .env file does not exist or environment variables already set
}

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be >=32 chars'),
  JWT_EXPIRES_IN: z.string().default('8h'),
  VLLM_BASE_URL: z.string().default('http://localhost:8000/v1'),
  VLLM_MODEL: z.string().default('meta-llama/Meta-Llama-3.1-8B-Instruct'),
  VLLM_API_KEY: z.string().optional().default(''),
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

export type Config = typeof config;
