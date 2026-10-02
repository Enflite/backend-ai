/**
 * api/tasks.test.ts — generateSytelineTasks client + confirmation copy.
 *
 * fetch is stubbed; no DOM needed. Covers: POST path/method/body,
 * success unwrapping, ApiError propagation on failure, and the
 * success-confirmation message (singular/plural).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import {
  generateSytelineTasks,
  generationConfirmation,
} from './tasks';

const realFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers(),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('generateSytelineTasks', () => {
  it('POSTs the goal to /syteline-tasks/generate and returns the tasks', async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tasks: [
            { id: 't1', title: 'First task' },
            { id: 't2', title: 'Second task' },
          ],
        }),
        headers: new Headers(),
      };
    }) as unknown as typeof fetch;

    const result = await generateSytelineTasks({ goal: 'Bring TRN up to date' });
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0]).toEqual({ id: 't1', title: 'First task' });
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toMatch(/\/syteline-tasks\/generate$/);
    expect(seen[0].init.method).toBe('POST');
    expect(JSON.parse(seen[0].init.body as string)).toEqual({ goal: 'Bring TRN up to date' });
  });

  it('propagates server errors as ApiError', async () => {
    mockFetchOnce(502, { code: 'GENERATE_SCHEMA_MISMATCH', message: 'bad output' });
    await expect(generateSytelineTasks({ goal: 'x' })).rejects.toBeInstanceOf(ApiError);
  });
});

describe('generationConfirmation', () => {
  it('uses singular for one task', () => {
    expect(generationConfirmation(1)).toContain('1 task ');
  });

  it('uses plural for several tasks', () => {
    expect(generationConfirmation(3)).toContain('3 tasks');
  });
});
