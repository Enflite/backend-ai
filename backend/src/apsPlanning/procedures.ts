/**
 * procedures.ts — SyteLine procedure guidance for the five V1 exception
 * types.
 *
 * HARD RULES (non-negotiable):
 * - `verified` defaults to FALSE. A procedure is `verified: true` only
 *   when every step is sourced from validated documentation.
 * - Anything not sourced ships with `needsConfirmation` text naming
 *   exactly what the planner must confirm in their SyteLine client.
 * - NEVER invent a form, tab, field, button, or workflow. Form names used
 *   here come only from the repo's validated vocabulary
 *   (sytelineExpertKnowledge.ts VOCABULARY + the sibling flow prompts'
 *   known-forms list): Material Planner Workbench, Order Action Report,
 *   Planning Detail, Demand Detail - Scheduler, Material Allocation,
 *   CustomerOrders, PurchaseOrders, Purchase Order Lines, Job Orders,
 *   Job Materials. Tabs, fields, buttons, and click-paths are NOT in the
 *   validated sources — so they are never stated, only pointed at for
 *   confirmation.
 */

import type { ExceptionType } from './types.js';
import type { SyteLineProcedure } from './types.js';

/**
 * Build a procedure, enforcing the honesty invariant: an unverified
 * procedure MUST carry needsConfirmation text. Throws when violated —
 * callers cannot accidentally ship an unmarked procedure.
 */
function buildProcedure(input: {
  form?: string;
  steps: string[];
  verified: boolean;
  needsConfirmation?: string;
}): SyteLineProcedure {
  if (!input.verified && (!input.needsConfirmation || input.needsConfirmation.trim() === '')) {
    throw new Error('Unverified SyteLine procedures must carry needsConfirmation text');
  }
  return {
    ...(input.form ? { form: input.form } : {}),
    steps: input.steps,
    verified: input.verified,
    ...(input.needsConfirmation ? { needsConfirmation: input.needsConfirmation } : {}),
  };
}

/**
 * Procedure guidance per V1 exception type.
 *
 * V1 status (2026-10-02): no step-by-step SyteLine procedure for these
 * exception types has been validated against documentation yet, so every
 * entry ships `verified: false` with confirmation text. The steps are
 * planner reasoning grounded in the APS knowledge pack (what to check,
 * what to decide) — never a click-path.
 */
const PROCEDURE_GUIDANCE: Record<ExceptionType, SyteLineProcedure> = {
  MOVE_IN_RCPT: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Read the row: which demand is at risk (item, demand id, due date, quantity) and which supply APS wants sooner (supply id, current projected date).',
      'Check the supply record: for a PO, compare the promised date to today and the quantity received to the quantity ordered — a late PO, not the shop floor, is the usual culprit. For a job, Released but not Complete means behind; a PLN record is not even firmed yet.',
      'Decide the planner move: expedite the supply (vendor follow-up for POs; shop-floor priority for jobs) or, when the demand can move, pull the demand later.',
      'After acting, confirm on the next APS run that the supply projected date moved inside the demand due date.',
    ],
    verified: false,
    needsConfirmation:
      'Confirm the expedite/reschedule mechanics in your SyteLine client — the exact fields for changing a PO promise date or job schedule dates vary by SyteLine version and tenant setup.',
  }),
  MOVE_OUT_RCPT: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Read the row: which supply APS wants later (supply id, item, quantity, current projected date) and confirm no demand actually needs it early — check the demand dates the supply is allocated to.',
      'Decide the planner move: de-expedite / push the supply out to free cash and space, or pull a demand in to consume the early supply.',
      'Watch for priority switching: APS allocates by priority, so moving this supply can displace another demand — re-check the next exception report.',
    ],
    verified: false,
    needsConfirmation:
      'Confirm the de-expedite / reschedule-out mechanics in your SyteLine client — the exact fields vary by SyteLine version and tenant setup.',
  }),
  RCPT_NOT_NEEDED: buildProcedure({
    form: 'Order Action Report',
    steps: [
      'Verify the demand picture first: a missing demand row can be a data issue (bad dates, unknown item, stale status), not a real surplus. Do not cancel on a data artifact.',
      'When the surplus is real, decide: cancel the scheduled receipt or reallocate it to another demand that needs it.',
      'Weigh cancellation costs and lead times before cancelling — a cancelled PO that must be re-placed later can cost more than holding the receipt.',
    ],
    verified: false,
    needsConfirmation:
      'Confirm the cancellation procedure in your SyteLine client — cancelling a PO line and closing a job follow different steps, and the exact screens vary by SyteLine version.',
  }),
  RCPT_PROJECTED_LATE: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Quantify the gap: supply projected date vs demand due date, in days, and which customer commit is at risk.',
      'For purchased items: check the PO promised date vs today and quantity received vs ordered; follow up with the vendor on the shortfall.',
      'For manufactured items: the job is behind — check Released-not-Complete operations, then explode the BOM and check each component for its own shortage.',
      'Decide the recovery: expedite, find alternate supply, partial-ship what is available, or renegotiate the commit date — in that order of preference.',
      'After acting, confirm on the next APS run that the projected date moved inside the due date.',
    ],
    verified: false,
    needsConfirmation:
      'Confirm the expedite and reschedule mechanics in your SyteLine client — the exact fields for PO promise dates and job schedule dates vary by SyteLine version and tenant setup.',
  }),
  EXPEDITED_N_DAYS: buildProcedure({
    form: 'Planning Detail',
    steps: [
      'Read the row: APS already moved the supply earlier by N days — confirm the new projected date actually covers the demand due date.',
      'Check what the expedite displaced: APS switches supply between demands by priority, so verify no other demand lost its cover.',
      'When the demand is covered and nothing was displaced, this is a watch item — no planner action needed. Re-check on the next report.',
    ],
    verified: false,
    needsConfirmation:
      'Confirm how your SyteLine client surfaces expedite history for the supply record — the exact inquiry screens vary by version.',
  }),
};

/** Procedure guidance for one V1 exception type (verified=false until validated). */
export function getProcedureGuidance(type: ExceptionType): SyteLineProcedure {
  return PROCEDURE_GUIDANCE[type];
}

/** All five V1 procedures (for docs/tests). */
export function allProcedureGuidance(): Record<ExceptionType, SyteLineProcedure> {
  return { ...PROCEDURE_GUIDANCE };
}
