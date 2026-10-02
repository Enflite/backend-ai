/**
 * apsPlanningRoutes.test.ts — HTTP tests for /api/v1/aps/*.
 *
 * The substrate seam (sibling's unlanded pipeline) is MOCKED via
 * overrideSubstrateClient and labeled as such; MongoDB is an in-memory
 * stand-in. VALIDATED IN CI (vitest). REQUIRES REAL PRODUCTION
 * INFRASTRUCTURE for the live flows/mongo/documents pipeline.
 */
import { beforeEach, describe, expect, it, vi, afterEach } from 'vitest';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { SubstrateUnavailableError } from '../src/apsPlanning/substrate.js';
import { overrideSubstrateClient } from '../src/apsPlanning/substrate.js';
import { overrideApsJudge, type ApsJudgmentResult } from '../src/apsPlanning/agentJudgment.js';
import { claimPendingSubstrateRetry } from '../src/apsPlanning/store.js';
import { apsPlanningRoutes } from '../src/apsPlanning/routes.js';
import { AppError } from '../src/errors.js';

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in
// ---------------------------------------------------------------------------

type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc): boolean {
  for (const [key, cond] of Object.entries(filter)) {
    const value = doc[key];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      if ('$nin' in cond && (cond as any).$nin.includes(value)) return false;
      if ('$in' in cond && !(cond as any).$in.includes(value)) return false;
      continue;
    }
    if (value !== cond) return false;
  }
  return true;
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (typeof cur[p] !== 'object' || cur[p] === null) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]!] = value;
}

function applyUpdate(doc: Doc, update: Doc): void {
  if (update.$set) for (const [k, v] of Object.entries(update.$set)) setPath(doc, k, v);
  if (update.$addToSet) {
    for (const [k, v] of Object.entries(update.$addToSet)) {
      const arr = (doc[k] ??= []) as unknown[];
      if (!arr.includes(v)) arr.push(v);
    }
  }
  if (update.$push) {
    for (const [k, v] of Object.entries(update.$push)) {
      const arr = (doc[k] ??= []) as unknown[];
      arr.push(v);
    }
  }
}

function memCollection(docs: Doc[]) {
  const cursor = (out: Doc[]) => {
    const c: any = {
      sort: (spec: Doc) => {
        const first = Object.entries(spec)[0]!;
        const [key, dir] = first;
        out = [...out].sort((a, b) => {
          const av = a[key] instanceof Date ? a[key].getTime() : a[key];
          const bv = b[key] instanceof Date ? b[key].getTime() : b[key];
          return (av < bv ? -1 : av > bv ? 1 : 0) * (dir === -1 ? -1 : 1);
        });
        return c;
      },
      limit: (n: number) => {
        out = out.slice(0, n);
        return c;
      },
      toArray: async () => out.map((d) => ({ ...d })),
    };
    return c;
  };
  return {
    insertOne: vi.fn(async (doc: Doc) => {
      docs.push({ ...doc });
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Doc) => {
      const found = docs.find((d) => matches(d, filter));
      return found ? { ...found } : null;
    }),
    find: vi.fn((filter: Doc) => cursor(docs.filter((d) => matches(d, filter)))),
    findOneAndUpdate: vi.fn(async (filter: Doc, update: Doc, opts?: Doc) => {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return null;
      applyUpdate(doc, update);
      return opts?.returnDocument === 'after' ? { ...doc } : null;
    }),
    updateOne: vi.fn(async (filter: Doc, update: Doc) => {
      const doc = docs.find((d) => matches(d, filter));
      if (!doc) return { matchedCount: 0 };
      applyUpdate(doc, update);
      return { matchedCount: 1 };
    }),
  };
}

const stores: Record<string, Doc[]> = {};
const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { intakeMock } = vi.hoisted(() => ({ intakeMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { configMock } = vi.hoisted(() => ({
  configMock: { APS_PLANNING_ENABLED: true },
}));
const { currentAuth } = vi.hoisted(() => ({
  currentAuth: {
    userId: 'user-1',
    tenantId: 'tenant-1',
    sessionId: 'sess-1',
    roleId: 'role-1',
    email: 'planner@example.test',
    displayName: 'Planner',
    roleName: 'User',
    clearance: 'INTERNAL',
    permissions: ['aps:plan', 'document:upload', 'chat:create', 'tool:use'],
  },
}));

// Mocked agent-judge (the default judge would call the AI gateway).
// The return type is annotated (not inferred) so tests can resolve both
// union members (ok / judge-unavailable).
const { judgeMock } = vi.hoisted(() => ({
  judgeMock: vi.fn(
    async (_actor: unknown, _request: unknown, _signal: unknown): Promise<ApsJudgmentResult> => ({
      ok: true,
      decision: { order: ['a', 'b'], rationale: 'Customer-commit risk first.' },
    }),
  ),
}));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/documents/intake.js', () => ({ intakeUploadedDocument: intakeMock }));
vi.mock('../src/audit/audit.js', () => ({ recordAudit: recordAuditMock }));
vi.mock('../src/config.js', () => ({ config: configMock }));
vi.mock('../src/auth/middleware.js', () => ({
  requireAuth: (req: any, _reply: any, done: () => void) => {
    req.auth = currentAuth;
    done();
  },
}));
vi.mock('../src/authz/middleware.js', () => ({
  requirePermission: (permission: string) => async (req: any, _reply: any) => {
    if (!req.auth?.permissions?.includes(permission)) {
      const err: any = new Error(`Missing required permission: ${permission}`);
      err.statusCode = 403;
      err.code = 'AUTHORIZATION_FAILURE';
      throw err;
    }
  },
}));

// ---------------------------------------------------------------------------
// Fake substrate (MOCKED — the sibling pipeline has not landed)
// ---------------------------------------------------------------------------

const fakeIssue = {
  _id: 'ISS-1',
  tenantId: 'tenant-1',
  site: 'SITE1',
  reportDocumentId: 'doc-1',
  status: 'open',
  snapshots: [
    {
      snapshotId: 'snap-1',
      createdAt: new Date('2026-10-01T10:00:00Z'),
      issues: [
        { type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', demandId: 'SO-1', severity: 'high' },
        { type: 'MOVE_IN_RCPT', item: 'B', supplyId: 'PO-2', demandId: 'SO-2', severity: 'medium' },
      ],
    },
    {
      snapshotId: 'snap-2',
      createdAt: new Date('2026-10-02T10:00:00Z'),
      issues: [
        { type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', demandId: 'SO-1', severity: 'critical' },
        { type: 'EXPEDITED_N_DAYS', item: 'D', supplyId: 'PO-4', demandId: 'SO-4', severity: 'low' },
      ],
    },
  ],
  createdAt: new Date('2026-10-01T10:00:00Z'),
  updatedAt: new Date('2026-10-02T10:00:00Z'),
};

const substrateMock = {
  invokeAnalysisFlow: vi.fn(async () => ({
    runId: 'run-1',
    flowName: 'aps-exception-analysis',
    flowVersion: 1,
  })),
  invokeVerifyFlow: vi.fn(async () => ({
    runId: 'run-v-1',
    flowName: 'aps-exception-verify',
    flowVersion: 1,
  })),
  getIssue: vi.fn(async (_tenantId: string, issueId: string) =>
    issueId === 'ISS-1' ? structuredClone(fakeIssue) : null,
  ),
  getFlowRunStatus: vi.fn(async () => ({
    status: 'completed',
    outputs: { issueId: 'ISS-1', snapshotId: 'snap-1' },
  })),
};

function seedDocuments() {
  stores.documents = [
    { _id: 'doc-1', tenantId: 'tenant-1', ownerId: 'user-1', filename: 'exceptions.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', deletedAt: null },
    { _id: 'doc-up-1', tenantId: 'tenant-1', ownerId: 'user-1', filename: 'report.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', deletedAt: null },
  ];
}

async function buildApp() {
  const app = Fastify();
  // Mirrors the AppError branch of serverErrorHandler (backend/src/server.ts)
  // so thrown route errors serialize as { error: { code, message, ... } }.
  app.setErrorHandler((error: unknown, req: any, reply: any) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error instanceof Error ? error.message : 'Request failed',
          requestId: req.requestId,
          details: (error as any).details,
        },
      });
    }
    return reply.status((error as any)?.statusCode ?? 500).send({
      error: { code: (error as any)?.code ?? 'INTERNAL_ERROR', message: (error as any)?.message ?? 'Request failed' },
    });
  });
  await app.register(multipart);
  await app.register(apsPlanningRoutes, { prefix: '/api/v1' });
  return app;
}

beforeEach(() => {
  for (const k of Object.keys(stores)) delete stores[k];
  stores.aps_analyses = [];
  seedDocuments();
  getDbMock.mockImplementation(async () => ({
    collection: (name: string) => {
      stores[name] ??= [];
      return memCollection(stores[name]!);
    },
  }));
  intakeMock.mockImplementation(async (_auth: unknown, input: { filename: string }) => ({
    id: 'doc-up-1',
    filename: input.filename,
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    sizeBytes: 10,
    checksumSha256: 'abc',
    classification: 'INTERNAL',
    status: 'PENDING',
    errorCode: null,
    createdAt: new Date(),
  }));
  recordAuditMock.mockReset();
  judgeMock.mockClear();
  judgeMock.mockResolvedValue({
    ok: true as const,
    decision: { order: ['a', 'b'], rationale: 'Customer-commit risk first.' },
  });
  substrateMock.invokeAnalysisFlow.mockClear();
  substrateMock.invokeVerifyFlow.mockClear();
  substrateMock.getIssue.mockClear();
  substrateMock.getFlowRunStatus.mockClear();
  substrateMock.getFlowRunStatus.mockResolvedValue({
    status: 'completed',
    outputs: { issueId: 'ISS-1', snapshotId: 'snap-1' },
  });
  overrideSubstrateClient(substrateMock as any);
  overrideApsJudge(judgeMock as any);
  configMock.APS_PLANNING_ENABLED = true;
});

afterEach(() => {
  overrideSubstrateClient(null);
  overrideApsJudge(null);
});

describe('POST /aps/analyses (MOCKED substrate)', () => {
  it('intakes a referenced document and invokes the analysis flow → 202 analyzing', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-1', site: 'SITE1' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('analyzing');
    expect(body.product).toEqual({ name: 'APS Planning Agent', version: '1.0.0' });
    expect(substrateMock.invokeAnalysisFlow).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      { exceptionReportDocumentId: 'doc-1', issueId: '', site: 'SITE1' },
    );
    const stored = (stores.aps_analyses!)[0]!;
    expect(stored.exportType).toBe('EXCEPTION_REPORT');
    expect(stored.sourceDocumentIds).toEqual(['doc-1']);
    await app.close();
  });

  it('records pending-substrate honestly when the pipeline has not landed', async () => {
    substrateMock.invokeAnalysisFlow.mockRejectedValueOnce(
      new SubstrateUnavailableError('flow "aps-exception-analysis" is not published'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-1' },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('pending-substrate');
    expect(body.statusNote).toMatch(/not been published/i);
    expect((stores.aps_analyses!)[0]!.status).toBe('pending-substrate');
    await app.close();
  });

  it('rejects intake with no report', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/aps/analyses', payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejects a non-workbook document', async () => {
    stores.documents!.push({ _id: 'doc-pdf', tenantId: 'tenant-1', ownerId: 'user-1', filename: 'notes.pdf', mimeType: 'application/pdf', deletedAt: null });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-pdf' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVALID_REPORT_TYPE');
    await app.close();
  });

  it('rejects a document the requester cannot read (owner-or-grant)', async () => {
    stores.documents!.push({ _id: 'doc-other', tenantId: 'tenant-1', ownerId: 'someone-else', filename: 'exceptions.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', deletedAt: null });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-other' },
    });
    // Same as GET /documents/:id: invisible documents 404 (no ID oracle).
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('accepts a multipart workbook through the shared documents intake', async () => {
    const app = await buildApp();
    const boundary = 'testboundary';
    const payload =
      `--${boundary}\r\nContent-Disposition: form-data; name="report"; filename="report.xlsx"\r\nContent-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet\r\n\r\nPKfakebytes\r\n` +
      `--${boundary}\r\nContent-Disposition: form-data; name="site"\r\n\r\nSITE1\r\n` +
      `--${boundary}--\r\n`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      payload,
    });
    expect(res.statusCode).toBe(202);
    expect(intakeMock).toHaveBeenCalled();
    expect((stores.aps_analyses!)[0]!.sourceDocumentIds).toEqual(['doc-up-1']);
    await app.close();
  });

  it('returns 403 FEATURE_DISABLED when the kill switch is off', async () => {
    configMock.APS_PLANNING_ENABLED = false;
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/aps/analyses' });
    expect(res.statusCode).toBe(403);
    await app.close();
  });
});

describe('analyses read + column map (MOCKED substrate)', () => {
  async function createAnalysis(status = 'analyzing', extra: Record<string, unknown> = {}) {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-1', site: 'SITE1' },
    });
    const id = res.json().id as string;
    if (status !== 'analyzing' || Object.keys(extra).length > 0) {
      const db = await getDbMock();
      await db.collection('aps_analyses').updateOne(
        { _id: id },
        { $set: { status, ...extra } },
      );
    }
    return { app, id };
  }

  it('lists analyses and shows detail with status refresh from the flow run', async () => {
    const { app, id } = await createAnalysis();
    const list = await app.inject({ method: 'GET', url: '/api/v1/aps/analyses' });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    // The mocked run completed with issueId/snapshotId outputs → awaiting-planner.
    const detail = await app.inject({ method: 'GET', url: `/api/v1/aps/analyses/${id}` });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.status).toBe('awaiting-planner');
    expect(body.issueId).toBe('ISS-1');
    expect(body.baselineSnapshotId).toBe('snap-1');
    await app.close();
  });

  it('confirms a column map and rejects one missing exceptionText', async () => {
    const { app, id } = await createAnalysis();
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/aps/analyses/${id}/column-map`,
      payload: { columns: { item: 'Item', exceptionText: 'Exception Message' }, confirmed: true },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().columnMap.confirmed).toBe(true);
    const bad = await app.inject({
      method: 'POST',
      url: `/api/v1/aps/analyses/${id}/column-map`,
      payload: { columns: { item: 'Item' }, confirmed: true },
    });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('verify requires a recorded issue id, then starts the verify flow', async () => {
    const noIssue = await createAnalysis();
    const denied = await noIssue.app.inject({
      method: 'POST',
      url: `/api/v1/aps/analyses/${noIssue.id}/verify`,
      payload: { documentId: 'doc-1' },
    });
    expect(denied.statusCode).toBe(409);
    expect(denied.json().error.code).toBe('ANALYSIS_HAS_NO_ISSUE');
    await noIssue.app.close();

    const withIssue = await createAnalysis('awaiting-planner', { issueId: 'ISS-1' });
    const res = await withIssue.app.inject({
      method: 'POST',
      url: `/api/v1/aps/analyses/${withIssue.id}/verify`,
      payload: { documentId: 'doc-1' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('verifying');
    expect(substrateMock.invokeVerifyFlow).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      { issueId: 'ISS-1', newReportDocumentId: 'doc-1', site: 'SITE1' },
    );
    await withIssue.app.close();
  });

  it('verify surfaces SUBSTRATE_UNAVAILABLE honestly', async () => {
    substrateMock.invokeVerifyFlow.mockRejectedValueOnce(
      new SubstrateUnavailableError('flow "aps-exception-verify" is not published'),
    );
    const { app, id } = await createAnalysis('awaiting-planner', { issueId: 'ISS-1' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/aps/analyses/${id}/verify`,
      payload: { documentId: 'doc-1' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBSTRATE_UNAVAILABLE');
    await app.close();
  });

  it('cancels an analysis; a second cancel is a 409', async () => {
    const { app, id } = await createAnalysis();
    const first = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/cancel` });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('cancelled');
    const second = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/cancel` });
    expect(second.statusCode).toBe(409);
    await app.close();
  });
});

describe('snapshots (MOCKED substrate)', () => {
  it('lists snapshots of an issue and fetches one', async () => {
    const app = await buildApp();
    const list = await app.inject({ method: 'GET', url: '/api/v1/aps/snapshots?issueId=ISS-1' });
    expect(list.statusCode).toBe(200);
    const body = list.json();
    expect(body.snapshots).toHaveLength(2);
    expect(body.snapshots[0].snapshotId).toBe('snap-2'); // newest first
    const one = await app.inject({ method: 'GET', url: '/api/v1/aps/snapshots/snap-1?issueId=ISS-1' });
    expect(one.statusCode).toBe(200);
    expect(one.json().issues).toHaveLength(2);
    const missing = await app.inject({ method: 'GET', url: '/api/v1/aps/snapshots/nope?issueId=ISS-1' });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('requires issueId for snapshots', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/aps/snapshots' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('compares two snapshots with per-row verdicts', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/aps/snapshots/compare?base=snap-1&other=snap-2&issueId=ISS-1',
    });
    expect(res.statusCode).toBe(200);
    const { comparison } = res.json();
    expect(comparison.summary).toEqual({ resolved: 1, stillOpen: 0, worsened: 1, new: 1 });
    const byKey = new Map(comparison.rows.map((r: any) => [r.key, r.verdict]));
    expect(byKey.get('rcpt_projected_late|a|po-1|so-1')).toBe('worsened');
    expect(byKey.get('move_in_rcpt|b|po-2|so-2')).toBe('resolved');
    expect(byKey.get('expedited_n_days|d|po-4|so-4')).toBe('new');
    await app.close();
  });

  it('returns 409 SUBSTRATE_UNAVAILABLE when the issue store has not landed', async () => {
    substrateMock.getIssue.mockRejectedValueOnce(
      new SubstrateUnavailableError('the aps_issues store has not landed yet'),
    );
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/aps/snapshots?issueId=ISS-1' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('SUBSTRATE_UNAVAILABLE');
    await app.close();
  });
});

describe('POST /aps/analyses/:id/retry (MOCKED substrate)', () => {
  /** Create an analysis that landed honestly in pending-substrate. */
  async function createPending() {
    substrateMock.invokeAnalysisFlow.mockRejectedValueOnce(
      new SubstrateUnavailableError('flow "aps-exception-analysis" is not published'),
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-1', site: 'SITE1' },
    });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('pending-substrate');
    return { app, id: res.json().id as string };
  }

  it('retries a pending-substrate analysis once the pipeline is published → 202 analyzing', async () => {
    const { app, id } = await createPending();
    substrateMock.invokeAnalysisFlow.mockClear();
    const res = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('analyzing');
    expect(body.retried).toBe(true);
    expect(body.flowRunId).toBe('run-1');
    expect(substrateMock.invokeAnalysisFlow).toHaveBeenCalledTimes(1);
    // The retry re-uses the STORED intake inputs — the requester's workbook.
    expect(substrateMock.invokeAnalysisFlow).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1' }),
      { exceptionReportDocumentId: 'doc-1', issueId: '', site: 'SITE1' },
    );
    expect((stores.aps_analyses!)[0]!.status).toBe('analyzing');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'APS_ANALYSIS_RETRY_STARTED', success: true }),
    );
    await app.close();
  });

  it('stays in pending-substrate honestly when the pipeline is still unpublished', async () => {
    const { app, id } = await createPending();
    substrateMock.invokeAnalysisFlow.mockRejectedValueOnce(
      new SubstrateUnavailableError('flow "aps-exception-analysis" is not published'),
    );
    const res = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.status).toBe('pending-substrate');
    expect(body.retried).toBe(false);
    expect(body.statusNote).toMatch(/still not published/i);
    // The claim was released: status back to pending-substrate, no flow run linked.
    const stored = (stores.aps_analyses!)[0]!;
    expect(stored.status).toBe('pending-substrate');
    expect(stored.flowRunId).toBeUndefined();
    expect(stored.retryInFlight).toBe(false);
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'APS_ANALYSIS_RETRY_SKIPPED',
        metadata: expect.objectContaining({ reason: 'substrate-unavailable' }),
      }),
    );
    await app.close();
  });

  it('is idempotent: retrying an in-flight analysis starts no second run', async () => {
    const app = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/analyses',
      payload: { documentId: 'doc-1', site: 'SITE1' },
    });
    const id = created.json().id as string;
    expect(created.json().status).toBe('analyzing');
    substrateMock.invokeAnalysisFlow.mockClear();
    const res = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'analyzing', retried: false, flowRunId: 'run-1' });
    expect(substrateMock.invokeAnalysisFlow).not.toHaveBeenCalled();
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'APS_ANALYSIS_RETRY_SKIPPED',
        metadata: expect.objectContaining({ reason: 'already-in-flight' }),
      }),
    );
    await app.close();
  });

  it('409s terminal analyses; awaiting-planner is not retryable', async () => {
    const { app, id } = await createPending();
    const db = await getDbMock();
    await db.collection('aps_analyses').updateOne({ _id: id }, { $set: { status: 'resolved' } });
    const terminal = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(terminal.statusCode).toBe(409);
    expect(terminal.json().error.code).toBe('ANALYSIS_TERMINAL');

    await db.collection('aps_analyses').updateOne({ _id: id }, { $set: { status: 'blocked' } });
    const blocked = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.code).toBe('ANALYSIS_TERMINAL');

    // awaiting-planner is mid-lifecycle but its substrate start already
    // happened — retrying the start is meaningless.
    await db.collection('aps_analyses').updateOne({ _id: id }, { $set: { status: 'awaiting-planner' } });
    const waiting = await app.inject({ method: 'POST', url: `/api/v1/aps/analyses/${id}/retry` });
    expect(waiting.statusCode).toBe(409);
    expect(waiting.json().error.code).toBe('ANALYSIS_NOT_RETRYABLE');
    await app.close();
  });

  it('404s an unknown analysis', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/v1/aps/analyses/nope/retry' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('the atomic claim is single-winner: a lost race cannot start a second run', async () => {
    const { app, id } = await createPending();
    const first = await claimPendingSubstrateRetry('tenant-1', id);
    expect(first).not.toBeNull();
    expect(first!.status).toBe('analyzing');
    // The analysis already left pending-substrate: the second claim loses.
    const second = await claimPendingSubstrateRetry('tenant-1', id);
    expect(second).toBeNull();
    await app.close();
  });
});

describe('POST /aps/issues/:issueId/judgment (MOCKED substrate + judge)', () => {
  it('prioritizes from the issue’s latest snapshot aggregates — never full rows', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: { kind: 'prioritize' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issueId).toBe('ISS-1');
    expect(body.kind).toBe('prioritize');
    expect(body.judgmentRef).toBe('aps-prioritize');
    expect(body.decision).toEqual({ order: ['a', 'b'], rationale: 'Customer-commit risk first.' });
    // Aggregates only: the judge saw per-issue summaries (ids, types,
    // severities), never report rows.
    expect(judgeMock).toHaveBeenCalledTimes(1);
    const request = judgeMock.mock.calls[0]![1] as { userMessage: string };
    expect(request.userMessage).toContain('rcpt_projected_late|a|po-1|so-1');
    expect(request.userMessage).not.toContain('exceptionText');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'APS_JUDGMENT_REQUESTED',
        success: true,
        metadata: expect.objectContaining({ kind: 'prioritize', summaryCount: 2 }),
      }),
    );
    await app.close();
  });

  it('explains one issue from an explicit summary', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: {
        kind: 'explain',
        summaries: [{ id: 'ISS-1-row-1', type: 'RCPT_PROJECTED_LATE', severity: 'high', item: 'A', daysLate: 9 }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().judgmentRef).toBe('aps-explain');
    await app.close();
  });

  it('recommends from explicit summaries', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: {
        kind: 'recommend',
        summaries: [{ id: 'x', type: 'MOVE_IN_RCPT', severity: 'medium' }],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().judgmentRef).toBe('aps-recommend');
    await app.close();
  });

  it('validates the judgment kind and the explain single-summary rule', async () => {
    const app = await buildApp();
    const badKind = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: { kind: 'correlate' },
    });
    expect(badKind.statusCode).toBe(400);
    const twoSummaries = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: {
        kind: 'explain',
        summaries: [
          { id: 'a', type: 'X', severity: 'high' },
          { id: 'b', type: 'Y', severity: 'low' },
        ],
      },
    });
    expect(twoSummaries.statusCode).toBe(400);
    expect(twoSummaries.json().error.code).toBe('VALIDATION_ERROR');
    const noBody = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
    });
    expect(noBody.statusCode).toBe(400);
    await app.close();
  });

  it('404s an unknown issue', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/NOPE/judgment',
      payload: { kind: 'prioritize' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('ISSUE_NOT_FOUND');
    await app.close();
  });

  it('400s when the issue has no classifiable snapshots', async () => {
    substrateMock.getIssue.mockImplementationOnce(async (_tenantId: string, issueId: string) =>
      issueId === 'ISS-EMPTY'
        ? { _id: 'ISS-EMPTY', tenantId: 'tenant-1', site: 'S1', reportDocumentId: 'doc-1', status: 'open', snapshots: [], createdAt: new Date(), updatedAt: new Date() }
        : null,
    );
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-EMPTY/judgment',
      payload: { kind: 'prioritize' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('JUDGMENT_NO_SUMMARIES');
    await app.close();
  });

  it('502s honestly when the judge is unavailable', async () => {
    judgeMock.mockResolvedValueOnce({
      ok: false as const,
      code: 'judge-unavailable' as const,
      detail: 'No servable model is available for agent judgment.',
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/aps/issues/ISS-1/judgment',
      payload: { kind: 'prioritize' },
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('JUDGE_FAILED');
    expect(recordAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'APS_JUDGMENT_REQUESTED', success: false }),
    );
    await app.close();
  });
});
