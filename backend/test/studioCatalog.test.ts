/**
 * studioCatalog.test.ts — the typed action catalog.
 *
 * - the 7 real read actions are bound to real operations and non-destructive
 * - the 4 write actions are flagged destructive and honestly unsupported
 * - availability evaluation: ok → supported; unsupported/error/unprobed → false with reasons
 * - param schemas validate like the agentic tools (same identifier rules)
 *
 * VALIDATED IN CI. No live upstream.
 */
import { describe, expect, it } from 'vitest';
import {
  ACTION_CATALOG,
  evaluateAvailability,
  getCatalogAction,
  listCatalog,
  toCatalogView,
} from '../src/studio/catalog/catalog.js';
import type { CapabilityProbeStatus } from '../src/studio/types.js';

const READ_IDS = [
  'syteline.getItem',
  'syteline.getSalesOrder',
  'syteline.getItemAvailability',
  'syteline.getOpenPurchaseOrders',
  'syteline.getWorkOrders',
  'syteline.getBom',
  'syteline.getCustomer',
];

const WRITE_IDS = [
  'syteline.record.create',
  'syteline.record.update',
  'syteline.record.delete',
  'syteline.ido.invoke',
];

function probed(id: string, status: CapabilityProbeStatus['status']): CapabilityProbeStatus {
  return {
    operationId: id,
    probedMethod: 'GET',
    probedPath: '/api/x',
    status,
    httpStatus: status === 'ok' ? 200 : 404,
    probedAt: new Date().toISOString(),
  };
}

describe('ACTION_CATALOG', () => {
  it('contains exactly the 7 real read actions plus the 4 deferred write actions', () => {
    const ids = ACTION_CATALOG.map((a) => a.id);
    expect(ids).toEqual(expect.arrayContaining([...READ_IDS, ...WRITE_IDS]));
    expect(ids).toHaveLength(11);
    // No duplicates.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('read actions are real, non-destructive, GET-bound, studio:run-gated', () => {
    for (const id of READ_IDS) {
      const entry = getCatalogAction(id)!;
      expect(entry).toBeDefined();
      expect(entry.knownReal).toBe(true);
      expect(entry.destructive).toBe(false);
      expect(entry.requiredPermission).toBe('studio:run');
      expect(entry.operation?.method).toBe('GET');
      expect(entry.substrate).toBe('api');
    }
  });

  it('write actions are flagged destructive and honestly unsupported', () => {
    for (const id of WRITE_IDS) {
      const entry = getCatalogAction(id)!;
      expect(entry.destructive).toBe(true);
      expect(entry.knownReal).toBe(false);
      expect(entry.unsupportedReason).toMatch(/pending upstream support/);
    }
    const views = listCatalog();
    for (const id of WRITE_IDS) {
      const view = views.find((v) => v.id === id)!;
      expect(view.supported).toBe(false);
      expect(view.supportReason).toMatch(/pending upstream support/);
    }
  });
});

describe('evaluateAvailability', () => {
  const read = getCatalogAction('syteline.getItem')!;

  it('supports a read action only after a successful probe', () => {
    expect(evaluateAvailability(read, [probed('syteline.getItem', 'ok')]).supported).toBe(true);
    expect(evaluateAvailability(read, [probed('syteline.getItem', 'unsupported')]).supported).toBe(false);
    expect(evaluateAvailability(read, [probed('syteline.getItem', 'error')]).supported).toBe(false);
  });

  it('tells the operator to test the connection when nothing was probed', () => {
    const { supported, supportReason } = evaluateAvailability(read, undefined);
    expect(supported).toBe(false);
    expect(supportReason).toMatch(/test the connection/i);
  });

  it('never reports a non-real action as supported, even with an ok probe', () => {
    const write = getCatalogAction('syteline.record.create')!;
    const { supported } = evaluateAvailability(write, [probed('syteline.record.create', 'ok')]);
    expect(supported).toBe(false);
  });

  it('catalog views expose operation bindings and param shapes', () => {
    const view = toCatalogView(read, [probed('syteline.getItem', 'ok')]);
    expect(view.operation).toEqual({ method: 'GET', path: '/api/items' });
    expect(view.supported).toBe(true);
    const schema = view.paramsJsonSchema as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['item', 'site']));
    expect(schema.required).toEqual(expect.arrayContaining(['item', 'site']));
  });
});

describe('param schemas', () => {
  it('validates identifiers like the agentic tools', () => {
    const entry = getCatalogAction('syteline.getItem')!;
    expect(entry.paramsSchema.safeParse({ item: 'WIDGET-1', site: 'MAIN' }).success).toBe(true);
    expect(entry.paramsSchema.safeParse({ item: '', site: 'MAIN' }).success).toBe(false);
    expect(entry.paramsSchema.safeParse({ item: 'a/b; DROP TABLE x', site: 'MAIN' }).success).toBe(false);
    expect(entry.paramsSchema.safeParse({ site: 'MAIN' }).success).toBe(false);
  });

  it('requires orderNumber or customerNumber for sales orders', () => {
    const entry = getCatalogAction('syteline.getSalesOrder')!;
    expect(entry.paramsSchema.safeParse({ site: 'MAIN' }).success).toBe(false);
    expect(entry.paramsSchema.safeParse({ orderNumber: 'SO-1' }).success).toBe(true);
    expect(entry.paramsSchema.safeParse({ customerNumber: 'C-1' }).success).toBe(true);
  });

  it('bounds BOM explosion depth', () => {
    const entry = getCatalogAction('syteline.getBom')!;
    expect(entry.paramsSchema.safeParse({ item: 'A', levels: 99 }).success).toBe(false);
    expect(entry.paramsSchema.safeParse({ item: 'A', levels: 5 }).success).toBe(true);
  });
});
