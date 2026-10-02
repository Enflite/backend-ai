/**
 * apsTools.test.ts — the APS exception-resolution tool substrate.
 *
 * - registry shape: unique names matching the family convention, a
 *   permission on every tool, all registered in toolRegistry
 * - aps.normalizeExceptionRows: header alias mapping incl. weird headers,
 *   empty-row drop, 200-issue cap
 * - aps.parseExceptionReport: xlsx parse via a workbook built in-memory;
 *   DOCUMENT_NOT_FOUND / UNSUPPORTED_DOCUMENT_TYPE
 * - aps.collectSupplyFacts: adapter evidence mapping, per-row failure
 *   captured without failing the batch
 * - aps.compareSnapshots: resolved true/false via composite-key matching
 * - aps.closeIssue: resolved=false is a fall-through-safe no-op (status
 *   unchanged)
 * - aps.recordSnapshot: new issue vs append-to-open issue
 *
 * The DB is an in-memory stand-in (vi.mock pattern from
 * flowsRunner.test.ts); the SyteLine adapter is the test-only
 * overrideSyteLineAdapter seam; object storage is mocked.
 * VALIDATED IN CI; live SyteLine / Mongo / S3 REQUIRE REAL INFRA.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { storageGetMock } = vi.hoisted(() => ({ storageGetMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/storage/storage.js', () => ({ s3Storage: { get: storageGetMock } }));

import { toolRegistry } from '../src/tools/gateway.js';
import { apsToolDefinitions } from '../src/aps/apsTools.js';
import { HttpSyteLineAdapter, type SyteLineAdapter } from '../src/tools/syteline.js';
import { overrideSyteLineAdapter } from '../src/tools/syteline.js';
import { authFor, TENANT_A, TENANT_B, USER_A1 } from './helpers/securityFixtures.js';
import type { Permission } from '../src/authz/permissions.js';

// ---------------------------------------------------------------------------
// In-memory DB stand-in
// ---------------------------------------------------------------------------

function matchesFilter(doc: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(filter)) {
    const docValue = doc[key];
    if (value !== null && typeof value === 'object' && '$ne' in (value as object)) {
      if (docValue === (value as { $ne: unknown }).$ne) return false;
      continue;
    }
    // null in the filter matches missing/null (soft-delete convention)
    if (value === null) {
      if (docValue !== null && docValue !== undefined) return false;
      continue;
    }
    if (docValue !== value) return false;
  }
  return true;
}

function applyUpdate(doc: Record<string, unknown>, update: Record<string, unknown>): void {
  const set = (update.$set ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(set)) {
    const parts = key.split('.');
    let target = doc;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i];
      if (part === undefined) continue;
      const existing = target[part];
      if (existing === null || typeof existing !== 'object') target[part] = {};
      target = target[part] as Record<string, unknown>;
    }
    const last = parts[parts.length - 1];
    if (last !== undefined) target[last] = value;
  }
  const push = (update.$push ?? {}) as Record<string, unknown>;
  for (const [key, value] of Object.entries(push)) {
    const list = doc[key];
    if (Array.isArray(list)) list.push(value);
    else doc[key] = [value];
  }
  const inc = (update.$inc ?? {}) as Record<string, number>;
  for (const [key, value] of Object.entries(inc)) {
    doc[key] = (typeof doc[key] === 'number' ? (doc[key] as number) : 0) + value;
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function makeCollection() {
  const docs = new Map<string, Record<string, unknown>>();
  return {
    docs,
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) return clone(doc);
      }
      return null;
    }),
    insertOne: vi.fn(async (doc: Record<string, unknown>) => {
      docs.set(String(doc._id), clone(doc));
      return { acknowledged: true, insertedId: doc._id };
    }),
    updateOne: vi.fn(async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
      for (const doc of docs.values()) {
        if (matchesFilter(doc, filter)) {
          applyUpdate(doc, update);
          return { acknowledged: true, matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { acknowledged: true, matchedCount: 0, modifiedCount: 0 };
    }),
  };
}

const collections: Record<string, ReturnType<typeof makeCollection>> = {};

function dbFor() {
  return {
    collection: (name: string) => {
      if (!collections[name]) collections[name] = makeCollection();
      return collections[name];
    },
  };
}

const toolOf = (name: string) => apsToolDefinitions.find((t) => t.name === name)!;

const ctxFor = (permissions: Permission[] = ['document:read', 'tool:use', 'syteline:read']) => ({
  auth: authFor(USER_A1, TENANT_A, { permissions }),
  classification: 'CONFIDENTIAL' as const,
});

const SIGNAL = AbortSignal.timeout(10000);

const fakeAdapter: SyteLineAdapter = {
  async getItemAvailability({ item, site }: { item: string; site: string }) {
    if (item === 'BROKEN-ITEM') throw new Error('adapter exploded');
    return { item, site, onHand: 5, allocated: 0, available: 5 };
  },
  async getOpenPurchaseOrders({ item, site }: { item: string; site?: string }) {
    return {
      item,
      site,
      purchaseOrders: [
        {
          poNumber: 'PO-1',
          item,
          quantityOrdered: 10,
          quantityReceived: 0,
          promisedDate: '2026-12-01',
          status: 'open',
        },
      ],
    };
  },
  async getSalesOrder(input: { orderNumber?: string; customerNumber?: string }) {
    return { orderNumber: input.orderNumber ?? 'SO-OPEN', status: 'Open', lines: [] };
  },
  async getWorkOrders() {
    return { workOrders: [] };
  },
  async getItem() {
    return {};
  },
  async getBom() {
    return { components: [] };
  },
  async getCustomer() {
    return {};
  },
} as unknown as SyteLineAdapter;

beforeEach(() => {
  for (const key of Object.keys(collections)) delete collections[key];
  getDbMock.mockImplementation(async () => dbFor());
  storageGetMock.mockReset();
  overrideSyteLineAdapter(fakeAdapter);
});

afterEach(() => {
  overrideSyteLineAdapter(new HttpSyteLineAdapter());
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Registry shape
// ---------------------------------------------------------------------------

describe('aps tool registry', () => {
  const NAME_RE = /^[a-z][a-z0-9]*\.[a-z][a-zA-Z0-9]*$/;

  it('has unique names matching the family naming convention, each with a permission', () => {
    const names = apsToolDefinitions.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const tool of apsToolDefinitions) {
      expect(tool.name, 'name convention').toMatch(NAME_RE);
      expect(tool.permission, `${tool.name} permission`).toBeDefined();
      expect(tool.destructive, `${tool.name} destructive`).toBe(false);
    }
  });

  it('registers all ten APS tools in the gateway toolRegistry', () => {
    const expected = [
      'aps.parseExceptionReport',
      'aps.normalizeExceptionRows',
      'aps.collectSupplyFacts',
      'aps.collectDemandFacts',
      'aps.evaluateDueDates',
      'aps.applyRules',
      'aps.recordSnapshot',
      'aps.compareSnapshots',
      'aps.closeIssue',
      'aps.getIssue',
    ];
    expect(apsToolDefinitions).toHaveLength(10);
    for (const name of expected) {
      const inRegistry = toolRegistry.find((t) => t.name === name);
      expect(inRegistry, `${name} registered`).toBeDefined();
    }
  });

  it('uses document:read only for the report parse; syteline:read for the rest', () => {
    expect(toolOf('aps.parseExceptionReport').permission).toBe('document:read');
    for (const tool of apsToolDefinitions) {
      if (tool.name === 'aps.parseExceptionReport') continue;
      expect(tool.permission, tool.name).toBe('syteline:read');
    }
  });

  it('gives the supply collector a 300s execution budget', () => {
    expect(toolOf('aps.collectSupplyFacts').timeoutMs).toBe(300000);
  });
});

// ---------------------------------------------------------------------------
// aps.normalizeExceptionRows
// ---------------------------------------------------------------------------

describe('aps.normalizeExceptionRows', () => {
  const normalize = toolOf('aps.normalizeExceptionRows');

  it('maps weird headers to normalized fields', async () => {
    const output = (await normalize.execute(
      {
        rows: [
          {
            'Item#': 'WIDGET-1',
            'Order No': 'SO-100',
            'DATE DUE': '10/15/2026',
            Qty: '25',
            'Exception Message': 'Past due line',
            'Unrelated Column': 'ignored',
          },
        ],
      },
      ctxFor(),
      SIGNAL,
    )) as { issues: Record<string, unknown>[]; truncated: boolean };
    expect(output.truncated).toBe(false);
    expect(output.issues).toHaveLength(1);
    expect(output.issues[0]).toMatchObject({
      item: 'WIDGET-1',
      orderNumber: 'SO-100',
      dueDate: '2026-10-15',
      quantity: 25,
      exceptionText: 'Past due line',
    });
    expect(output.issues[0]).not.toHaveProperty('Unrelated Column');
  });

  it('maps the documented alias set', async () => {
    const output = (await normalize.execute(
      {
        rows: [
          {
            part_number: 'P-1',
            order_number: 'SO-2',
            customer_no: 'C-3',
            wo: 'WO-4',
            due: '2026-01-05',
            quantity: 7,
            message: 'm',
          },
        ],
      },
      ctxFor(),
      SIGNAL,
    )) as { issues: Record<string, unknown>[]; truncated: boolean };
    expect(output.issues[0]).toMatchObject({
      item: 'P-1',
      orderNumber: 'SO-2',
      customerNumber: 'C-3',
      workOrderNumber: 'WO-4',
      dueDate: '2026-01-05',
      quantity: 7,
      exceptionText: 'm',
    });
  });

  it('drops fully-empty rows and keeps rowIndex aligned to the issues array', async () => {
    const output = (await normalize.execute(
      {
        rows: [{}, { item: '  ' }, { item: 'A-1' }, null, { item: 'B-2' }],
      },
      ctxFor(),
      SIGNAL,
    )) as { issues: Record<string, unknown>[]; truncated: boolean };
    expect(output.issues.map((i) => i.item)).toEqual(['A-1', 'B-2']);
    expect(output.issues.map((i) => i.rowIndex)).toEqual([0, 1]);
  });

  it('caps at 200 issues with truncated=true', async () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ item: `ITEM-${i}` }));
    const output = (await normalize.execute({ rows }, ctxFor(), SIGNAL)) as {
      issues: unknown[];
      truncated: boolean;
    };
    expect(output.issues).toHaveLength(200);
    expect(output.truncated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// aps.parseExceptionReport
// ---------------------------------------------------------------------------

describe('aps.parseExceptionReport', () => {
  const parse = toolOf('aps.parseExceptionReport');

  async function seedWorkbook(docId: string, seedRows: unknown[][]) {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Exceptions');
    for (const row of seedRows) sheet.addRow(row as unknown[]);
    const buffer = await workbook.xlsx.writeBuffer();
    const documents = collections.documents ?? dbFor().collection('documents');
    await documents.insertOne({
      _id: docId,
      tenantId: TENANT_A,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      objectKey: 'tenant-a/doc-1',
      classification: 'CONFIDENTIAL',
      deletedAt: null,
    });
    storageGetMock.mockResolvedValue(new Uint8Array(buffer as unknown as ArrayBuffer));
  }

  it('parses the first sheet into columns and row objects', async () => {
    await seedWorkbook('doc-1', [
      ['Item Number', 'Order No', 'Qty'],
      ['WIDGET-1', 'SO-100', 10],
      ['WIDGET-2', 'SO-101', 5],
    ]);
    const output = (await parse.execute({ documentId: 'doc-1' }, ctxFor(), SIGNAL)) as {
      sheetName: string;
      columns: string[];
      rows: Record<string, unknown>[];
      rowCount: number;
    };
    expect(output.sheetName).toBe('Exceptions');
    expect(output.columns).toEqual(['Item Number', 'Order No', 'Qty']);
    expect(output.rowCount).toBe(2);
    expect(output.rows[0]).toMatchObject({ 'Item Number': 'WIDGET-1', 'Order No': 'SO-100', Qty: 10 });
  });

  it('rejects a missing document with DOCUMENT_NOT_FOUND', async () => {
    await expect(parse.execute({ documentId: 'nope' }, ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });

  it('rejects a non-xlsx document with UNSUPPORTED_DOCUMENT_TYPE', async () => {
    const documents = dbFor().collection('documents');
    await documents.insertOne({
      _id: 'doc-pdf',
      tenantId: TENANT_A,
      mimeType: 'application/pdf',
      objectKey: 'tenant-a/doc-pdf',
      classification: 'CONFIDENTIAL',
      deletedAt: null,
    });
    await expect(parse.execute({ documentId: 'doc-pdf' }, ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'UNSUPPORTED_DOCUMENT_TYPE',
    });
  });

  it('does not leak another tenant\'s document', async () => {
    const documents = dbFor().collection('documents');
    await documents.insertOne({
      _id: 'doc-other',
      tenantId: TENANT_B,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      objectKey: 'tenant-b/doc-other',
      classification: 'CONFIDENTIAL',
      deletedAt: null,
    });
    await expect(parse.execute({ documentId: 'doc-other' }, ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'DOCUMENT_NOT_FOUND',
    });
  });

  it('denies a document classified above the caller clearance with CLASSIFICATION_DENIED', async () => {
    const documents = dbFor().collection('documents');
    await documents.insertOne({
      _id: 'doc-secret',
      tenantId: TENANT_A,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      objectKey: 'tenant-a/doc-secret',
      classification: 'PROPRIETARY',
      deletedAt: null,
    });
    // ctxFor() runs at CONFIDENTIAL clearance: PROPRIETARY must fail closed.
    await expect(parse.execute({ documentId: 'doc-secret' }, ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'CLASSIFICATION_DENIED',
    });
  });
});

// ---------------------------------------------------------------------------
// aps.collectSupplyFacts
// ---------------------------------------------------------------------------

describe('aps.collectSupplyFacts', () => {
  const collect = toolOf('aps.collectSupplyFacts');

  it('collects availability and open POs per item row', async () => {
    const output = (await collect.execute(
      {
        issues: [
          { rowIndex: 0, item: 'WIDGET-1', orderNumber: 'SO-100' },
          { rowIndex: 1, item: 'WIDGET-2' },
        ],
        site: 'MAIN',
      },
      ctxFor(),
      SIGNAL,
    )) as { facts: Record<string, unknown>[] };
    expect(output.facts).toHaveLength(2);
    expect(output.facts[0]).toMatchObject({
      rowIndex: 0,
      item: 'WIDGET-1',
      availability: { onHand: 5, available: 5 },
    });
    expect((output.facts[0]!.openPOs as unknown[])).toHaveLength(1);
    expect(output.facts[1]!.rowIndex).toBe(1);
  });

  it('captures a per-row adapter failure without failing the batch', async () => {
    const output = (await collect.execute(
      {
        issues: [{ rowIndex: 0, item: 'WIDGET-1' }, { rowIndex: 1, item: 'BROKEN-ITEM' }],
        site: 'MAIN',
      },
      ctxFor(),
      SIGNAL,
    )) as { facts: Record<string, unknown>[] };
    expect(output.facts).toHaveLength(2);
    expect(output.facts[0]).not.toHaveProperty('error');
    expect(output.facts[1]).toMatchObject({ rowIndex: 1, item: 'BROKEN-ITEM' });
    expect(output.facts[1]!.error).toBeTruthy();
  });

  it('emits a bare fact for rows without an item', async () => {
    const output = (await collect.execute(
      { issues: [{ rowIndex: 3, orderNumber: 'SO-9' }], site: 'MAIN' },
      ctxFor(),
      SIGNAL,
    )) as { facts: Record<string, unknown>[] };
    expect(output.facts).toEqual([{ rowIndex: 3 }]);
  });
});

// ---------------------------------------------------------------------------
// aps.collectDemandFacts / aps.evaluateDueDates / aps.applyRules
// ---------------------------------------------------------------------------

describe('demand, due-date, and rules tools', () => {
  it('aps.collectDemandFacts looks up by orderNumber, then customerNumber', async () => {
    const collect = toolOf('aps.collectDemandFacts');
    const output = (await collect.execute(
      {
        issues: [
          { rowIndex: 0, orderNumber: 'SO-100' },
          { rowIndex: 1, customerNumber: 'CUST-7' },
          { rowIndex: 2, item: 'WIDGET-1' },
        ],
        site: 'MAIN',
      },
      ctxFor(),
      SIGNAL,
    )) as { facts: Record<string, unknown>[] };
    expect(output.facts[0]).toMatchObject({ rowIndex: 0, orderNumber: 'SO-100' });
    expect(output.facts[0]!.salesOrder).toBeDefined();
    expect(output.facts[1]).toMatchObject({ rowIndex: 1, customerNumber: 'CUST-7' });
    expect(output.facts[2]).toMatchObject({ rowIndex: 2, note: 'no-order-reference' });
  });

  it('aps.evaluateDueDates returns work orders and notes rows without references', async () => {
    const evaluate = toolOf('aps.evaluateDueDates');
    const output = (await evaluate.execute(
      {
        issues: [{ rowIndex: 0, workOrderNumber: 'WO-9' }, { rowIndex: 1, orderNumber: 'SO-1' }],
        site: 'MAIN',
      },
      ctxFor(),
      SIGNAL,
    )) as { facts: Record<string, unknown>[] };
    expect(output.facts[0]).toMatchObject({ rowIndex: 0, workOrders: [] });
    expect(output.facts[1]).toMatchObject({ rowIndex: 1, note: 'no-work-order-or-item-reference' });
  });

  it('aps.applyRules delegates to the deterministic engine with a fixed asOfDate', async () => {
    const apply = toolOf('aps.applyRules');
    const output = (await apply.execute(
      {
        issues: [{ rowIndex: 0, item: 'WIDGET-1', orderNumber: 'SO-100', dueDate: '2026-09-01', quantity: 10 }],
        supplyFacts: [{ rowIndex: 0, item: 'WIDGET-1', availability: { onHand: 1, allocated: 0, available: 1 }, openPOs: [] }],
        demandFacts: [{ rowIndex: 0, orderNumber: 'SO-100', salesOrder: { status: 'Open' } }],
        dueDateFacts: [],
        asOfDate: '2026-10-02',
      },
      ctxFor(),
      SIGNAL,
    )) as { findings: { ruleCode: string; severity: string }[] };
    const codes = output.findings.map((f) => f.ruleCode);
    expect(codes).toContain('PAST_DUE_OPEN_ORDER');
    expect(codes).toContain('MATERIAL_SHORTAGE');
  });
});

// ---------------------------------------------------------------------------
// aps.recordSnapshot / aps.compareSnapshots / aps.closeIssue / aps.getIssue
// ---------------------------------------------------------------------------

describe('issue snapshot lifecycle', () => {
  const record = toolOf('aps.recordSnapshot');
  const compare = toolOf('aps.compareSnapshots');
  const close = toolOf('aps.closeIssue');
  const get = toolOf('aps.getIssue');

  const snapshotInput = (issueId: string, issues: unknown[]) => ({
    issueId,
    reportDocumentId: 'doc-1',
    site: 'MAIN',
    issues,
    findings: [{ ruleCode: 'MATERIAL_SHORTAGE' }],
  });

  const baseline = [
    { item: 'WIDGET-1', orderNumber: 'SO-100', workOrderNumber: 'WO-1', dueDate: '2026-09-01' },
    { item: 'WIDGET-2', orderNumber: 'SO-101', dueDate: '2026-09-02' },
  ];

  it('recordSnapshot creates a new issue when issueId is empty', async () => {
    const output = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as {
      issueId: string;
      snapshotId: string;
      summary: { issueCount: number; snapshotCount: number; findingCount: number };
    };
    expect(output.issueId).toBeTruthy();
    expect(output.snapshotId).toBeTruthy();
    expect(output.summary).toMatchObject({ issueCount: 2, snapshotCount: 1, findingCount: 1 });
  });

  it('recordSnapshot appends to an existing open issue', async () => {
    const first = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    const second = (await record.execute(
      snapshotInput(first.issueId, [{ item: 'WIDGET-3' }]),
      ctxFor(),
      SIGNAL,
    )) as { issueId: string; summary: { snapshotCount: number } };
    expect(second.issueId).toBe(first.issueId);
    expect(second.summary.snapshotCount).toBe(2);

    const fetched = (await get.execute({ issueId: first.issueId }, ctxFor(), SIGNAL)) as {
      status: string;
      snapshotCount: number;
      latestSnapshot: { issues: unknown[] } | null;
    };
    expect(fetched.status).toBe('open');
    expect(fetched.snapshotCount).toBe(2);
    expect(fetched.latestSnapshot?.issues).toHaveLength(1);
  });

  it('recordSnapshot rejects unknown and closed issues', async () => {
    await expect(record.execute(snapshotInput('missing', baseline), ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'ISSUE_NOT_FOUND',
    });
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    await close.execute({ issueId: created.issueId, resolved: true }, ctxFor(), SIGNAL);
    await expect(
      record.execute(snapshotInput(created.issueId, baseline), ctxFor(), SIGNAL),
    ).rejects.toMatchObject({ code: 'ISSUE_CLOSED' });
  });

  it('compareSnapshots reports resolved=false while baseline keys remain', async () => {
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as {
      issueId: string;
      snapshotId: string;
    };
    const output = (await compare.execute(
      { issueId: created.issueId, newIssues: [baseline[0]] },
      ctxFor(),
      SIGNAL,
    )) as {
      resolved: boolean;
      resolvedCount: number;
      unresolvedCount: number;
      totalBaseline: number;
      totalNew: number;
      baselineSnapshotId: string;
      details: { unresolvedKeys: string[] };
    };
    expect(output.resolved).toBe(false);
    expect(output.resolvedCount).toBe(1);
    expect(output.unresolvedCount).toBe(1);
    expect(output.totalBaseline).toBe(2);
    expect(output.totalNew).toBe(1);
    expect(output.baselineSnapshotId).toBe(created.snapshotId);
    expect(output.details.unresolvedKeys).toHaveLength(1);
  });

  it('compareSnapshots reports resolved=true when every baseline key is gone (case-insensitive)', async () => {
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    const output = (await compare.execute(
      {
        issueId: created.issueId,
        newIssues: [
          { item: 'WIDGET-1', orderNumber: 'so-100', workOrderNumber: 'wo-1', dueDate: '2026-09-01' },
          { item: 'WIDGET-2', orderNumber: 'SO-101', dueDate: '2026-09-02' },
        ],
      },
      ctxFor(),
      SIGNAL,
    )) as { resolved: boolean; resolvedCount: number; unresolvedCount: number };
    // Both baseline rows still present -> not resolved; flip to prove the true path:
    expect(output.resolved).toBe(false);
    const empty = (await compare.execute({ issueId: created.issueId, newIssues: [] }, ctxFor(), SIGNAL)) as {
      resolved: boolean;
      unresolvedCount: number;
    };
    expect(empty.resolved).toBe(true);
    expect(empty.unresolvedCount).toBe(0);
  });

  it('compareSnapshots compares against the LATEST snapshot', async () => {
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    await record.execute(snapshotInput(created.issueId, [baseline[0]]), ctxFor(), SIGNAL);
    const output = (await compare.execute(
      { issueId: created.issueId, newIssues: [baseline[0]] },
      ctxFor(),
      SIGNAL,
    )) as { resolved: boolean; totalBaseline: number; unresolvedCount: number; baselineSnapshotId: string };
    // Latest snapshot has 1 row (not the original 2); that row is still
    // present in the new report, so it is unresolved — and totalBaseline=1
    // proves the latest snapshot was used, not the first.
    expect(output.totalBaseline).toBe(1);
    expect(output.resolved).toBe(false);
    expect(output.unresolvedCount).toBe(1);
  });

  it('closeIssue with resolved=false is a fall-through-safe no-op', async () => {
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    const output = (await close.execute({ issueId: created.issueId, resolved: false }, ctxFor(), SIGNAL)) as {
      issueId: string;
      closed: boolean;
      note?: string;
    };
    expect(output.closed).toBe(false);
    expect(output.note).toBeTruthy();
    // Status provably unchanged:
    const fetched = (await get.execute({ issueId: created.issueId }, ctxFor(), SIGNAL)) as {
      status: string;
      snapshotCount: number;
    };
    expect(fetched.status).toBe('open');
    expect(fetched.snapshotCount).toBe(1);
  });

  it('closeIssue with resolved=true closes the issue', async () => {
    const created = (await record.execute(snapshotInput('', baseline), ctxFor(), SIGNAL)) as { issueId: string };
    const output = (await close.execute({ issueId: created.issueId, resolved: true }, ctxFor(), SIGNAL)) as {
      closed: boolean;
    };
    expect(output.closed).toBe(true);
    const fetched = (await get.execute({ issueId: created.issueId }, ctxFor(), SIGNAL)) as { status: string };
    expect(fetched.status).toBe('closed');
  });

  it('getIssue rejects unknown issues with ISSUE_NOT_FOUND', async () => {
    await expect(get.execute({ issueId: 'missing' }, ctxFor(), SIGNAL)).rejects.toMatchObject({
      code: 'ISSUE_NOT_FOUND',
    });
  });
});
