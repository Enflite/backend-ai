/**
 * procedures.ts — SyteLine procedure guidance for the five V1 exception
 * types.
 *
 * SOURCING: every `verified: true` procedure below is distilled from the
 * APS planning materials the planner supplied on 2026-09-22 — the
 * "SyteLine Fundamentals of APS" and "Using APS in Procurement" training
 * workbooks, the APS procurement training transcript, the three planning
 * flowcharts, a live Exception Report export, and the planner's
 * Daily_Tasks_Planning SOP. The pack DISTILLS these sources (it never
 * reproduces their text).
 *
 * HONESTY RULES (non-negotiable):
 * - `verified: true` means every step traces to those sources. Anything
 *   not sourced ships `verified: false` with `needsConfirmation` text
 *   naming exactly what the planner must confirm in their SyteLine
 *   client (the `buildProcedure` guard enforces this invariant).
 * - Even verified procedures keep `needsConfirmation` for the exact
 *   field-level mechanics, which vary by SyteLine version and tenant
 *   setup and are not validated at the click level.
 * - NEVER invent a form, tab, field, button, or workflow. Steps describe
 *   planner reasoning grounded in the knowledge pack (what to check,
 *   what to decide) — never a click-path.
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
 * Sourced 2026-10-02 from the planner's APS training materials
 * (2026-09-22): every procedure is `verified: true`. The `steps` are
 * planner reasoning (read the row, check the record, check the
 * parameters, decide the move, confirm on the next run); exact
 * field-level mechanics stay behind `needsConfirmation` because they
 * vary by SyteLine version and tenant setup.
 */
const PROCEDURE_GUIDANCE: Record<ExceptionType, SyteLineProcedure> = {
  MOVE_IN_RCPT: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Read the exception row: item, the supply APS wants sooner (PO, job, or PLN), the demand it covers (order line or job operation), the due date, and the Exception Code on the report.',
      'Check the supply record: for a PO, compare the promised date to today and the quantity received to the quantity ordered — a late PO, not the shop floor, is the usual culprit. For a job, Released but not Complete means behind; a PLN record is not even firmed yet.',
      'Check the parameters before chasing the row: on the Planning Parameters form, the PO In reschedule tolerance fires Move In Rcpt when a PO is scheduled or rescheduled that many days or fewer before the demand due date — and values on the Product Codes form override it.',
      'Decide the planner move: expedite the supply (vendor follow-up for POs; shop-floor priority for jobs) or, when the demand can move, pull the demand later.',
      'After acting, confirm on the next APS run that the supply projected date moved inside the demand due date.',
    ],
    verified: true,
    needsConfirmation:
      'Confirm the expedite/reschedule mechanics in your SyteLine client — the exact fields for changing a PO promise date or job schedule dates vary by SyteLine version and tenant setup.',
  }),
  MOVE_OUT_RCPT: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Read the exception row: the supply APS wants later (PO, job, or PLN), item, quantity, current projected date, and the suggested target date on the message (code 14 carries it).',
      'Confirm no demand actually needs the supply early — check the demand dates the supply is allocated to before moving anything.',
      'Check the parameters: on the Planning Parameters form, the PO Out reschedule tolerance fires Move Out Rcpt when a PO is scheduled that many days or more before the demand due date — and values on the Product Codes form override it.',
      'Decide the planner move: de-expedite / push the supply out to free cash and space, or pull a demand in to consume the early supply.',
      'Watch for priority switching: APS allocates by priority, so moving this supply can displace another demand — re-check the next exception report.',
    ],
    verified: true,
    needsConfirmation:
      'Confirm the de-expedite / reschedule-out mechanics in your SyteLine client — the exact fields vary by SyteLine version and tenant setup.',
  }),
  RCPT_NOT_NEEDED: buildProcedure({
    form: 'Order Action Report',
    steps: [
      'Verify the demand picture first: a missing demand row can be a data issue (bad dates, unknown item, stale status), not a real surplus. Do not cancel on a data artifact.',
      'When the surplus is real, review and remove the unnecessary receipt per the procurement cadence — the exception report is the daily PO-management tool.',
      'Decide: cancel the scheduled receipt or reallocate it to another demand that needs it.',
      'Weigh cancellation costs and lead times before cancelling — a cancelled PO that must be re-placed later can cost more than holding the receipt.',
    ],
    verified: true,
    needsConfirmation:
      'Confirm the cancellation procedure in your SyteLine client — cancelling a PO line and closing a job follow different steps, and the exact screens vary by SyteLine version.',
  }),
  RCPT_PROJECTED_LATE: buildProcedure({
    form: 'Material Planner Workbench',
    steps: [
      'Quantify the gap: supply projected date vs demand due date, in days (the message carries the N), and name which customer commit is at risk.',
      'For purchased items: check the PO promised date vs today and quantity received vs ordered; follow up with the vendor on the shortfall. For a demand-side message (code 6, Rqmt Projected Late), the demand — not the supply — is the late one.',
      'For manufactured items: the job is behind — check Released-not-Complete operations, then use Component Shortage APS to find jobs missing components and explode the BOM for each component’s own shortage.',
      'Decide the recovery in order: expedite, find alternate supply (Alternate Group on Current Materials, or Use Latest Pull for Alternate Items), partial-ship what is available, or renegotiate the commit date.',
      'After acting, confirm on the next APS run that the projected date moved inside the due date.',
    ],
    verified: true,
    needsConfirmation:
      'Confirm the expedite and reschedule mechanics in your SyteLine client — the exact fields for PO promise dates and job schedule dates vary by SyteLine version and tenant setup.',
  }),
  EXPEDITED_N_DAYS: buildProcedure({
    form: 'Planning Detail',
    steps: [
      'Read the row: APS already moved the supply earlier by N days (code 17) — confirm the new projected date actually covers the demand due date.',
      'Check what the expedite displaced: APS switches supply between demands by priority, so verify no other demand lost its cover.',
      'When the demand is covered and nothing was displaced, this is a watch item — no planner action needed. Re-check on the next report.',
    ],
    verified: true,
    needsConfirmation:
      'Confirm how your SyteLine client surfaces expedite history for the supply record — the exact inquiry screens vary by version.',
  }),
};

/** Procedure guidance for one V1 exception type. */
export function getProcedureGuidance(type: ExceptionType): SyteLineProcedure {
  return PROCEDURE_GUIDANCE[type];
}

/** All five V1 procedures (for docs/tests). */
export function allProcedureGuidance(): Record<ExceptionType, SyteLineProcedure> {
  return { ...PROCEDURE_GUIDANCE };
}
