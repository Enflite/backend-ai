/**
 * sytelineUiTools.test.ts — the syteline.ui.* tool family.
 *
 * - authorization: callers without `syteline:ui` get TOOL_FORBIDDEN
 * - destructive tools require explicit confirmation (CONFIRMATION_REQUIRED)
 * - runTaskPlan: schema rejects unknown actions / bad steps / >25 steps,
 *   stops at the first failing step, audits every step with keys only
 * - readScreen without a session -> NO_UI_SESSION
 * - every tool fails fast while SYTELINE_UI_ENABLED=false
 * - buildProviderTools: UI tools are not offered to User-role auth
 * - privacy routing: syteline.ui.* is stripped from cloud-served turns
 *
 * All browser behavior runs through the deterministic FakeDriver.
 * VALIDATED IN CI; real Chromium REQUIRES REAL SYTELINE.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { config } from '../src/config.js';
import type { AuthContext, Permission } from '../src/authz/permissions.js';
import {
  authorizeTool,
  getTool,
  redactSecretParams,
  runToolCall,
  toolRegistry,
} from '../src/tools/gateway.js';
import { FakeDriver } from '../src/syteline/ui/fakeDriver.js';
import {
  overrideUiDriverFactory,
  sytelineUiToolDefinitions,
} from '../src/tools/sytelineUi.js';
import { saveCredential } from '../src/syteline/ui/credentialStore.js';
import { buildProviderTools } from '../src/chat/routes.js';
import { stripCustomerDataTools } from '../src/ai/gateway/privacyRouting.js';

const BASE_URL = 'https://syteline.example/web';
const FORM_URL = `${BASE_URL}?form=CustomerOrders`;
const TEST_KEY = randomBytes(32).toString('hex');

function authFor(userId: string, permissions: Permission[]): AuthContext {
  return {
    userId,
    email: `${userId}@example.test`,
    displayName: 'Test User',
    clearance: 'INTERNAL',
    tenantId: 'tenant-a',
    roleId: 'role-1',
    roleName: 'Admin',
    permissions,
    sessionId: 'session-1',
  };
}

const ADMIN_AUTH = () => authFor('user-admin', ['tool:use', 'chat:create', 'syteline:ui']);
const USER_AUTH = () =>
  authFor('user-basic', [
    'tool:use',
    'chat:create',
    'syteline:read',
    'syteline:forms',
    'conversation:read',
  ]);

// In-memory collections: tool_executions rows + syteline_credentials docs.
function memoryDb() {
  const toolExecutions: Array<Record<string, any>> = [];
  const credentials = new Map<string, Record<string, any>>();
  const collection = (name: string) => {
    if (name === 'tool_executions') {
      return {
        insertOne: vi.fn(async (doc: Record<string, any>) => {
          toolExecutions.push({ ...doc });
          return { insertedId: doc._id };
        }),
        updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
          const row = toolExecutions.find((r) => r._id === filter._id);
          if (row) Object.assign(row, update.$set);
          return { modifiedCount: row ? 1 : 0 };
        }),
      };
    }
    if (name === 'syteline_credentials') {
      return {
        findOne: vi.fn(async (filter: Record<string, any>) => {
          for (const doc of credentials.values()) {
            if (doc.tenantId === filter.tenantId && doc.userId === filter.userId) return { ...doc };
          }
          return null;
        }),
        replaceOne: vi.fn(async (filter: Record<string, any>, doc: Record<string, any>, opts: { upsert?: boolean }) => {
          const k = `${filter.tenantId}:${filter.userId}`;
          credentials.set(k, { ...doc });
          return { modifiedCount: 1, upsertedCount: opts?.upsert ? 1 : 0 };
        }),
        deleteOne: vi.fn(async () => ({ deletedCount: 0 })),
        updateOne: vi.fn(async () => ({ modifiedCount: 1 })),
        find: vi.fn(() => ({
          project: vi.fn().mockReturnThis(),
          toArray: vi.fn(async () => []),
        })),
      };
    }
    throw new Error(`unexpected collection ${name}`);
  };
  return { collection, toolExecutions, credentials };
}

let db: ReturnType<typeof memoryDb>;
const evidenceDir = mkdtempSync(join(tmpdir(), 'ui-evidence-'));

function fakeDriverFactory() {
  return async () =>
    FakeDriver.withLoginPage(BASE_URL, 'jsmith1', 's3cret', {
      [FORM_URL]: {
        text: 'Customer Orders\nOrder SO-77821 Status Open',
        fields: { Order: '' },
        buttons: {
          Find: (d) => d.setPageText('Customer Orders\nOrder SO-77821 Status Open\nLine 1 shipped'),
        },
      },
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  db = memoryDb();
  getDbMock.mockImplementation(async () => ({ collection: db.collection }));
  recordAuditMock.mockResolvedValue(undefined);
  const cfg = config as Record<string, unknown>;
  cfg.SYTELINE_UI_ENABLED = true;
  cfg.SYTELINE_UI_URL = BASE_URL;
  cfg.CREDENTIAL_STORE_KEY = TEST_KEY;
  cfg.SYTELINE_UI_EVIDENCE_DIR = evidenceDir;
  overrideUiDriverFactory(fakeDriverFactory());
});

function toolErrorCodeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error: unknown) {
    const err = error as { code?: unknown };
    return typeof err.code === 'string' ? err.code : 'NO_CODE';
  }
  return 'DID_NOT_THROW';
}

describe('tool registration', () => {
  it('registers the full syteline.ui.* family in the tool registry', () => {
    const names = toolRegistry.map((t) => t.name);
    for (const def of sytelineUiToolDefinitions) {
      expect(names).toContain(def.name);
      expect(def.permission).toBe('syteline:ui');
    }
    expect(sytelineUiToolDefinitions.map((d) => d.name)).toEqual([
      'syteline.ui.saveCredentials',
      'syteline.ui.deleteCredentials',
      'syteline.ui.listCredentials',
      'syteline.ui.startSession',
      'syteline.ui.gotoForm',
      'syteline.ui.readScreen',
      'syteline.ui.screenshot',
      'syteline.ui.fillField',
      'syteline.ui.clickButton',
      'syteline.ui.runTaskPlan',
      'syteline.ui.endSession',
      'syteline.ui.listSessions',
    ]);
  });

  it('marks the write actions destructive and the credential saver secret-bearing', () => {
    const destructive = ['saveCredentials', 'deleteCredentials', 'fillField', 'clickButton', 'runTaskPlan'];
    for (const short of destructive) {
      expect(getTool(`syteline.ui.${short}`).destructive).toBe(true);
    }
    expect(getTool('syteline.ui.saveCredentials').secretParams).toEqual(['password']);
    expect(getTool('syteline.ui.readScreen').destructive).toBe(false);
  });
});

describe('authorization', () => {
  it('denies callers without syteline:ui (TOOL_FORBIDDEN)', () => {
    expect(
      toolErrorCodeOf(() => authorizeTool(USER_AUTH(), 'syteline.ui.readScreen', {}, 'INTERNAL', false)),
    ).toBe('TOOL_FORBIDDEN');
  });

  it('denies every UI tool to the User role, including non-destructive ones', () => {
    for (const def of sytelineUiToolDefinitions) {
      expect(
        toolErrorCodeOf(() => authorizeTool(USER_AUTH(), def.name, {}, 'INTERNAL', true)),
        def.name,
      ).toBe('TOOL_FORBIDDEN');
    }
  });

  it('requires explicit confirmation for destructive tools', () => {
    expect(
      toolErrorCodeOf(() =>
        authorizeTool(ADMIN_AUTH(), 'syteline.ui.fillField', { label: 'Order', value: 'x' }, 'INTERNAL', false),
      ),
    ).toBe('CONFIRMATION_REQUIRED');
    expect(
      toolErrorCodeOf(() =>
        authorizeTool(ADMIN_AUTH(), 'syteline.ui.runTaskPlan', { steps: [] }, 'INTERNAL', false),
      ),
    ).toBe('CONFIRMATION_REQUIRED');
  });

  it('fails fast while SYTELINE_UI_ENABLED=false', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_ENABLED = false;
    const result = await runToolCall({
      auth: ADMIN_AUTH(),
      name: 'syteline.ui.readScreen',
      rawArguments: '{}',
      classification: 'INTERNAL',
      confirmed: false,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SYTELINE_UI_DISABLED');
  });
});

describe('session flow (FakeDriver)', () => {
  async function startSessionFor(auth: AuthContext) {
    await saveCredential(auth, 'jsmith1', 's3cret');
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.startSession',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    return result;
  }

  it('startSession logs in and readScreen returns the snapshot', async () => {
    const auth = ADMIN_AUTH();
    await startSessionFor(auth);
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.readScreen',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { text: string }).text).toContain('SyteLine Home');
  });

  it('readScreen without a session reports NO_UI_SESSION', async () => {
    const result = await runToolCall({
      auth: ADMIN_AUTH(),
      name: 'syteline.ui.readScreen',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('NO_UI_SESSION');
  });

  it('screenshot stores evidence server-side and returns an id only', async () => {
    const auth = ADMIN_AUTH();
    await startSessionFor(auth);
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.screenshot',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { evidenceId: string; capturedAt: string };
    expect(data.evidenceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(data)).not.toContain('FAKE-SCREENSHOT');
  });

  it('endSession closes the browser session', async () => {
    const auth = ADMIN_AUTH();
    await startSessionFor(auth);
    const ended = await runToolCall({
      auth,
      name: 'syteline.ui.endSession',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect((ended.data as { ended: boolean }).ended).toBe(true);
    const after = await runToolCall({
      auth,
      name: 'syteline.ui.readScreen',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(after.errorCode).toBe('NO_UI_SESSION');
  });

  it('wrong credentials fail the login without registering a session', async () => {
    const auth = ADMIN_AUTH();
    await saveCredential(auth, 'jsmith1', 'wrong-password');
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.startSession',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    const loginAudits = recordAuditMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === 'SYTELINE_UI_LOGIN',
    );
    expect(loginAudits).toHaveLength(1);
    expect((loginAudits[0]![0] as { success: boolean }).success).toBe(false);
    expect(JSON.stringify(loginAudits)).not.toContain('wrong-password');
  });
});

describe('listSessions', () => {
  async function listSessionsFor(auth: AuthContext) {
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.listSessions',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    return result.data as {
      sessions: Array<{
        sessionId: string;
        userId: string;
        tenantId: string;
        startedAt: string;
        lastUsedAt: string;
        idleMs: number;
        state: string;
      }>;
    };
  }

  it('returns an empty list when no sessions exist', async () => {
    const data = await listSessionsFor(ADMIN_AUTH());
    expect(data.sessions).toEqual([]);
  });

  it('lists the caller session with metadata only — never secrets', async () => {
    const auth = ADMIN_AUTH();
    await saveCredential(auth, 'jsmith1', 's3cret');
    const started = await runToolCall({
      auth,
      name: 'syteline.ui.startSession',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(started.ok).toBe(true);
    const data = await listSessionsFor(auth);
    expect(data.sessions).toHaveLength(1);
    const session = data.sessions[0]!;
    expect(session.sessionId).toBe(
      (started.data as { sessionId: string }).sessionId,
    );
    expect(session.userId).toBe(auth.userId);
    expect(session.tenantId).toBe(auth.tenantId);
    expect(session.state).toBe('active');
    expect(session.idleMs).toBeGreaterThanOrEqual(0);
    expect(new Date(session.startedAt).getTime()).not.toBeNaN();
    expect(new Date(session.lastUsedAt).getTime()).not.toBeNaN();
    expect(JSON.stringify(data)).not.toContain('s3cret');
    expect(Object.keys(session).sort()).toEqual([
      'idleMs',
      'lastUsedAt',
      'sessionId',
      'startedAt',
      'state',
      'tenantId',
      'userId',
    ]);
  });

  it('is tenant-scoped: other tenants’ sessions are not listed', async () => {
    const authA = ADMIN_AUTH();
    const authB = authFor('user-other', ['tool:use', 'chat:create', 'syteline:ui']);
    (authB as { tenantId: string }).tenantId = 'tenant-b';
    await saveCredential(authA, 'jsmith1', 's3cret');
    await saveCredential(authB, 'jsmith1', 's3cret');
    for (const auth of [authA, authB]) {
      const started = await runToolCall({
        auth,
        name: 'syteline.ui.startSession',
        rawArguments: '{}',
        classification: 'INTERNAL',
        signal: new AbortController().signal,
      });
      expect(started.ok).toBe(true);
    }
    const data = await listSessionsFor(authA);
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0]!.tenantId).toBe('tenant-a');
    expect(data.sessions[0]!.userId).toBe(authA.userId);
  });

  it('fails fast while SYTELINE_UI_ENABLED=false', async () => {
    (config as Record<string, unknown>).SYTELINE_UI_ENABLED = false;
    const result = await runToolCall({
      auth: ADMIN_AUTH(),
      name: 'syteline.ui.listSessions',
      rawArguments: '{}',
      classification: 'INTERNAL',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('SYTELINE_UI_DISABLED');
  });
});

describe('runTaskPlan', () => {
  const PLAN_ARGS = JSON.stringify({
    steps: [
      { action: 'gotoForm', form: 'CustomerOrders' },
      { action: 'fillField', label: 'Order', value: 'SO-77821' },
      { action: 'clickButton', label: 'Find' },
      { action: 'readScreen' },
      { action: 'assertText', text: 'Line 1 shipped' },
    ],
  });

  it('executes the full plan and reports per-step outcomes', async () => {
    const auth = ADMIN_AUTH();
    await saveCredential(auth, 'jsmith1', 's3cret');
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.runTaskPlan',
      rawArguments: PLAN_ARGS,
      classification: 'INTERNAL',
      confirmed: true,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    const data = result.data as {
      completed: boolean;
      stepsExecuted: number;
      failedStep: null;
      steps: Array<{ step: number; action: string; ok: boolean }>;
      observations: Array<{ step: number; text: string }>;
    };
    expect(data.completed).toBe(true);
    expect(data.stepsExecuted).toBe(5);
    expect(data.failedStep).toBeNull();
    expect(data.steps.map((s) => s.action)).toEqual([
      'gotoForm',
      'fillField',
      'clickButton',
      'readScreen',
      'assertText',
    ]);
    expect(data.observations).toHaveLength(1);
    expect(data.observations[0]!.text).toContain('Line 1 shipped');
  });

  it('rejects unknown actions and malformed steps at the schema', () => {
    expect(
      toolErrorCodeOf(() =>
        authorizeTool(
          ADMIN_AUTH(),
          'syteline.ui.runTaskPlan',
          { steps: [{ action: 'hackThePlanet' }] },
          'INTERNAL',
          true,
        ),
      ),
    ).toBe('INVALID_TOOL_PARAMETERS');
    expect(
      toolErrorCodeOf(() =>
        authorizeTool(ADMIN_AUTH(), 'syteline.ui.runTaskPlan', { steps: [] }, 'INTERNAL', true),
      ),
    ).toBe('INVALID_TOOL_PARAMETERS');
    expect(
      toolErrorCodeOf(() =>
        authorizeTool(
          ADMIN_AUTH(),
          'syteline.ui.runTaskPlan',
          { steps: Array.from({ length: 26 }, () => ({ action: 'readScreen' })) },
          'INTERNAL',
          true,
        ),
      ),
    ).toBe('INVALID_TOOL_PARAMETERS');
  });

  it('stops at the first failing step and audits every step with keys only', async () => {
    const auth = ADMIN_AUTH();
    await saveCredential(auth, 'jsmith1', 's3cret');
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.runTaskPlan',
      rawArguments: JSON.stringify({
        steps: [
          { action: 'gotoForm', form: 'CustomerOrders' },
          { action: 'fillField', label: 'NoSuchField', value: 'SO-77821' },
          { action: 'readScreen' },
        ],
      }),
      classification: 'INTERNAL',
      confirmed: true,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    const data = result.data as { completed: boolean; stepsExecuted: number; failedStep: number };
    expect(data.completed).toBe(false);
    expect(data.stepsExecuted).toBe(2);
    expect(data.failedStep).toBe(1);

    const stepAudits = recordAuditMock.mock.calls.filter(
      (call: unknown[]) => (call[0] as { action: string }).action === 'SYTELINE_UI_PLAN_STEP',
    );
    expect(stepAudits).toHaveLength(2);
    // Keys and identifiers only: the filled value never enters the audit trail.
    const serialized = JSON.stringify(stepAudits);
    expect(serialized).not.toContain('SO-77821');
    expect(serialized).toContain('fillField');
  });
});

describe('secretParams redaction', () => {
  it('redactSecretParams masks declared keys and leaves the rest', () => {
    expect(redactSecretParams(['password'], { username: 'jsmith1', password: 's3cret' })).toEqual({
      username: 'jsmith1',
      password: '[REDACTED]',
    });
    expect(redactSecretParams(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(redactSecretParams(['password'], null)).toBeNull();
  });

  it('runToolCall persists saveCredentials parameters with the password redacted', async () => {
    const auth = ADMIN_AUTH();
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.saveCredentials',
      rawArguments: JSON.stringify({ username: 'jsmith1', password: 'super-secret-pw' }),
      classification: 'INTERNAL',
      confirmed: true,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(db.toolExecutions).toHaveLength(1);
    const persisted = db.toolExecutions[0]!.parameters as Record<string, unknown>;
    expect(persisted.username).toBe('jsmith1');
    expect(persisted.password).toBe('[REDACTED]');
    expect(JSON.stringify(db.toolExecutions)).not.toContain('super-secret-pw');
  });

  it('runToolCall redacts secrets from malformed raw arguments too', async () => {
    const auth = ADMIN_AUTH();
    const result = await runToolCall({
      auth,
      name: 'syteline.ui.saveCredentials',
      // Malformed JSON (trailing comma) carrying a cleartext password.
      rawArguments: '{"username": "jsmith1", "password": "leaky-pw",}',
      classification: 'INTERNAL',
      confirmed: true,
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_TOOL_ARGUMENTS');
    expect(db.toolExecutions).toHaveLength(1);
    const persisted = db.toolExecutions[0]!.parameters as { raw: string };
    expect(persisted.raw).toContain('[REDACTED]');
    expect(JSON.stringify(db.toolExecutions)).not.toContain('leaky-pw');
  });

  it('audit metadata for the save flow never carries the password', async () => {
    const auth = ADMIN_AUTH();
    await runToolCall({
      auth,
      name: 'syteline.ui.saveCredentials',
      rawArguments: JSON.stringify({ username: 'jsmith1', password: 'audit-secret-pw' }),
      classification: 'INTERNAL',
      confirmed: true,
      signal: new AbortController().signal,
    });
    expect(JSON.stringify(recordAuditMock.mock.calls)).not.toContain('audit-secret-pw');
  });
});

describe('chat tool offering + privacy routing', () => {
  it('does not offer syteline.ui.* tools to a User-role auth', () => {
    const tools = buildProviderTools(USER_AUTH(), 'INTERNAL');
    const names = tools.map((t) => t.function.name);
    expect(names).not.toContain('syteline.ui.startSession');
    expect(names.filter((n) => n.startsWith('syteline.ui.'))).toHaveLength(0);
    // ...but the default-open form tools remain.
    expect(names).toContain('syteline.form_start_project');
  });

  it('offers syteline.ui.* tools to an Admin auth', () => {
    const tools = buildProviderTools(ADMIN_AUTH(), 'INTERNAL');
    const names = tools.map((t) => t.function.name);
    expect(names.filter((n) => n.startsWith('syteline.ui.'))).toHaveLength(
      sytelineUiToolDefinitions.length,
    );
  });

  it('strips syteline.ui.* from cloud-served turns (syteline. prefix inheritance)', () => {
    const tools = sytelineUiToolDefinitions.map((d) => ({ function: { name: d.name } }));
    const stripped = stripCustomerDataTools(tools, ['customer', 'finance'], true);
    expect(stripped).toHaveLength(0);
  });
});
