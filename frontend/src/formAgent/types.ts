/**
 * formAgent/types.ts — frontend types for the SyteLine Form AI Agent
 * product surface (`/api/v1/form-customizations`, backend PR #55).
 *
 * Shapes mirror the backend's public views (backend/src/formAgent/types.ts:
 * publicListItem / publicDetailView). The eight pipeline steps mirror the
 * declarative flow definition (backend/src/formAgent/flow.ts).
 */

export type FormCustomizationStatus =
  | 'requested'
  | 'in_progress'
  | 'awaiting_review'
  | 'completed'
  | 'blocked'
  | 'cancelled';

export type FlowStepStatus = 'pending' | 'running' | 'done' | 'failed';

export interface FormCustomizationListItem {
  id: string;
  status: FormCustomizationStatus;
  formName: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

export interface FlowStepLog {
  name: string;
  status: FlowStepStatus;
  detail?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface CustomizationEvidence {
  formXml: string;
  deck: string;
  inputs: { formXml: string; idoPropertiesCsv: string; sqlColumnsCsv: string };
  originals: { trn: string; prd: string; sha256Prefix: string };
  openItems: string[];
  assumptions: string[];
}

export interface FormCustomizationDetail {
  id: string;
  status: FormCustomizationStatus;
  formName: string;
  title: string;
  requestedBy?: string;
  product: { name: string; version: string };
  flow: { name: string; version: string };
  steps: FlowStepLog[];
  resultSummary?: string;
  evidence?: CustomizationEvidence;
  prUrl?: string;
  repoUrl?: string;
  blockedReason?: string;
  blockedDetail?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export interface CreateCustomizationAccepted {
  id: string;
  status: FormCustomizationStatus;
  formName: string;
  createdAt: string;
  product: { name: string; version: string };
}

/** The eight pipeline steps, in order (backend flow.ts). */
export interface PipelineStepDef {
  name: string;
  title: string;
  shortLabel: string;
}

export const PIPELINE_STEPS: PipelineStepDef[] = [
  { name: 'intake', title: 'Intake: validate the five inputs and stage them', shortLabel: 'Intake' },
  { name: 'validate-inputs', title: 'Validate inputs: malware scan, XML and CSV shapes', shortLabel: 'Validate inputs' },
  { name: 'backup-originals', title: 'FormSync backup: scaffold the project, record TRN + production originals', shortLabel: 'FormSync backup' },
  { name: 'compare-trn-prd', title: 'Compare the TRN and production originals', shortLabel: 'Compare TRN / production' },
  { name: 'plan-changes', title: 'Plan the customization (agent judgment)', shortLabel: 'Plan changes' },
  { name: 'apply-changes-trn', title: 'Apply the changes: build the form XML from the TRN original', shortLabel: 'Apply changes (TRN)' },
  { name: 'verify', title: 'Verify: deterministic rebuild check, docs, deck', shortLabel: 'Verify' },
  { name: 'open-pr', title: 'Open the review PR (never merge)', shortLabel: 'Open review PR' },
];

const STATUS_META: Record<FormCustomizationStatus, { label: string; color: string; bg: string }> = {
  requested: { label: 'Requested', color: '#4a4a4a', bg: '#f0f0f0' },
  in_progress: { label: 'In progress', color: '#1d4ed8', bg: '#dbeafe' },
  awaiting_review: { label: 'Awaiting review', color: '#b45309', bg: '#fef3c7' },
  completed: { label: 'Completed', color: '#15803d', bg: '#dcfce7' },
  blocked: { label: 'Blocked', color: '#a50a24', bg: '#fee2e2' },
  cancelled: { label: 'Cancelled', color: '#6b7280', bg: '#f3f4f6' },
};

export function statusMeta(status: FormCustomizationStatus): { label: string; color: string; bg: string } {
  return STATUS_META[status] ?? { label: status, color: '#4a4a4a', bg: '#f0f0f0' };
}

export function isTerminalStatus(status: FormCustomizationStatus): boolean {
  return status === 'awaiting_review' || status === 'completed' || status === 'blocked' || status === 'cancelled';
}

/** Friendly titles for the backend's enumerated blocked reasons. */
const BLOCKED_TITLES: Record<string, string> = {
  'missing-current-form-xml': 'Current form XML missing or invalid',
  'missing-production-original': 'Production original missing',
  'trn-prd-drift': 'TRN / production drift detected',
  'missing-github-token': 'GitHub access not configured',
  'invalid-requirements': 'Requirements unusable',
  'attachment-quarantined': 'Attachment quarantined',
  'build-check-failed': 'Build check failed',
  'requester-lost-permission': 'Permission revoked mid-run',
};

export function blockedTitle(code: string | undefined): string {
  if (!code) return 'Blocked';
  return BLOCKED_TITLES[code] ?? code;
}

/**
 * Merge the canonical eight pipeline steps with the live step log from
 * the detail view: every canonical step is shown, overlaid with its live
 * status when the backend has reported it.
 */
export function mergeSteps(live: FlowStepLog[]): Array<PipelineStepDef & { live?: FlowStepLog }> {
  const byName = new Map(live.map((s) => [s.name, s]));
  return PIPELINE_STEPS.map((def) => ({ ...def, live: byName.get(def.name) }));
}
