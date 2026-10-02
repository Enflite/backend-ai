/**
 * flow.ts — the SyteLine Form AI Agent's customization pipeline as a
 * declarative, config-as-code flow definition.
 *
 * This module is PURE DATA: step names, kinds, declared inputs/outputs,
 * blocked semantics, and string refs into the registries in steps.ts. No
 * code is interleaved — a future Flows platform can consume this
 * definition mechanically (schema / registry / versioning / API), and
 * this module is its reference implementation and first consumer.
 *
 * The runner (flowRunner.ts) enforces the declared contracts: a step
 * runs only when its inputs exist, and a `done` step must produce its
 * declared outputs.
 *
 * Pipeline: intake → validate-inputs → backup-originals (FormSync
 * backup) → compare-trn-prd → plan-changes (agent judgment) →
 * apply-changes-trn → verify → open-pr (human review).
 */

import { FORM_CUSTOMIZATION_FLOW_VERSION } from './version.js';

export type FlowStepKind = 'deterministic' | 'agentJudgment';

export interface FlowStepDef {
  name: string;
  kind: FlowStepKind;
  /** Human-readable step title. */
  title: string;
  /** Values keys the step reads (must exist before the step runs). */
  inputs: string[];
  /** Values keys the step writes (must exist after a `done` step). */
  outputs: string[];
  /** Declared blocked semantics: enumerated codes this step may produce. */
  blockedReasons: { code: string; when: string }[];
  /** Key into the STEP_HANDLERS registry (steps.ts). */
  handlerRef: string;
  /** agentJudgment steps: key into PROMPT_BUILDERS (steps.ts). */
  promptRef?: string;
  /** agentJudgment steps: key into SCHEMAS (steps.ts). */
  schemaRef?: string;
}

export interface FlowPrecondition {
  /** Key into PRECONDITION_CHECKS (steps.ts). */
  checkRef: string;
  title: string;
  blockedCode: string;
  blockedDetail: string;
}

export interface FlowDefinition {
  name: string;
  version: string;
  description: string;
  preconditions: FlowPrecondition[];
  steps: FlowStepDef[];
}

export const FORM_CUSTOMIZATION_FLOW: FlowDefinition = {
  name: 'syteline-form-customization',
  version: FORM_CUSTOMIZATION_FLOW_VERSION,
  description:
    'Turn the five customization inputs (form XML, IDO properties CSV, SQL columns CSV, ' +
    'instructions, attachments) into a form project and a review PR, following the ' +
    'Form-Project-Templates SOP. TRN-first, backup-first, PRs never auto-merged.',
  preconditions: [
    {
      checkRef: 'requester-holds-forms-permission',
      title: 'The requester still holds the form-customization permission',
      blockedCode: 'requester-lost-permission',
      blockedDetail:
        'The requester no longer has the form-customization permission, so the SyteLine Form AI Agent stopped.',
    },
    {
      checkRef: 'github-available',
      title: 'GitHub is reachable for the review PR',
      blockedCode: 'missing-github-token',
      blockedDetail:
        'No GitHub access is configured (gh CLI or GITHUB_TOKEN), so the SyteLine Form AI Agent cannot open the review PR. ' +
        'Set GITHUB_TOKEN with repo and PR access and re-submit the request.',
    },
  ],
  steps: [
    {
      name: 'intake',
      kind: 'deterministic',
      title: 'Intake: validate the five inputs and stage them',
      inputs: [
        'request.formName',
        'request.title',
        'request.instructions',
        'input.formXml',
        'input.idoCsv',
        'input.sqlCsv',
        'input.attachments',
      ],
      outputs: ['inbox.dir', 'inbox.hasPrdOriginal'],
      blockedReasons: [],
      handlerRef: 'intake',
    },
    {
      name: 'validate-inputs',
      kind: 'deterministic',
      title: 'Validate inputs: malware scan, XML and CSV shapes',
      inputs: ['inbox.dir'],
      outputs: ['validated.formName'],
      blockedReasons: [
        { code: 'missing-current-form-xml', when: 'input 1 was not supplied or failed validation' },
        { code: 'attachment-quarantined', when: 'an uploaded part tripped the malware boundary' },
        { code: 'invalid-requirements', when: 'the CSVs or instructions are unusable' },
      ],
      handlerRef: 'validate-inputs',
    },
    {
      name: 'backup-originals',
      kind: 'deterministic',
      title: 'FormSync backup: scaffold the project, record TRN + production originals',
      inputs: ['inbox.dir', 'validated.formName'],
      outputs: ['project.dir', 'originals.trnFile', 'originals.prdFile', 'originals.sha256Prefix'],
      blockedReasons: [
        {
          code: 'missing-production-original',
          when: 'no production FormSync export was supplied (attach it as *.production.original.xml)',
        },
      ],
      handlerRef: 'backup-originals',
    },
    {
      name: 'compare-trn-prd',
      kind: 'deterministic',
      title: 'Compare the TRN and production originals',
      inputs: ['originals.trnFile', 'originals.prdFile'],
      outputs: ['drift.checked'],
      blockedReasons: [
        { code: 'trn-prd-drift', when: 'the TRN and production originals differ' },
      ],
      handlerRef: 'compare-trn-prd',
    },
    {
      name: 'plan-changes',
      kind: 'agentJudgment',
      title: 'Plan the customization (agent judgment)',
      inputs: ['validated.formName', 'originals.trnFile', 'inbox.dir'],
      outputs: ['plan'],
      blockedReasons: [
        { code: 'invalid-requirements', when: 'the instructions could not be turned into a plan' },
      ],
      handlerRef: 'plan-changes',
      promptRef: 'plan-changes',
      schemaRef: 'customization-plan',
    },
    {
      name: 'apply-changes-trn',
      kind: 'deterministic',
      title: 'Apply the changes: build <Form>.xml from the TRN original',
      inputs: ['plan', 'originals.trnFile', 'project.dir'],
      outputs: ['build.formXmlFile', 'build.components'],
      blockedReasons: [],
      handlerRef: 'apply-changes-trn',
    },
    {
      name: 'verify',
      kind: 'deterministic',
      title: 'Verify: deterministic rebuild check, docs, deck',
      inputs: ['build.formXmlFile', 'project.dir', 'plan'],
      outputs: ['artifacts.docs', 'artifacts.deck', 'verify.rebuildOk'],
      blockedReasons: [
        { code: 'build-check-failed', when: "the build script's deterministic-rebuild check failed" },
      ],
      handlerRef: 'verify',
    },
    {
      name: 'open-pr',
      kind: 'deterministic',
      title: 'Open the review PR (never merge)',
      inputs: ['project.dir', 'plan', 'artifacts.docs'],
      outputs: ['pr.url', 'pr.repo'],
      blockedReasons: [],
      handlerRef: 'open-pr',
    },
  ],
};
