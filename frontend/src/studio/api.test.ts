/**
 * studio/api.test.ts — studio REST client: envelope unwrapping, the real
 * backend contract (lists as { items }, single resources as the bare view),
 * and shape validation. fetch is stubbed; no DOM needed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api';
import {
  createStudioAutomation,
  deleteStudioAutomation,
  deployStudioAutomation,
  explainStudioAutomation,
  generateStudioAutomation,
  getStudioAutomation,
  getStudioRun,
  isStudioUnavailable,
  listStudioActions,
  listStudioAutomations,
  listStudioConnections,
  listStudioRuns,
  saveStudioAutomation,
  suggestStudioAutomationSteps,
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

function lastFetchArgs(): { url: string; init: Record<string, unknown> } {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  const [url, init] = mock.mock.calls[mock.mock.calls.length - 1] as [string, Record<string, unknown>];
  return { url, init: init ?? {} };
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

/** A backend AutomationPublicView, as the real API serves it. */
const VIEW = {
  id: 'auto-1',
  name: 'late-po-check',
  title: 'Late PO check',
  description: 'Flags late purchase orders.',
  status: 'draft',
  trigger: { kind: 'scheduled', cron: '0 6 * * *', timezone: 'UTC', inputs: {} },
  steps: [
    {
      id: 's1',
      kind: 'action',
      actionId: 'syteline.getOpenPurchaseOrders',
      connectionId: 'default',
      params: {},
      retries: 0,
      continueOnError: false,
    },
    {
      id: 's2',
      kind: 'condition',
      when: "{{steps.s1.output.data.status}} == 'open'",
      then: 's3',
      else: 's3',
    },
  ],
  destructiveSteps: [],
  deployment: { status: 'never', flowName: 'studio-auto-1' },
  createdBy: 'u1',
  createdAt: '2026-10-02T16:00:00Z',
  updatedAt: '2026-10-02T16:00:00Z',
};

describe('listStudioAutomations', () => {
  it('unwraps the items envelope into summaries', async () => {
    mockFetchOnce(200, { items: [VIEW] });
    const summaries = await listStudioAutomations();
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toMatchObject({
      id: 'auto-1',
      name: 'late-po-check',
      title: 'Late PO check',
      status: 'draft',
      triggerKind: 'scheduled',
      updatedAt: '2026-10-02T16:00:00Z',
      lastRunAt: null,
    });
  });

  it('rejects a malformed envelope instead of inventing shapes', async () => {
    mockFetchOnce(200, { automations: [VIEW] });
    await expect(listStudioAutomations()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });

  it('rejects a malformed item', async () => {
    mockFetchOnce(200, { items: [{ nope: true }] });
    await expect(listStudioAutomations()).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('getStudioAutomation', () => {
  it('adapts the bare backend view', async () => {
    mockFetchOnce(200, VIEW);
    const automation = await getStudioAutomation('auto-1');
    expect(automation.id).toBe('auto-1');
    expect(automation.trigger).toMatchObject({
      kind: 'scheduled',
      cron: '0 6 * * *',
      timezone: 'UTC',
    });
    expect(automation.steps[1]).toMatchObject({
      id: 's2',
      kind: 'condition',
      when: "{{steps.s1.output.data.status}} == 'open'",
      then: 's3',
      else: 's3',
      expression: "{{steps.s1.output.data.status}} == 'open'",
    });
    expect(automation.deployment).toBeNull();
  });

  it('rejects a malformed view', async () => {
    mockFetchOnce(200, { nope: true });
    await expect(getStudioAutomation('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('createStudioAutomation / saveStudioAutomation', () => {
  const draft = {
    name: 'late-po-check',
    title: 'Late PO check',
    description: 'Flags late purchase orders.',
    trigger: { kind: 'manual' as const },
    steps: [],
  };

  it('POSTs the backend-shaped draft on create', async () => {
    mockFetchOnce(201, VIEW);
    await expect(createStudioAutomation(draft)).resolves.toMatchObject({ id: 'auto-1' });
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({
      name: 'late-po-check',
      title: 'Late PO check',
      trigger: { kind: 'manual' },
      steps: [],
    });
  });

  it('PATCHes the backend-shaped draft on save', async () => {
    mockFetchOnce(200, VIEW);
    await expect(saveStudioAutomation('auto-1', draft)).resolves.toMatchObject({ id: 'auto-1' });
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1');
    expect(init.method).toBe('PATCH');
    const sent = JSON.parse(String(init.body));
    expect(sent.trigger).toEqual({ kind: 'manual' });
  });
});

describe('deleteStudioAutomation', () => {
  it('DELETEs the automation', async () => {
    mockFetchOnce(204, null);
    await expect(deleteStudioAutomation('auto-1')).resolves.toBeUndefined();
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1');
    expect(init.method).toBe('DELETE');
  });
});

describe('testStudioAutomation', () => {
  it('POSTs to /test and maps the dry-run report', async () => {
    mockFetchOnce(200, {
      automationId: 'auto-1',
      automationName: 'Late PO check',
      executedAt: '2026-10-02T17:00:00Z',
      dryRun: true,
      steps: [
        { stepId: 's1', kind: 'action', status: 'ok', skipped: false, durationMs: 120 },
        { stepId: 's2', kind: 'action', status: 'skipped', skipped: true, detail: 'destructive' },
      ],
    });
    const results = await testStudioAutomation('auto-1');
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ stepId: 's1', status: 'ok', durationMs: 120 });
    expect(results[1]).toMatchObject({ stepId: 's2', status: 'skipped', skipped: true });
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1/test');
    expect(init.method).toBe('POST');
  });

  it('rejects a malformed report', async () => {
    mockFetchOnce(200, { results: 'nope' });
    await expect(testStudioAutomation('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('deployStudioAutomation', () => {
  it('sends confirmDestructive through to the backend', async () => {
    mockFetchOnce(200, VIEW);
    await deployStudioAutomation('auto-1', true);
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1/deploy');
    expect(init.method).toBe('POST');
    expect(String(init.body)).toContain('"confirmDestructive":true');
  });

  it('merges an issued webhook URL onto the trigger', async () => {
    mockFetchOnce(200, {
      ...VIEW,
      trigger: { kind: 'webhook' },
      webhookUrl: '/api/v1/studio/hooks/secret-token',
    });
    const automation = await deployStudioAutomation('auto-1', false);
    expect(automation.trigger.webhookUrl).toBe('/api/v1/studio/hooks/secret-token');
  });
});

describe('undeployStudioAutomation', () => {
  it('POSTs to /undeploy', async () => {
    mockFetchOnce(200, VIEW);
    await undeployStudioAutomation('auto-1');
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1/undeploy');
    expect(init.method).toBe('POST');
  });
});

describe('generateStudioAutomation', () => {
  it('POSTs the prompt and adapts the created draft', async () => {
    mockFetchOnce(201, VIEW);
    const draft = await generateStudioAutomation('Watch for late POs', 'conn-1');
    expect(draft.id).toBe('auto-1');
    expect(draft.status).toBe('draft');
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/generate');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ prompt: 'Watch for late POs', connectionId: 'conn-1' });
  });

  it('omits connectionId when not given', async () => {
    mockFetchOnce(201, VIEW);
    await generateStudioAutomation('Watch for late POs');
    const { init } = lastFetchArgs();
    expect(JSON.parse(String(init.body))).toEqual({ prompt: 'Watch for late POs' });
  });

  it('rejects a malformed draft', async () => {
    mockFetchOnce(201, { nope: true });
    await expect(generateStudioAutomation('x')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('explainStudioAutomation', () => {
  const EXPLANATION = {
    automationId: 'auto-1',
    title: 'Late PO check',
    summary: 'This automation "Late PO check" has 2 step(s) and no destructive steps.',
    trigger: { kind: 'scheduled', text: 'It runs on the schedule "0 6 * * *".' },
    steps: [{ stepId: 's1', kind: 'action', text: 'Step 1 (s1) runs the action "Get open purchase orders".' }],
    destructive: [],
  };

  it('POSTs to /explain and returns the explanation', async () => {
    mockFetchOnce(200, EXPLANATION);
    await expect(explainStudioAutomation('auto-1')).resolves.toEqual(EXPLANATION);
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1/explain');
    expect(init.method).toBe('POST');
  });

  it('rejects a malformed explanation', async () => {
    mockFetchOnce(200, { summary: 'nope' });
    await expect(explainStudioAutomation('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
  });
});

describe('suggestStudioAutomationSteps', () => {
  const SUGGESTIONS = {
    automationId: 'auto-1',
    suggestions: [
      {
        id: 'suggestion-1',
        kind: 'verify',
        title: 'Verify: Get open purchase orders',
        reason: 'Re-fetches and blocks the run when the assertion fails.',
        step: { id: 'step-verify', kind: 'verify', actionId: 'syteline.getOpenPurchaseOrders' },
      },
    ],
  };

  it('POSTs to /suggest and returns the suggestions', async () => {
    mockFetchOnce(200, SUGGESTIONS);
    await expect(suggestStudioAutomationSteps('auto-1')).resolves.toEqual(SUGGESTIONS.suggestions);
    const { url, init } = lastFetchArgs();
    expect(url).toContain('/studio/automations/auto-1/suggest');
    expect(init.method).toBe('POST');
  });

  it('rejects a malformed response', async () => {
    mockFetchOnce(200, { suggestions: 'nope' });
    await expect(suggestStudioAutomationSteps('auto-1')).rejects.toMatchObject({ code: 'STUDIO_MALFORMED' });
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
