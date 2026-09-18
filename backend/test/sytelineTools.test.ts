/**
 * sytelineTools.test.ts — Phase 5a: the read-only SyteLine agentic tool
 * surface (docs/syteline-vision.md).
 *
 * Covers:
 *  1. Registry: the seven canonical tools are registered with the
 *     syteline:read permission gate.
 *  2. Authorization: a caller with tool:use but without syteline:read is
 *     denied in application code (structured TOOL_FORBIDDEN, never a
 *     throw out of runToolCall); a caller with syteline:read succeeds.
 *  3. Schema validation: malformed identifiers are rejected before any
 *     adapter call.
 *  4. Row capping: capResultList truncates to SYTELINE_MAX_ROWS with a
 *     `truncated` marker.
 *  5. Fixture consistency: every syteline eval case's expected tool chain
 *     replays cleanly against the mock fixture, and every record ID the
 *     case cites exists in the fixture outputs — the deterministic
 *     "zero invented records" check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const { tenantQuery } = vi.hoisted(() => ({ tenantQuery: vi.fn() }));
const { recordAudit } = vi.hoisted(() => ({ recordAudit: vi.fn() }));
vi.mock('../src/db/pool.js', () => ({ tenantQuery }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));

import { authorizeTool, runToolCall, toolRegistry } from '../src/tools/gateway.js';
import { capResultList, HttpSyteLineAdapter } from '../src/tools/syteline.js';
import { MockSyteLineAdapter } from '../src/tools/sytelineFixture.js';
import { overrideSyteLineAdapter } from '../src/tools/syteline.js';
import { SYTELINE_DIAG_CASES } from '../src/eval/cases/syteline.js';
import { authFor, TENANT_A, USER_A1 } from './helpers/securityFixtures.js';
import type { Permission } from '../src/authz/permissions.js';

const SYTELINE_TOOLS = [
  'syteline.getItem',
  'syteline.getSalesOrder',
  'syteline.getItemAvailability',
  'syteline.getOpenPurchaseOrders',
  'syteline.getWorkOrders',
  'syteline.getBom',
  'syteline.getCustomer',
];

function mockToolExecutions() {
  tenantQuery.mockImplementation(async (_tenantId: string, sql: string) => {
    if (sql.includes('INSERT INTO tool_executions')) return { rows: [{ id: 'exec-1' }] };
    if (sql.includes('UPDATE tool_executions')) return { rows: [] };
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  });
}

const authWithSyteLine = () =>
  authFor(USER_A1, TENANT_A, {
    permissions: ['tool:use', 'syteline:read'] as Permission[],
  });

const authWithoutSyteLine = () =>
  authFor(USER_A1, TENANT_A, {
    permissions: ['tool:use'] as Permission[],
  });

afterEach(() => {
  overrideSyteLineAdapter(new HttpSyteLineAdapter());
  vi.clearAllMocks();
});

describe('syteline tool registry', () => {
  it('registers the seven canonical read-only tools', () => {
    for (const name of SYTELINE_TOOLS) {
      const tool = toolRegistry.find((t) => t.name === name);
      expect(tool, name).toBeDefined();
      expect(tool!.destructive).toBe(false);
      expect(tool!.permission).toBe('syteline:read');
    }
  });

  it('every tool named by the syteline eval corpus is registered (corpus/registry drift guard)', () => {
    const registered = new Set(toolRegistry.map((t) => t.name));
    for (const c of SYTELINE_DIAG_CASES) {
      for (const tool of c.tools ?? []) {
        expect(registered.has(tool.name), `${c.id} uses ${tool.name}`).toBe(true);
      }
      for (const name of c.judge.expectedToolChain ?? []) {
        expect(registered.has(name), `${c.id} chain uses ${name}`).toBe(true);
      }
      const mock = c.mockResponse;
      if (mock && typeof mock !== 'string') {
        for (const call of mock.toolCalls) {
          expect(registered.has(call.name), `${c.id} mock calls ${call.name}`).toBe(true);
        }
      }
    }
  });
});

describe('syteline authorization', () => {
  it('denies a caller with tool:use but without syteline:read', async () => {
    mockToolExecutions();
    overrideSyteLineAdapter(new MockSyteLineAdapter());
    const result = await runToolCall({
      auth: authWithoutSyteLine(),
      name: 'syteline.getSalesOrder',
      rawArguments: JSON.stringify({ orderNumber: 'SO-66012' }),
      classification: 'INTERNAL',
      requestId: 'req-1',
      signal: AbortSignal.timeout(5000),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('TOOL_FORBIDDEN');
    // The denial is audited even though nothing executed.
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TOOL_EXECUTION', tool: 'syteline.getSalesOrder', success: false })
    );
  });

  it('authorizes a caller with syteline:read and runs the tool', async () => {
    mockToolExecutions();
    overrideSyteLineAdapter(new MockSyteLineAdapter());
    const result = await runToolCall({
      auth: authWithSyteLine(),
      name: 'syteline.getSalesOrder',
      rawArguments: JSON.stringify({ orderNumber: 'SO-66012' }),
      classification: 'INTERNAL',
      requestId: 'req-2',
      signal: AbortSignal.timeout(5000),
    });
    expect(result.ok).toBe(true);
    const data = result.data as { orderNumber: string; lines: Array<{ item: string }> };
    expect(data.orderNumber).toBe('SO-66012');
    expect(data.lines).toHaveLength(3);
    expect(data.lines[1]!.item).toBe('ITEM-77100');
    expect(recordAudit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'TOOL_EXECUTION', tool: 'syteline.getSalesOrder' })
    );
    // The success audit omits `success` (it defaults true); it must not be recorded as a failure.
    const auditArg = (recordAudit as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { success?: boolean };
    expect(auditArg.success ?? true).toBe(true);
  });

  it('authorizeTool throws TOOL_FORBIDDEN synchronously for the direct path', () => {
    expect(() =>
      authorizeTool(authWithoutSyteLine(), 'syteline.getItemAvailability', { item: 'ITEM-77100', site: 'FTW' }, 'INTERNAL', false)
    ).toThrowError(expect.objectContaining({ code: 'TOOL_FORBIDDEN' }));
  });
});

describe('syteline schema validation', () => {
  it('rejects identifier-shaped injection attempts before any adapter call', async () => {
    mockToolExecutions();
    overrideSyteLineAdapter(new MockSyteLineAdapter());
    const result = await runToolCall({
      auth: authWithSyteLine(),
      name: 'syteline.getItemAvailability',
      rawArguments: JSON.stringify({ item: "ITEM-77100'; DROP TABLE--", site: 'FTW' }),
      classification: 'INTERNAL',
      requestId: 'req-3',
      signal: AbortSignal.timeout(5000),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('INVALID_TOOL_PARAMETERS');
  });

  it('requires orderNumber or customerNumber for getSalesOrder', async () => {
    mockToolExecutions();
    overrideSyteLineAdapter(new MockSyteLineAdapter());
    const result = await runToolCall({
      auth: authWithSyteLine(),
      name: 'syteline.getSalesOrder',
      rawArguments: JSON.stringify({ site: 'FTW' }),
      classification: 'INTERNAL',
      requestId: 'req-4',
      signal: AbortSignal.timeout(5000),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_REQUIRED_PARAMETER');
  });

  it('requires workOrderNumber or item for getWorkOrders', async () => {
    mockToolExecutions();
    overrideSyteLineAdapter(new MockSyteLineAdapter());
    const result = await runToolCall({
      auth: authWithSyteLine(),
      name: 'syteline.getWorkOrders',
      rawArguments: JSON.stringify({ site: 'FTW' }),
      classification: 'INTERNAL',
      requestId: 'req-5',
      signal: AbortSignal.timeout(5000),
    });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('MISSING_REQUIRED_PARAMETER');
  });
});

describe('syteline result capping', () => {
  it('capResultList passes short lists through untouched', () => {
    const { list, truncated } = capResultList([1, 2, 3]);
    expect(list).toEqual([1, 2, 3]);
    expect(truncated).toBe(false);
  });

  it('capResultList truncates to SYTELINE_MAX_ROWS with a marker', async () => {
    const { config } = await import('../src/config.js');
    const big = Array.from({ length: config.SYTELINE_MAX_ROWS + 25 }, (_, i) => i);
    const { list, truncated } = capResultList(big);
    expect(list).toHaveLength(config.SYTELINE_MAX_ROWS);
    expect(truncated).toBe(true);
  });

  it('capResultList treats non-arrays as empty', () => {
    expect(capResultList(undefined)).toEqual({ list: [], truncated: false });
  });
});

describe('syteline fixture consistency with the eval corpus', () => {
  const fixture = new MockSyteLineAdapter();
  const signal = AbortSignal.timeout(5000);

  async function replay(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'syteline.getItem':
        return fixture.getItem(args as { item: string; site: string }, signal);
      case 'syteline.getSalesOrder':
        return fixture.getSalesOrder(args as { orderNumber?: string; customerNumber?: string; site?: string; status?: string }, signal);
      case 'syteline.getItemAvailability':
        return fixture.getItemAvailability(args as { item: string; site: string }, signal);
      case 'syteline.getOpenPurchaseOrders':
        return fixture.getOpenPurchaseOrders(args as { item: string; site?: string }, signal);
      case 'syteline.getWorkOrders':
        return fixture.getWorkOrders(
          args as { workOrderNumber?: string; item?: string; site?: string; status?: string },
          signal
        );
      case 'syteline.getBom':
        return fixture.getBom(args as { item: string; site?: string; levels?: number }, signal);
      case 'syteline.getCustomer':
        return fixture.getCustomer(args as { customerNumber: string }, signal);
      default:
        throw new Error(`no fixture mapping for tool ${name}`);
    }
  }

  it('every case replays its expected tool chain against the fixture without errors', async () => {
    for (const c of SYTELINE_DIAG_CASES) {
      const mock = c.mockResponse;
      expect(mock && typeof mock !== 'string', `${c.id} has scripted tool calls`).toBe(true);
      if (!mock || typeof mock === 'string') continue;
      for (const call of mock.toolCalls) {
        await expect(replay(call.name, call.args as Record<string, unknown>), `${c.id}: ${call.name}`).resolves.toBeDefined();
      }
    }
  });

  it('every record ID a case cites exists in the fixture outputs (zero invented records)', async () => {
    const idPattern = /\b(?:SO|PO|WO|ITEM|FG|COMP|CONT)-\d+\b/g;
    for (const c of SYTELINE_DIAG_CASES) {
      const mock = c.mockResponse;
      if (!mock || typeof mock === 'string') continue;
      const outputs: unknown[] = [];
      for (const call of mock.toolCalls) {
        outputs.push(await replay(call.name, call.args as Record<string, unknown>));
      }
      const rendered = JSON.stringify(outputs);
      const cited = new Set<string>();
      for (const expected of c.judge.expectedSubstrings ?? []) {
        for (const match of expected.matchAll(idPattern)) cited.add(match[0]);
      }
      expect(cited.size, `${c.id} cites record IDs`).toBeGreaterThan(0);
      for (const id of cited) {
        expect(rendered.includes(id), `${c.id} cites ${id}, which must exist in fixture outputs`).toBe(true);
      }
    }
  });

  it('the late-order fixture numbers match the corpus assertions', async () => {
    const availability = await fixture.getItemAvailability({ item: 'ITEM-77100', site: 'FTW' }, signal);
    expect(availability.available).toBe(180);
    const pos = await fixture.getOpenPurchaseOrders({ item: 'ITEM-77100' }, signal);
    expect(pos.purchaseOrders[0]!.poNumber).toBe('PO-4488');
    expect(pos.purchaseOrders[0]!.quantityReceived).toBe(0);
    const bom = await fixture.getBom({ item: 'FG-9000' }, signal);
    const pinion = bom.components.find((c) => c.item === 'COMP-2200')!;
    expect(pinion.quantityPer).toBe(4);
    const compAvail = await fixture.getItemAvailability({ item: 'COMP-2200', site: 'FTW' }, signal);
    // 400 needed for 100 FG-9000, 60 available → 340 short, builds capped at 15.
    expect(400 - compAvail.available).toBe(340);
    expect(Math.floor(compAvail.available / pinion.quantityPer)).toBe(15);
  });
});
