import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

const { getDbMock } = vi.hoisted(() => {
  const getDbMock = vi.fn();
  return { getDbMock };
});
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
// recordAudit is mocked to keep tests DB-free; the real sanitizeReason is kept
// so tests can assert sanitized server-side diagnostics end-to-end.
vi.mock('../src/audit/audit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/audit/audit.js')>()),
  recordAudit,
}));

import {
  authorizeTool,
  runToolCall,
  zodToJsonSchema,
  toolRegistry,
} from '../src/tools/gateway.js';
import type { Permission } from '../src/authz/permissions.js';

const auth = {
  userId: 'user-1',
  tenantId: 'tenant-1',
  sessionId: 'sess-1',
  roleId: 'role-1',
  email: 'u@test',
  displayName: 'U',
  roleName: 'User',
  clearance: 'INTERNAL' as const,
  permissions: ['tool:use', 'syteline:read'] as Permission[],
};

const sytelineTool = toolRegistry.find((tool) => tool.name === 'syteline.getItem')!;
const originalExecute = sytelineTool.execute;

// Mock collections registry
const mockCollections: Record<string, any> = {};
function getMockCollection(name: string) {
  if (!mockCollections[name]) {
    mockCollections[name] = {
      findOne: vi.fn().mockResolvedValue(null),
      insertOne: vi.fn().mockResolvedValue({ acknowledged: true, insertedId: 'exec-1' }),
      updateOne: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
      updateMany: vi.fn().mockResolvedValue({ acknowledged: true, modifiedCount: 1 }),
    };
  }
  return mockCollections[name];
}

beforeEach(() => {
  vi.clearAllMocks();
  sytelineTool.execute = originalExecute;
  // Reset mock collections
  for (const name of Object.keys(mockCollections)) {
    const coll = mockCollections[name];
    coll.findOne.mockReset();
    coll.findOne.mockResolvedValue(null);
    coll.insertOne.mockReset();
    coll.insertOne.mockResolvedValue({ acknowledged: true, insertedId: 'exec-1' });
    coll.updateOne.mockReset();
    coll.updateOne.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
    coll.updateMany.mockReset();
    coll.updateMany.mockResolvedValue({ acknowledged: true, modifiedCount: 1 });
  }
  getDbMock.mockReset();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => getMockCollection(name),
  }));
  recordAudit.mockResolvedValue(undefined);
});

describe('zodToJsonSchema', () => {
  it('converts the syteline tool schema faithfully', () => {
    const schema = zodToJsonSchema(sytelineTool.schema);
    expect(schema).toEqual({
      type: 'object',
      properties: {
        item: { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9._/-]+$' },
        site: { type: 'string', minLength: 1, maxLength: 40, pattern: '^[A-Za-z0-9_-]+$' },
      },
      required: ['item', 'site'],
      additionalProperties: false,
    });
  });

  it('handles nested and optional types', () => {
    const schema = zodToJsonSchema(
      z.object({
        name: z.string(),
        count: z.number().optional(),
        mode: z.enum(['a', 'b']).default('a'),
        tags: z.array(z.string()),
      })
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
        mode: { type: 'string', enum: ['a', 'b'] },
        tags: { type: 'array', items: { type: 'string' } },
      },
      required: ['name', 'tags'],
      additionalProperties: false,
    });
  });
});

describe('authorizeTool clearance enforcement', () => {
  it('denies tool use above the caller clearance', () => {
    const publicAuth = { ...auth, clearance: 'PUBLIC' as const };
    expect(() =>
      authorizeTool(publicAuth, 'syteline.getItem', { item: 'A', site: 'MAIN' }, 'CONFIDENTIAL', false)
    ).toThrowError(expect.objectContaining({ code: 'CLASSIFICATION_DENIED' }));
  });

  it('denies callers without the tool:use permission', () => {
    const noPermAuth = { ...auth, permissions: [] as Permission[] };
    expect(() =>
      authorizeTool(noPermAuth, 'syteline.getItem', { item: 'A', site: 'MAIN' }, 'PUBLIC', false)
    ).toThrowError(expect.objectContaining({ code: 'TOOL_FORBIDDEN' }));
  });
});

describe('runToolCall', () => {
  it('audits malformed JSON invocations instead of silently dropping them', async () => {
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{oops',
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_TOOL_ARGUMENTS' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TOOL_EXECUTION',
      success: false,
      reason: 'Tool arguments are not valid JSON',
    }));
    const toolExecColl = getMockCollection('tool_executions');
    expect(toolExecColl.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DENIED',
        authorizationDecision: 'DENIED',
        errorCode: 'INVALID_TOOL_ARGUMENTS',
      })
    );
  });

  it('audits denials with the request correlation ID', async () => {
    const result = await runToolCall({
      auth: { ...auth, permissions: [] as Permission[] },
      name: 'syteline.getItem',
      rawArguments: '{}',
      classification: 'INTERNAL',
      requestId: 'req-9',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'TOOL_FORBIDDEN' });
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: 'TOOL_EXECUTION',
      requestId: 'req-9',
      success: false,
    }));
    const toolExecColl = getMockCollection('tool_executions');
    expect(toolExecColl.insertOne).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'DENIED',
        authorizationDecision: 'DENIED',
      })
    );
  });

  it('truncates huge tool outputs and returns a structured marker, not partial JSON', async () => {
    sytelineTool.execute = vi.fn(async () => ({ blob: 'x'.repeat(20000) })) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.output!.length).toBeLessThanOrEqual(8000 + 100);
    expect(result.output).toContain('[truncated: tool output exceeded 8000 chars]');
    expect(result.truncated).toBe(true);
    // API consumers get an explicit marker, never truncated-then-reparsed JSON.
    expect(result.data).toEqual({ truncated: true, maxChars: 8000 });
    expect(() => JSON.parse(result.output!)).toThrow();
  });

  it('returns structured data (not a string) when the output fits', async () => {
    sytelineTool.execute = vi.fn(async () => ({ item: 'A', qty: 3 })) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(result.truncated).toBeUndefined();
    expect(result.data).toEqual({ item: 'A', qty: 3 });
  });

  it('audits successful calls with bounded result-size metadata (counts only)', async () => {
    sytelineTool.execute = vi.fn(async () => ({ item: 'A', qty: 3 })) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-size',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    const auditCall = recordAudit.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'TOOL_EXECUTION'
    );
    expect(auditCall).toBeDefined();
    const metadata = (auditCall![0] as { metadata: Record<string, unknown> }).metadata;
    expect(metadata.executionId).toBe('exec-1');
    expect(metadata.resultChars).toBe(JSON.stringify({ item: 'A', qty: 3 }).length);
    expect(metadata.truncated).toBe(false);
    // No result content in the audit trail.
    expect(JSON.stringify(metadata)).not.toContain('"qty"');
  });

  it('survives non-JSON-serializable tool output', async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    sytelineTool.execute = vi.fn(async () => circular) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(true);
    expect(typeof result.output).toBe('string');
  });

  it('aborts a hung tool via the internal per-tool timeout', async () => {
    const { config } = await import('../src/config.js');
    const originalTimeout = config.AI_TOOL_TIMEOUT_MS;
    config.AI_TOOL_TIMEOUT_MS = 50;
    try {
      sytelineTool.execute = vi.fn((_input: unknown, signal: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted by test signal')));
        })) as never;
      const result = await runToolCall({
        auth,
        name: 'syteline.getItem',
        rawArguments: '{"item":"A","site":"MAIN"}',
        classification: 'INTERNAL',
        requestId: 'req-1',
        signal: new AbortController().signal,
      });
      expect(result.ok).toBe(false);
      const toolExecColl = getMockCollection('tool_executions');
      expect(toolExecColl.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'exec-1' }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'FAILED' }) })
      );
    } finally {
      config.AI_TOOL_TIMEOUT_MS = originalTimeout;
    }
  });

  it('marks execution FAILED and audits on adapter errors', async () => {
    sytelineTool.execute = vi.fn(async () => {
      throw new Error('adapter exploded');
    }) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: new AbortController().signal,
    });
    expect(result).toMatchObject({ ok: false, errorCode: 'TOOL_EXECUTION_FAILED' });
    const toolExecColl = getMockCollection('tool_executions');
    expect(toolExecColl.updateOne).toHaveBeenCalledWith(
      expect.objectContaining({ _id: 'exec-1' }),
      expect.objectContaining({ $set: expect.objectContaining({ status: 'FAILED' }) })
    );
    expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({ action: 'TOOL_EXECUTION', success: false }));
  });
});

describe('tool timeout hardening', () => {
  it('rejects promptly when a non-cooperative adapter ignores the abort signal', async () => {
    const { config } = await import('../src/config.js');
    const originalTimeout = config.AI_TOOL_TIMEOUT_MS;
    config.AI_TOOL_TIMEOUT_MS = 50;
    try {
      let aborted = false;
      sytelineTool.execute = vi.fn((_input: unknown, _ctx: unknown, signal: AbortSignal) => {
        // The adapter registers on the signal but never settles: a timeout
        // that only aborts the signal would hang here forever.
        signal.addEventListener('abort', () => { aborted = true; });
        return new Promise<unknown>(() => {});
      }) as never;
      const started = Date.now();
      const result = await runToolCall({
        auth,
        name: 'syteline.getItem',
        rawArguments: '{"item":"A","site":"MAIN"}',
        classification: 'INTERNAL',
        requestId: 'req-timeout',
        signal: new AbortController().signal,
      });
      const elapsed = Date.now() - started;
      expect(result).toMatchObject({ ok: false, errorCode: 'TOOL_TIMEOUT' });
      // A hang would take forever; the guarded race rejects at the deadline.
      expect(elapsed).toBeLessThan(5000);
      expect(result.message).toBe('Tool execution failed');
      // The abort signal still fired for cooperative adapters.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(aborted).toBe(true);
      const toolExecColl = getMockCollection('tool_executions');
      expect(toolExecColl.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'exec-1' }),
        expect.objectContaining({ $set: expect.objectContaining({ status: 'FAILED' }) })
      );
      expect(recordAudit).toHaveBeenCalledWith(expect.objectContaining({
        action: 'TOOL_EXECUTION',
        success: false,
      }));
    } finally {
      config.AI_TOOL_TIMEOUT_MS = originalTimeout;
    }
  });
});

describe('tool exception leakage', () => {
  it('returns a generic client message and keeps only sanitized diagnostics server-side', async () => {
    sytelineTool.execute = vi.fn(async () => {
      throw new Error(
        'SyteLine upstream 500: connect https://admin:sup3rsecretpw@syteline.internal:8443 ' +
        'token=ZXhhbXBsZS1hcGkta2V5 payload={"item":"A"}'
      );
    }) as never;
    const result = await runToolCall({
      auth,
      name: 'syteline.getItem',
      rawArguments: '{"item":"A","site":"MAIN"}',
      classification: 'INTERNAL',
      requestId: 'req-leak',
      signal: new AbortController().signal,
    });
    expect(result.ok).toBe(false);
    // Clients (and direct-route consumers / model context) never see the raw
    // adapter exception.
    expect(result.message).toBe('Tool execution failed');
    expect(result.message).not.toContain('sup3rsecretpw');
    // Operator diagnostics stay server-side (tool_executions error_code +
    // audit reason) with credential-shaped material stripped by the audit
    // sanitizer patterns.
    const auditCall = recordAudit.mock.calls.find(
      (call) => (call[0] as { action: string }).action === 'TOOL_EXECUTION' && (call[0] as { success?: boolean }).success === false
    );
    expect(auditCall).toBeDefined();
    const reason = (auditCall![0] as { reason: string }).reason;
    expect(reason).not.toContain('sup3rsecretpw');
    expect(reason).not.toContain('ZXhhbXBsZS1hcGkta2V5');
    expect(reason).not.toContain('://admin:');
    expect(reason).toContain('[REDACTED]');
  });
});
