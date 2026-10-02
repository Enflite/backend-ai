/**
 * apsExceptionFlows.test.ts — the APS exception-resolution flows (ADR-022).
 *
 * - both flows/*.flow.json files parse clean via flowDefinitionSchema
 *   (guards schema drift between the config-as-code files and the schema);
 * - lifecycle: createFlow → publishVersion → v1 exists →
 *   setLiveAlias(live, expectedRevision) → getLiveDefinition resolves v1,
 *   for BOTH flows;
 * - dry-run RESOLVED branch: compareSnapshots → {resolved:true};
 *   close-issue runs with resolved=true; reanalyze is skipped;
 * - dry-run NOT-RESOLVED branch: compareSnapshots → {resolved:false};
 *   reanalyze runs the analysis flow as a subflow (its tool steps
 *   execute), then close-issue no-ops on resolved=false and the run
 *   completes with the issue still open.
 *
 * NOTE: the `when` on the `resolved` condition step uses the unquoted-LHS
 * form `{{steps.compare-results.output.resolved}} == 'true'` — the quoted
 * form `'{{…}}' == 'true'` interpolates the literal quotes into the LHS
 * (`'true' == 'true'`), which the comparison grammar never matches, so a
 * boolean would evaluate the branch as false on both sides.
 *
 * The tool executor and agent gateway are stubbed (overrideFlowToolExecutor
 * / overrideFlowAgentFn); the DB is an in-memory stand-in.
 * VALIDATED IN CI; real aps.* tool execution and model calls REQUIRE
 * REAL INFRA (SyteLine, documents service).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }));
const { recordAuditMock } = vi.hoisted(() => ({ recordAuditMock: vi.fn() }));
const { liveRequesterAuthMock } = vi.hoisted(() => ({ liveRequesterAuthMock: vi.fn() }));
const { gatewayStreamMock } = vi.hoisted(() => ({ gatewayStreamMock: vi.fn() }));
const { resolveChatDefaultMock } = vi.hoisted(() => ({ resolveChatDefaultMock: vi.fn() }));
const { runToolCallMock } = vi.hoisted(() => ({ runToolCallMock: vi.fn() }));

vi.mock('../src/db/mongo.js', () => ({ getDb: getDbMock }));
vi.mock('../src/audit/audit.js', () => ({
  recordAudit: recordAuditMock,
  sanitizeReason: (reason?: string | null) => reason ?? null,
}));
vi.mock('../src/syteline/requesterAuth.js', () => ({
  liveRequesterAuth: liveRequesterAuthMock,
}));
vi.mock('../src/ai/gateway/gateway.js', () => ({ gatewayStream: gatewayStreamMock }));
vi.mock('../src/ai/gateway/capabilityRouter.js', () => ({
  resolveChatDefault: resolveChatDefaultMock,
}));
vi.mock('../src/tools/gateway.js', () => ({ runToolCall: runToolCallMock }));

import { config } from '../src/config.js';
import type { AuthContext, Permission } from '../src/authz/permissions.js';
import {
  claimRun,
  createFlow,
  createRun,
  getFlow,
  getLiveDefinition,
  getRun,
  getVersion,
  publishVersion,
  setLiveAlias,
} from '../src/flows/flowStore.js';
import { flowDefinitionSchema, type FlowDefinition } from '../src/flows/flowTypes.js';
import {
  overrideFlowAgentFn,
  overrideFlowToolExecutor,
  runFlow,
  type FlowAgentCallArgs,
  type FlowToolCallResult,
} from '../src/flows/flowRunner.js';
import type { FlowRunDoc } from '../src/flows/flowTypes.js';

const TENANT = 'tenant-a';
const USER = 'user-admin';

function authFor(permissions: Permission[]): AuthContext {
  return {
    userId: USER,
    email: 'admin@example.test',
    displayName: 'Admin',
    clearance: 'INTERNAL',
    tenantId: TENANT,
    roleId: 'role-1',
    roleName: 'Admin',
    permissions,
    sessionId: 'sess-1',
  };
}

const ADMIN_AUTH = () => authFor(['flows:manage', 'flows:run', 'tenant:manage']);

// ---------------------------------------------------------------------------
// In-memory Mongo stand-in (mirrors flowsRunner.test.ts)
// ---------------------------------------------------------------------------

function getDotted(doc: Record<string, any>, path: string): unknown {
  return path.split('.').reduce<unknown>((obj, key) => {
    if (obj === null || obj === undefined || typeof obj !== 'object') return undefined;
    return (obj as Record<string, unknown>)[key];
  }, doc);
}

function applyDotted(doc: Record<string, any>, path: string, value: unknown): void {
  const parts = path.split('.');
  let target: Record<string, any> = doc;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!;
    const next = parts[i + 1]!;
    if (typeof target[part] !== 'object' || target[part] === null) {
      target[part] = /^\d+$/.test(next) ? [] : {};
    }
    target = target[part];
  }
  target[parts[parts.length - 1]!] = value;
}

function matches(doc: Record<string, any>, filter: Record<string, any>): boolean {
  return Object.entries(filter).every(([key, value]) => {
    const actual = key.includes('.') ? getDotted(doc, key) : doc[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      if ('$nin' in value) return !(value.$nin as unknown[]).includes(actual);
      if ('$in' in value) return (value.$in as unknown[]).includes(actual);
      return false;
    }
    return actual === value;
  });
}

function memoryCollection() {
  const docs = new Map<string, Record<string, any>>();
  const clone = (doc: Record<string, any>): Record<string, any> => structuredClone(doc);

  const applyUpdate = (doc: Record<string, any>, update: Record<string, any>): void => {
    for (const [key, value] of Object.entries(update.$set ?? {})) {
      applyDotted(doc, key, value);
    }
    for (const [key, value] of Object.entries(update.$inc ?? {})) {
      const current = (getDotted(doc, key) as number | undefined) ?? 0;
      applyDotted(doc, key, current + (value as number));
    }
    for (const [key, value] of Object.entries(update.$push ?? {})) {
      const arr = (getDotted(doc, key) as unknown[] | undefined) ?? [];
      arr.push(value);
      applyDotted(doc, key, arr);
    }
  };

  return {
    insertOne: vi.fn(async (doc: Record<string, any>) => {
      if (docs.has(doc._id)) {
        const error = new Error('duplicate key') as Error & { code: number };
        error.code = 11000;
        throw error;
      }
      docs.set(doc._id, clone(doc));
      return { insertedId: doc._id };
    }),
    findOne: vi.fn(async (filter: Record<string, any>) => {
      for (const doc of docs.values()) if (matches(doc, filter)) return clone(doc);
      return null;
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, any>, update: Record<string, any>, _opts?: unknown) => {
        for (const [id, doc] of docs) {
          if (matches(doc, filter)) {
            applyUpdate(doc, update);
            docs.set(id, doc);
            return clone(doc);
          }
        }
        return null;
      },
    ),
    updateOne: vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          applyUpdate(doc, update);
          docs.set(id, doc);
          return { matchedCount: 1, modifiedCount: 1 };
        }
      }
      return { matchedCount: 0, modifiedCount: 0 };
    }),
    deleteOne: vi.fn(async (filter: Record<string, any>) => {
      for (const [id, doc] of docs) {
        if (matches(doc, filter)) {
          docs.delete(id);
          return { deletedCount: 1 };
        }
      }
      return { deletedCount: 0 };
    }),
    find: vi.fn((filter: Record<string, any>) => {
      let rows = [...docs.values()].filter((doc) => matches(doc, filter)).map(clone);
      const cursor: any = {
        sort: (spec: Record<string, 1 | -1>) => {
          const entries = Object.entries(spec);
          rows.sort((a, b) => {
            for (const [key, dir] of entries) {
              const av: any = getDotted(a, key);
              const bv: any = getDotted(b, key);
              if (av === bv) continue;
              if (av === undefined) return 1;
              if (bv === undefined) return -1;
              return (av < bv ? -1 : 1) * dir;
            }
            return 0;
          });
          return cursor;
        },
        limit: (n: number) => {
          rows = rows.slice(0, n);
          return cursor;
        },
        toArray: async () => rows,
      };
      return cursor;
    }),
    createIndex: vi.fn(async () => 'idx'),
  };
}

let flowsColl: ReturnType<typeof memoryCollection>;
let runsColl: ReturnType<typeof memoryCollection>;

function dbFor(name: string): unknown {
  if (name === 'flows') return flowsColl;
  if (name === 'flow_runs') return runsColl;
  throw new Error(`unexpected collection: ${name}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  flowsColl = memoryCollection();
  runsColl = memoryCollection();
  getDbMock.mockResolvedValue({ collection: (name: string) => dbFor(name) });
  recordAuditMock.mockResolvedValue(undefined);
  liveRequesterAuthMock.mockResolvedValue(ADMIN_AUTH());
  overrideFlowToolExecutor(null);
  overrideFlowAgentFn(null);
  config.FLOW_RUNNER_ENABLED = false;
});

// ---------------------------------------------------------------------------
// Flow definitions under test (read from the repo's flows/ directory)
// ---------------------------------------------------------------------------

const FLOWS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'flows');

function loadFlowFile(fileName: string): FlowDefinition {
  const raw = readFileSync(join(FLOWS_DIR, fileName), 'utf8');
  return flowDefinitionSchema.parse(JSON.parse(raw));
}

const ANALYSIS_FILE = 'aps-exception-analysis.flow.json';
const VERIFY_FILE = 'aps-exception-verify.flow.json';

// ---------------------------------------------------------------------------
// Tool + agent stubs (keyed by tool name / agent step id)
// ---------------------------------------------------------------------------

type ToolBehavior = (tool: string, params: Record<string, unknown>) => FlowToolCallResult;

let toolBehavior: ToolBehavior = () => ({ ok: true, data: null });
const toolCalls: Array<{ stepId: string; tool: string; params: Record<string, unknown> }> = [];
/** The mock tool's returned `data` per call, in the same order as toolCalls. */
const toolResults: unknown[] = [];

function useFakeTools(behavior: ToolBehavior): void {
  toolBehavior = behavior;
  toolCalls.length = 0;
  toolResults.length = 0;
  overrideFlowToolExecutor(async ({ step, params }) => {
    toolCalls.push({ stepId: step.id, tool: step.tool, params });
    const result = toolBehavior(step.tool, params);
    toolResults.push(result.ok ? result.data : null);
    return result;
  });
}

/** Canned aps.* tool outputs shared by both branches. */
function apsToolBehavior(compareResult: {
  resolved: boolean;
  resolvedCount: number;
  unresolvedCount: number;
}): ToolBehavior {
  return (tool, params) => {
    switch (tool) {
      case 'aps.parseExceptionReport':
        return {
          ok: true,
          data: {
            sheetName: 'Exceptions',
            columns: ['Item', 'Order', 'Due'],
            rows: [{ Item: 'WIDGET-1', Order: 'SO-100', Due: '2026-10-10' }],
            rowCount: 1,
          },
        };
      case 'aps.normalizeExceptionRows':
        return {
          ok: true,
          data: {
            issues: [
              {
                rowIndex: 0,
                item: 'WIDGET-1',
                orderNumber: 'SO-100',
                dueDate: '2026-10-10',
                quantity: 10,
                exceptionText: 'Late supply',
              },
            ],
            truncated: false,
          },
        };
      case 'aps.collectSupplyFacts':
        return {
          ok: true,
          data: { facts: [{ rowIndex: 0, kind: 'supply', detail: 'PO-77 due 2026-10-12' }] },
        };
      case 'aps.collectDemandFacts':
        return {
          ok: true,
          data: { facts: [{ rowIndex: 0, kind: 'demand', detail: 'SO-100 line 1 due 2026-10-10' }] },
        };
      case 'aps.evaluateDueDates':
        return {
          ok: true,
          data: { facts: [{ rowIndex: 0, kind: 'due-date', detail: 'supply 2 days after demand' }] },
        };
      case 'aps.applyRules':
        return {
          ok: true,
          data: {
            findings: [
              { rowIndex: 0, ruleCode: 'RECEIPT_PROJECTED_LATE', severity: 'high', detail: 'PO late' },
            ],
          },
        };
      case 'aps.recordSnapshot':
        return {
          ok: true,
          data: { issueId: 'issue-1', snapshotId: 'snap-9', summary: '1 issue analyzed' },
        };
      case 'aps.compareSnapshots':
        return {
          ok: true,
          data: {
            resolved: compareResult.resolved,
            resolvedCount: compareResult.resolvedCount,
            unresolvedCount: compareResult.unresolvedCount,
            totalBaseline: 1,
            totalNew: 1,
            baselineSnapshotId: 'snap-9',
            details: 'compare done',
          },
        };
      case 'aps.closeIssue':
        // Fall-through-safe by design: resolved=false performs no state change.
        return { ok: true, data: { issueId: params.issueId, closed: params.resolved === true } };
      default:
        return { ok: true, data: null };
    }
  };
}

/** Valid JSON per agent step id for the analysis flow's four agent steps. */
function useFakeAgents(): void {
  overrideFlowAgentFn(async (args: FlowAgentCallArgs) => {
    switch (args.step.id) {
      case 'classify-exception':
        return JSON.stringify({
          classifications: [
            { rowIndex: 0, category: 'LATE_SUPPLY', severity: 'high', rationale: 'PO due after line due' },
          ],
        });
      case 'determine-root-cause':
        return JSON.stringify({
          rootCauses: [
            {
              rowIndex: 0,
              cause: 'PO-77 receipt projected 2 days after SO-100 line due date',
              confidence: 'high',
              evidence: 'supply fact PO-77 due 2026-10-12; demand SO-100 due 2026-10-10',
            },
          ],
        });
      case 'generate-recommendation':
        return JSON.stringify({
          recommendations: [
            {
              rowIndex: 0,
              action: 'Expedite PO-77',
              priority: 'p0',
              expectedImpact: 'moves receipt inside the line due date',
            },
          ],
        });
      case 'generate-syteline-steps':
        return JSON.stringify({
          steps: [
            {
              seq: 1,
              title: 'Review PO-77 dates',
              form: 'PurchaseOrders',
              action: 'Open PO-77 and review the promised date on the line',
              details: 'Confirm the vendor commit before expediting',
              verifyBy: 'PO line promised date reflects the new commit',
            },
          ],
        });
      default:
        return JSON.stringify({});
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function seedLiveFlow(name: string, fileName: string): Promise<void> {
  await createFlow(ADMIN_AUTH(), loadFlowFile(fileName));
  await publishVersion(TENANT, name, USER);
  const flow = await getFlow(TENANT, name);
  await setLiveAlias(TENANT, name, 1, flow!.revision);
}

async function seedBothFlows(): Promise<void> {
  await seedLiveFlow('aps-exception-analysis', ANALYSIS_FILE);
  await seedLiveFlow('aps-exception-verify', VERIFY_FILE);
}

async function runToEnd(
  flowName: string,
  inputs: Record<string, unknown> = {},
): Promise<FlowRunDoc> {
  const { run } = await createRun(ADMIN_AUTH(), flowName, { inputs }, 'INTERNAL');
  const claimed = await claimRun(TENANT, run._id, 'runner-1');
  expect(claimed).not.toBeNull();
  await runFlow(claimed!, {});
  return (await getRun(TENANT, run._id))!;
}

function stepStatus(run: FlowRunDoc, stepId: string): string | undefined {
  return run.steps.find((s) => s.stepId === stepId)?.status;
}

function toolCallsFor(stepId: string): Array<{ stepId: string; tool: string; params: Record<string, unknown> }> {
  return toolCalls.filter((c) => c.stepId === stepId);
}

// ---------------------------------------------------------------------------
// Schema drift guard
// ---------------------------------------------------------------------------

describe('aps exception flow definitions', () => {
  it('both flows/*.flow.json parse clean via flowDefinitionSchema', () => {
    const analysis = loadFlowFile(ANALYSIS_FILE);
    const verify = loadFlowFile(VERIFY_FILE);
    expect(analysis.name).toBe('aps-exception-analysis');
    expect(verify.name).toBe('aps-exception-verify');
    expect(analysis.steps).toHaveLength(11);
    expect(verify.steps).toHaveLength(6);
    // Verify flow ends on close-issue (the runner falls through after a
    // taken condition branch, so close-issue must be the last step).
    expect(verify.steps[verify.steps.length - 1]!.id).toBe('close-issue');
  });

  it('lifecycle: create → publish → v1 → live alias → getLiveDefinition, both flows', async () => {
    for (const [name, file] of [
      ['aps-exception-analysis', ANALYSIS_FILE],
      ['aps-exception-verify', VERIFY_FILE],
    ] as const) {
      await createFlow(ADMIN_AUTH(), loadFlowFile(file));
      const { version } = await publishVersion(TENANT, name, USER);
      expect(version.version).toBe(1);
      const stored = await getVersion(TENANT, name, 1);
      expect(stored).not.toBeNull();
      const flow = await getFlow(TENANT, name);
      await setLiveAlias(TENANT, name, 1, flow!.revision);
      const live = await getLiveDefinition(TENANT, name);
      expect(live).not.toBeNull();
      expect(live!.version).toBe(1);
      expect(live!.definition.name).toBe(name);
    }
  });
});

// ---------------------------------------------------------------------------
// Verify flow: RESOLVED branch
// ---------------------------------------------------------------------------

describe('aps-exception-verify: resolved branch', () => {
  it('closes the issue and skips reanalyze when the compare resolves', async () => {
    useFakeTools(apsToolBehavior({ resolved: true, resolvedCount: 1, unresolvedCount: 0 }));
    useFakeAgents();
    await seedBothFlows();

    const run = await runToEnd('aps-exception-verify', {
      issueId: 'issue-1',
      newReportDocumentId: 'doc-2',
      site: '01',
    });

    expect(run.status).toBe('completed');
    // close-issue ran with the real boolean resolved=true.
    const closeCalls = toolCallsFor('close-issue');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.params).toMatchObject({ issueId: 'issue-1', resolved: true });
    // The mock closeIssue closed the issue on resolved=true.
    const closeIdx = toolCalls.findIndex((c) => c.stepId === 'close-issue');
    expect(toolResults[closeIdx]).toMatchObject({ issueId: 'issue-1', closed: true });
    // The then-branch jumps forward over reanalyze.
    expect(stepStatus(run, 'reanalyze')).toBe('skipped');
    expect(stepStatus(run, 'close-issue')).toBe('ok');
    // No analysis-subflow tools ran in this branch.
    expect(toolCalls.some((c) => c.tool === 'aps.recordSnapshot')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Verify flow: NOT-RESOLVED branch
// ---------------------------------------------------------------------------

describe('aps-exception-verify: not-resolved branch', () => {
  it('re-analyzes via subflow, then close-issue no-ops on resolved=false', async () => {
    useFakeTools(apsToolBehavior({ resolved: false, resolvedCount: 0, unresolvedCount: 1 }));
    useFakeAgents();
    await seedBothFlows();

    const run = await runToEnd('aps-exception-verify', {
      issueId: 'issue-1',
      newReportDocumentId: 'doc-2',
      site: '01',
    });

    expect(run.status).toBe('completed');
    // The else-branch ran the analysis flow as a subflow: its tool steps
    // executed with the new report wired through as the analysis input.
    expect(stepStatus(run, 'reanalyze')).toBe('ok');
    const snapshotCalls = toolCalls.filter((c) => c.tool === 'aps.recordSnapshot');
    expect(snapshotCalls).toHaveLength(1);
    expect(snapshotCalls[0]!.params).toMatchObject({
      issueId: 'issue-1',
      reportDocumentId: 'doc-2',
      site: '01',
    });
    // All four agent steps of the subflow produced schema-valid output.
    expect(stepStatus(run, 'close-issue')).toBe('ok');
    // Falls through into close-issue, which no-ops on resolved=false.
    const closeCalls = toolCallsFor('close-issue');
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0]!.params).toMatchObject({ issueId: 'issue-1', resolved: false });
    // The issue is still open: the tool performed no state change.
    const closeIdx = toolCalls.findIndex((c) => c.stepId === 'close-issue');
    expect(toolResults[closeIdx]).toMatchObject({ issueId: 'issue-1', closed: false });
    expect(run.status).toBe('completed');
  });
});
