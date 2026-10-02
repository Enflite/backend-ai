/**
 * api/syteline.test.ts — parameter assembly for the SyteLine ops tool calls.
 *
 * Mocks the HTTP transport (api.request) and asserts each module function
 * hits the right /tools/:name/execute endpoint with the exact parameter
 * shape the backend tools expect, passes classification/confirmed through,
 * and unwraps the tool-result envelope. No live backend; deterministic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const requestMock = vi.fn();
vi.mock('../api', () => ({
  api: { request: (...args: unknown[]) => requestMock(...args) },
}));

import {
  deleteSytelineCredentials,
  endSytelineSession,
  listSytelineCredentials,
  saveSytelineCredentials,
  startSytelineSession,
} from './syteline';

beforeEach(() => {
  requestMock.mockReset();
});

/** The last (path, init) pair the transport saw, with the JSON body parsed. */
function lastCall() {
  const [path, init] = requestMock.mock.calls.at(-1) as [string, { method: string; body: string }];
  return { path, method: init.method, body: JSON.parse(init.body) as Record<string, unknown> };
}

describe('listSytelineCredentials', () => {
  it('calls syteline.ui.listCredentials with empty parameters and the given classification', async () => {
    requestMock.mockResolvedValueOnce({ executionId: 'e1', result: { credentials: [] }, truncated: false });

    const credentials = await listSytelineCredentials('INTERNAL');

    const call = lastCall();
    expect(call.path).toBe('/tools/syteline.ui.listCredentials/execute');
    expect(call.method).toBe('POST');
    expect(call.body.parameters).toEqual({});
    expect(call.body.classification).toBe('INTERNAL');
    expect(credentials).toEqual([]);
  });

  it('unwraps the { credentials } envelope and passes entries through', async () => {
    const entry = { username: 'jsmith1', label: 'personal', updatedAt: '2026-10-02T00:00:00.000Z', lastUsedAt: '2026-10-02T01:00:00.000Z' };
    requestMock.mockResolvedValueOnce({ executionId: 'e2', result: { credentials: [entry] }, truncated: false });

    expect(await listSytelineCredentials('INTERNAL')).toEqual([entry]);
  });
});

describe('saveSytelineCredentials', () => {
  it('sends username/password/label and confirmed=true for an acknowledged save', async () => {
    requestMock.mockResolvedValueOnce({
      executionId: 'e3',
      result: { saved: true, username: 'jsmith1', updatedAt: '2026-10-02T00:00:00.000Z' },
      truncated: false,
    });

    const result = await saveSytelineCredentials(
      'INTERNAL',
      { username: 'jsmith1', password: 's3cret', label: 'personal login' },
      true,
    );

    const call = lastCall();
    expect(call.path).toBe('/tools/syteline.ui.saveCredentials/execute');
    expect(call.body.parameters).toEqual({ username: 'jsmith1', password: 's3cret', label: 'personal login' });
    expect(call.body.confirmed).toBe(true);
    expect(call.body.classification).toBe('INTERNAL');
    expect(result).toEqual({ saved: true, username: 'jsmith1', updatedAt: '2026-10-02T00:00:00.000Z' });
  });

  it('omits the label key entirely when no label is supplied', async () => {
    requestMock.mockResolvedValueOnce({
      executionId: 'e4',
      result: { saved: true, username: 'jsmith1', updatedAt: '2026-10-02T00:00:00.000Z' },
      truncated: false,
    });

    await saveSytelineCredentials('INTERNAL', { username: 'jsmith1', password: 's3cret' }, true);

    expect(lastCall().body.parameters).toEqual({ username: 'jsmith1', password: 's3cret' });
    expect('label' in (lastCall().body.parameters as Record<string, unknown>)).toBe(false);
  });

  it('passes confirmed=false when the save was not acknowledged', async () => {
    requestMock.mockResolvedValueOnce({
      executionId: 'e5',
      result: { saved: true, username: 'jsmith1', updatedAt: '2026-10-02T00:00:00.000Z' },
      truncated: false,
    });

    await saveSytelineCredentials('INTERNAL', { username: 'jsmith1', password: 's3cret' }, false);

    expect(lastCall().body.confirmed).toBe(false);
  });
});

describe('deleteSytelineCredentials', () => {
  it('calls syteline.ui.deleteCredentials with empty parameters and confirmed=true', async () => {
    requestMock.mockResolvedValueOnce({ executionId: 'e6', result: { deleted: true }, truncated: false });

    expect(await deleteSytelineCredentials('INTERNAL', true)).toEqual({ deleted: true });

    const call = lastCall();
    expect(call.path).toBe('/tools/syteline.ui.deleteCredentials/execute');
    expect(call.body.parameters).toEqual({});
    expect(call.body.confirmed).toBe(true);
  });
});

describe('startSytelineSession', () => {
  it('calls syteline.ui.startSession and returns the session payload', async () => {
    const session = { sessionId: 'sess-1', startedAt: '2026-10-02T00:00:00.000Z', url: 'https://syteline.example/webui' };
    requestMock.mockResolvedValueOnce({ executionId: 'e7', result: session, truncated: false });

    expect(await startSytelineSession('INTERNAL')).toEqual(session);

    const call = lastCall();
    expect(call.path).toBe('/tools/syteline.ui.startSession/execute');
    expect(call.body.parameters).toEqual({});
    expect(call.body.confirmed).toBe(false);
  });
});

describe('endSytelineSession', () => {
  it('calls syteline.ui.endSession and returns the ended flag', async () => {
    requestMock.mockResolvedValueOnce({ executionId: 'e8', result: { ended: true }, truncated: false });

    expect(await endSytelineSession('INTERNAL')).toEqual({ ended: true });

    const call = lastCall();
    expect(call.path).toBe('/tools/syteline.ui.endSession/execute');
    expect(call.body.parameters).toEqual({});
  });
});
