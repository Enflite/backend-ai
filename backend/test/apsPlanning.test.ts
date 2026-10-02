/**
 * apsPlanning.test.ts — unit tests for the APS Planning Agent's domain
 * foundation (types, column mapping, identity keys, compare verdicts,
 * procedure honesty, knowledge-pack sync, judgment builders).
 *
 * VALIDATED IN CI (vitest). The substrate seam (sibling's unlanded
 * pipeline) is mocked in apsPlanningRoutes.test.ts, not here.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  columnMapSchema,
  compareSnapshots,
  issueIdentityKey,
  EXCEPTION_TYPES,
  type PlanningRow,
} from '../src/apsPlanning/types.js';
import {
  getProcedureGuidance,
  allProcedureGuidance,
} from '../src/apsPlanning/procedures.js';
import {
  APS_PLANNING_KNOWLEDGE,
  APS_PLANNING_KNOWLEDGE_VERSION,
} from '../src/apsPlanning/knowledge.js';
import {
  buildExplainRequest,
  buildPrioritizeRequest,
  buildRecommendRequest,
} from '../src/apsPlanning/agentJudgment.js';

const here = dirname(fileURLToPath(import.meta.url));
const docPath = join(here, '..', '..', 'docs', 'aps-planning-knowledge.md');

/** Anchor phrases that must appear in BOTH the pack and the doc. */
const SYNC_ANCHORS = [
  'Move In Rcpt',
  'Move Out Rcpt',
  'Rcpt Not Needed',
  'Rcpt Projected Late',
  'Expedited N Days',
  'supply-usage tolerance',
  'PLN projected dates',
  'FIRMING a PLN order',
  'Never invent SyteLine records or procedures',
  'needsConfirmation',
];

describe('APS planning types', () => {
  it('defines the five V1 exception types', () => {
    expect([...EXCEPTION_TYPES]).toEqual([
      'MOVE_IN_RCPT',
      'MOVE_OUT_RCPT',
      'RCPT_NOT_NEEDED',
      'RCPT_PROJECTED_LATE',
      'EXPEDITED_N_DAYS',
    ]);
  });

  it('column map requires item + exceptionText', () => {
    const ok = columnMapSchema.safeParse({
      columns: { item: 'Item', exceptionText: 'Exception Message' },
      confirmed: true,
    });
    expect(ok.success).toBe(true);
    const missing = columnMapSchema.safeParse({
      columns: { item: 'Item' },
      confirmed: true,
    });
    expect(missing.success).toBe(false);
  });
});

describe('issueIdentityKey', () => {
  it('prefers type|item|supplyId|demandId', () => {
    const key = issueIdentityKey({
      type: 'RCPT_PROJECTED_LATE',
      item: 'WIDGET-1',
      supplyId: 'PO-100',
      demandId: 'SO-1-1',
    });
    expect(key).toBe('rcpt_projected_late|widget-1|po-100|so-1-1');
  });

  it('falls back to the sibling composite key when the primary is thin', () => {
    const key = issueIdentityKey({
      item: 'WIDGET-1',
      orderNumber: 'SO-5',
      workOrderNumber: 'WO-9',
      dueDate: '2026-10-09',
    });
    expect(key).toBe('sibling:widget-1|so-5|wo-9|2026-10-09');
  });

  it('falls back to rowIndex as a last resort', () => {
    expect(issueIdentityKey({ rowIndex: 7 })).toBe('row:7');
  });

  it('yields the empty key for a fully-empty row (unmatchable)', () => {
    expect(issueIdentityKey({})).toBe('');
  });

  it('normalizes case and whitespace', () => {
    const a = issueIdentityKey({ type: 'MOVE_IN_RCPT', item: ' Widget-1 ', supplyId: 'PO-1' });
    const b = issueIdentityKey({ type: 'MOVE_IN_RCPT', item: 'widget-1', supplyId: 'po-1' });
    expect(a).toBe(b);
  });
});

describe('compareSnapshots', () => {
  const row = (over: Partial<PlanningRow>): PlanningRow => over;

  it('emits resolved / still-open / worsened / new with a summary', () => {
    const base: PlanningRow[] = [
      row({ type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', demandId: 'SO-1', severity: 'high' }),
      row({ type: 'MOVE_IN_RCPT', item: 'B', supplyId: 'PO-2', demandId: 'SO-2', severity: 'medium' }),
      row({ type: 'RCPT_NOT_NEEDED', item: 'C', supplyId: 'PO-3', demandId: 'SO-3', severity: 'low' }),
    ];
    const other: PlanningRow[] = [
      // A: severity rose high -> critical => worsened
      row({ type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', demandId: 'SO-1', severity: 'critical' }),
      // B: unchanged => still-open
      row({ type: 'MOVE_IN_RCPT', item: 'B', supplyId: 'PO-2', demandId: 'SO-2', severity: 'medium' }),
      // D: brand new
      row({ type: 'EXPEDITED_N_DAYS', item: 'D', supplyId: 'PO-4', demandId: 'SO-4', severity: 'low' }),
    ];
    const cmp = compareSnapshots('snap-base', 'snap-other', base, other);
    expect(cmp.baseSnapshotId).toBe('snap-base');
    expect(cmp.otherSnapshotId).toBe('snap-other');
    const byKey = new Map(cmp.rows.map((r) => [r.key, r.verdict]));
    expect(byKey.get('rcpt_projected_late|a|po-1|so-1')).toBe('worsened');
    expect(byKey.get('move_in_rcpt|b|po-2|so-2')).toBe('still-open');
    expect(byKey.get('rcpt_not_needed|c|po-3|so-3')).toBe('resolved');
    expect(byKey.get('expedited_n_days|d|po-4|so-4')).toBe('new');
    expect(cmp.summary).toEqual({ resolved: 1, stillOpen: 1, worsened: 1, new: 1 });
  });

  it('treats growing daysLate evidence as worsened', () => {
    const base = [row({ type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', evidence: { daysLate: 3 } })];
    const other = [row({ type: 'RCPT_PROJECTED_LATE', item: 'A', supplyId: 'PO-1', evidence: { daysLate: 9 } })];
    const cmp = compareSnapshots('b', 'o', base, other);
    expect(cmp.rows[0]!.verdict).toBe('worsened');
    expect(cmp.rows[0]!.reason).toMatch(/daysLate/i);
  });

  it('never drops unmatchable rows: they surface as new', () => {
    const cmp = compareSnapshots('b', 'o', [], [row({ exceptionText: '???' })]);
    expect(cmp.rows).toHaveLength(1);
    expect(cmp.rows[0]!.verdict).toBe('new');
    expect(cmp.rows[0]!.key).toBe('');
  });

  it('matches across the sibling-key fallback', () => {
    const base = [row({ item: 'W-1', orderNumber: 'SO-5', dueDate: '2026-10-09' })];
    const other = [row({ item: 'W-1', orderNumber: 'SO-5', dueDate: '2026-10-09', severity: 'high' })];
    const cmp = compareSnapshots('b', 'o', base, other);
    expect(cmp.rows).toHaveLength(1);
    expect(cmp.rows[0]!.verdict).toBe('still-open');
  });
});

describe('procedure guidance honesty', () => {
  it('ships every V1 procedure unverified with needsConfirmation', () => {
    const all = allProcedureGuidance();
    expect(Object.keys(all)).toHaveLength(5);
    for (const type of EXCEPTION_TYPES) {
      const proc = getProcedureGuidance(type);
      expect(proc.verified, type).toBe(false);
      expect(proc.needsConfirmation, type).toBeTruthy();
      expect(proc.steps.length).toBeGreaterThan(0);
    }
  });

  it('never names a tab, field, or button as a click-path', () => {
    // Heuristic guard: procedure steps must not read like UI instructions
    // ("click", "press", "tab", "button", "field" as an action target).
    const clicky = /\b(click|press the|select the tab|in the .* tab,|button)\b/i;
    for (const type of EXCEPTION_TYPES) {
      for (const step of getProcedureGuidance(type).steps) {
        expect(step, `${type}: ${step}`).not.toMatch(clicky);
      }
    }
  });
});

describe('APS planning knowledge pack', () => {
  it('is versioned', () => {
    expect(APS_PLANNING_KNOWLEDGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('covers the five exception types and the core semantics', () => {
    for (const anchor of SYNC_ANCHORS) {
      expect(APS_PLANNING_KNOWLEDGE, `pack missing: ${anchor}`).toContain(anchor);
    }
  });

  it('contains no tenant data, secrets, or endpoint details', () => {
    expect(APS_PLANNING_KNOWLEDGE).not.toMatch(/sk-live-[A-Za-z0-9]+/);
    expect(APS_PLANNING_KNOWLEDGE).not.toMatch(/-----BEGIN (RSA )?PRIVATE KEY-----/);
    expect(APS_PLANNING_KNOWLEDGE).not.toMatch(/https?:\/\//);
  });

  it('stays in sync with docs/aps-planning-knowledge.md', () => {
    const doc = readFileSync(docPath, 'utf8');
    for (const anchor of SYNC_ANCHORS) {
      expect(doc, `doc missing anchor: ${anchor}`).toContain(anchor);
    }
  });
});

describe('agent judgment builders (aggregates only)', () => {
  const summary = { id: 'ISS-1', type: 'RCPT_PROJECTED_LATE', severity: 'high' as const, item: 'WIDGET-1', daysLate: 4 };

  it('buildExplainRequest carries the summary, not raw rows', () => {
    const req = buildExplainRequest(summary, ['promisedDate', 'dueDate']);
    expect(req.judgmentRef).toBe('aps-explain');
    expect(req.schema.safeParse({ explanation: 'x', keyEvidence: ['a'] }).success).toBe(true);
    // The user message embeds exactly the validated summary shape.
    expect(req.userMessage).toContain('"id":"ISS-1"');
    expect(req.userMessage).not.toContain('exceptionText');
  });

  it('buildPrioritizeRequest bounds the batch', () => {
    const req = buildPrioritizeRequest([summary]);
    expect(req.judgmentRef).toBe('aps-prioritize');
    expect(() => buildPrioritizeRequest([])).toThrow();
    expect(() => buildPrioritizeRequest(new Array(201).fill(summary))).toThrow();
  });

  it('buildRecommendRequest validates recommendation shapes', () => {
    const req = buildRecommendRequest([summary]);
    expect(req.judgmentRef).toBe('aps-recommend');
    expect(
      req.schema.safeParse({
        recommendations: [{ action: 'Expedite PO-1', priority: 'p0', expectedImpact: 'Covers the due date' }],
      }).success,
    ).toBe(true);
    expect(
      req.schema.safeParse({ recommendations: [{ action: 'x', priority: 'p9', expectedImpact: 'y' }] }).success,
    ).toBe(false);
  });
});
