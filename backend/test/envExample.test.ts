/**
 * envExample.test.ts — .env.example rot guard + minimal-env proof.
 *
 * 1. Every key in the config.ts zod schema is documented EXACTLY ONCE in
 *    backend/.env.example (commented or not). Fails CI the moment a schema
 *    key is added without documenting it in the example.
 * 2. No unknown keys in .env.example (everything documented must exist in
 *    the schema).
 * 3. Every schema key is actually read somewhere in src/ (no dead config
 *    accumulating in the schema).
 * 4. The minimal START HERE .env satisfies the schema on its own — proving
 *    those lines are all a local dev needs to boot (everything else has a
 *    safe default).
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSchema } from '../src/config.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const backendDir = join(testDir, '..');
const examplePath = join(backendDir, '.env.example');
const srcDir = join(backendDir, 'src');

const schemaKeys = Object.keys(envSchema.shape);

function exampleKeys(): string[] {
  const text = readFileSync(examplePath, 'utf8');
  return [...text.matchAll(/^\s*#?\s*([A-Z][A-Z0-9_]*)\s*=/gm)]
    .map((m) => m[1])
    .filter((k): k is string => typeof k === 'string');
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...tsFiles(p));
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('.env.example rot guard', () => {
  it('documents every schema key exactly once, and nothing unknown', () => {
    const found = exampleKeys();
    const counts = new Map<string, number>();
    for (const k of found) counts.set(k, (counts.get(k) ?? 0) + 1);
    const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    const missing = schemaKeys.filter((k) => !counts.has(k));
    const extra = [...counts.keys()].filter((k) => !schemaKeys.includes(k));
    expect({ dupes, missing, extra }).toEqual({ dupes: [], missing: [], extra: [] });
  });

  it('every schema key is read somewhere in src/ (no dead config)', () => {
    const files = tsFiles(srcDir).filter((f) => !f.endsWith('/config.ts'));
    const bodies = files.map((f) => readFileSync(f, 'utf8'));
    const dead = schemaKeys.filter((key) => {
      const re = new RegExp(`config\\.${key}(?![A-Z0-9_])`);
      return !bodies.some((b) => re.test(b));
    });
    expect(dead).toEqual([]);
  });

  it('the minimal START HERE .env satisfies the schema on its own', () => {
    const minimal = {
      MONGODB_URI: 'mongodb://localhost:27017/enflite-ai',
      JWT_SECRET: 'x'.repeat(32),
      ANTHROPIC_API_KEY: 'sk-ant-test-key',
      SYTELINE_UI_ENABLED: 'true',
      SYTELINE_UI_URL: 'https://syteline.example.test/web',
      CREDENTIAL_STORE_KEY: 'ab'.repeat(32),
      SYTELINE_TASK_RUNNER_ENABLED: 'true',
    };
    const parsed = envSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      // Spot-check that defaults fill the rest.
      expect(parsed.data.PORT).toBe(8080);
      expect(parsed.data.CLAUDE_ENABLED).toBe(true);
      expect(parsed.data.PERMISSIONS_ALL_GRANTED).toBe(true);
      expect(parsed.data.SYTELINE_UI_ENABLED).toBe(true);
      expect(parsed.data.APS_PLANNING_ENABLED).toBe(true);
    }
  });
});
