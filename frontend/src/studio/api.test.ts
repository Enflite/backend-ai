/**
 * studio/api.test.ts — studio REST client: envelope unwrapping and shape
 * validation. fetch is stubbed; no DOM needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import {
  deployStudioAutomation,
  getStudioAutomation,
  getStudioRun,
  isStudioUnavailable,
  listStudioActions,
  listStudioAutomations,
  listStudioConnections,
  listStudioRuns,
  saveStudioAutomation,
  testStudioAutomation,
  undeployStudioAutomation,
} from './api';

const realFetch = globalThis.fetch;

function mockFetchOnce(status: number, body: unknown): void {
  globalThis.fetch = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: new Headers(),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const CONNECTION = {
  id: 'c1',
  name: 'Enflite TRN',
  environment: 'TRN',
  baseUrl: 'https://syteline.example/TRN',
  capabilities: { idoProbe: true },
  updatedAt: '2026-10-02T16:00:00Z',
};

const ACTION = {
  id: 'items.read',
  title: 'Read items',
  description: 'Fetch item records.',
  substrate: 'syteline',
  destructive: false,
  supported: true,
};

describe('listStudioConnections', () => {
  it('unwraps the connections envelope', async () => {
    mockFetchOnce(200, { connections: [CONNECTION] });
    await expect(listStudioConnections()).resolves.toEqual([CONNECTION]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/connections'),
      expect.objectContaining({}),
    );
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { items: [CONNECTION] });
    await expect(listStudioConnections()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });

  it('propagates ApiError from the backend', async () => {
    mockFetchOnce(403, { error: { code: 'FORBIDDEN', message: 'nope' } });
    const err = await listStudioConnections().catch((e) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(403);
  });
});

describe('listStudioActions', () => {
  it('unwraps the actions envelope', async () => {
    mockFetchOnce(200, { actions: [ACTION] });
    await expect(listStudioActions()).resolves.toEqual([ACTION]);
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { actions: 'nope' });
    await expect(listStudioActions()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('isStudioUnavailable', () => {
  it('detects the 404 the catalog returns before the backend slice lands', () => {
    expect(isStudioUnavailable(new ApiError(404, 'NOT_FOUND', 'nope'))).toBe(true);
    expect(isStudioUnavailable(new ApiError(500, 'BOOM', 'nope'))).toBe(false);
    expect(isStudioUnavailable(new Error('nope'))).toBe(false);
  });
});

const AUTOMATION_SUMMARY = {
  id: 'auto-1',
  name: 'late-po-check',
  title: 'Late PO check',
  status: 'draft',
  triggerKind: 'scheduled',
  updatedAt: '2026-10-02T16:00:00Z',
  lastRunAt: null,
};

const AUTOMATION_DETAIL = {
  ...AUTOMATION_SUMMARY,
  description: 'Flags late purchase orders.',
  trigger: { kind: 'scheduled', cron: '0 6 * * *' },
  steps: [{ id: 's1', kind: 'action', actionId: 'syteline.getOpenPurchaseOrders', params: {} }],
  deployment: null,
};

describe('listStudioAutomations', () => {
  it('unwraps the automations envelope', async () => {
    mockFetchOnce(200, { automations: [AUTOMATION_SUMMARY] });
    await expect(listStudioAutomations()).resolves.toEqual([AUTOMATION_SUMMARY]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/automations'),
      expect.objectContaining({}),
    );
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { automations: 'nope' });
    await expect(listStudioAutomations()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('getStudioAutomation', () => {
  it('unwraps the automation envelope', async () => {
    mockFetchOnce(200, { automation: AUTOMATION_DETAIL });
    await expect(getStudioAutomation('auto-1')).resolves.toEqual(AUTOMATION_DETAIL);
  });

  it('rejects a malformed envelope', async () => {
    mockFetchOnce(200, { automation: null });
    await expect(getStudioAutomation('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('saveStudioAutomation', () => {
  it('PUTs the draft wrapped in an automation key', async () => {
    mockFetchOnce(200, { automation: AUTOMATION_DETAIL });
    const draft = {
      name: 'late-po-check',
      title: 'Late PO check',
      description: 'Flags late purchase orders.',
      trigger: { kind: 'scheduled' as const, cron: '0 6 * * *' },
      steps: [],
    };
    await expect(saveStudioAutomation('auto-1', draft)).resolves.toEqual(AUTOMATION_DETAIL);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/automations/auto-1'),
      expect.objectContaining({
        method: 'PUT',
        body: expect.stringContaining('"automation"'),
      }),
    );
  });
});

describe('testStudioAutomation', () => {
  it('POSTs to /test and unwraps the results envelope', async () => {
    const results = [{ stepId: 's1', status: 'ok', durationMs: 120 }];
    mockFetchOnce(200, { results });
    await expect(testStudioAutomation('auto-1')).resolves.toEqual(results);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/automations/auto-1/test'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('rejects a malformed envelope', async () => {
    mockFetchOnce(200, { results: 'nope' });
    await expect(testStudioAutomation('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('deployStudioAutomation', () => {
  it('sends confirmDestructive through to the backend', async () => {
    mockFetchOnce(200, { automation: AUTOMATION_DETAIL });
    await deployStudioAutomation('auto-1', true);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/automations/auto-1/deploy'),
      expect.objectContaining({
        method: 'POST',
        body: expect.stringContaining('"confirmDestructive":true'),
      }),
    );
  });
});

describe('undeployStudioAutomation', () => {
  it('POSTs to /undeploy', async () => {
    mockFetchOnce(200, { automation: AUTOMATION_DETAIL });
    await undeployStudioAutomation('auto-1');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/studio/automations/auto-1/undeploy'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('listStudioRuns / getStudioRun', () => {
  it('unwraps the runs envelope', async () => {
    const run = { id: 'r1', automationId: 'auto-1', automationName: 'Late PO check', status: 'ok', startedAt: '2026-10-02T17:00:00Z' };
    mockFetchOnce(200, { runs: [run] });
    await expect(listStudioRuns()).resolves.toEqual([run]);
  });

  it('unwraps the run envelope', async () => {
    const run = { id: 'r1', automationId: 'auto-1', automationName: 'Late PO check', status: 'ok', startedAt: '2026-10-02T17:00:00Z', steps: [] };
    mockFetchOnce(200, { run });
    await expect(getStudioRun('r1')).resolves.toEqual(run);
  });

  it('rejects malformed envelopes', async () => {
    mockFetchOnce(200, { runs: 'nope' });
    await expect(listStudioRuns()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
    mockFetchOnce(200, { run: null });
    await expect(getStudioRun('r1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});
