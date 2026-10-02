/**
 * Generate flows/syteline-form-customization.flow.json.
 *
 * The agent step's prompt is built by importing CUSTOMIZATION_PLANNER_SYSTEM_PROMPT
 * and PLAN_AGENT_PROMPT_TEMPLATE directly from the backend source — sync by
 * construction, never copy-pasted.
 *
 * Run: cd backend && npx tsx scripts/gen-form-flow-json.mts
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

const steps = await import(join(repoRoot, 'backend', 'src', 'formAgent', 'steps.js'));
const CUSTOMIZATION_PLANNER_SYSTEM_PROMPT: string = steps.CUSTOMIZATION_PLANNER_SYSTEM_PROMPT;
const PLAN_AGENT_PROMPT_TEMPLATE: string = steps.PLAN_AGENT_PROMPT_TEMPLATE;

const agentPrompt = `${CUSTOMIZATION_PLANNER_SYSTEM_PROMPT}\n\n${PLAN_AGENT_PROMPT_TEMPLATE}`;
if (agentPrompt.length > 8000) {
  throw new Error(`agent prompt ${agentPrompt.length} chars exceeds the platform's 8000-char limit`);
}

// JSON-Schema translation of customizationPlanSchema (zod) in steps.ts.
// The platform's outputSchema subset has no `pattern` keyword support for
// the field-name rule — actually it does support `pattern` (it's in the
// subset); the UET ^Uf_ENF_ rule is expressed here AND re-validated by
// the zod schema in applyChangesTrn (belt-and-suspenders).
const planOutputSchema = {
  type: 'object',
  properties: {
    aliasPrefix: { type: 'string', description: 'Table alias the form binds with (assumption until Staging check A)' },
    idoName: { type: 'string', description: 'IDO name from the IDO properties CSV' },
    tableName: { type: 'string', description: 'SQL table name from the SQL columns CSV' },
    fields: {
      type: 'array',
      maxItems: 20,
      items: {
        type: 'object',
        properties: {
          field: { type: 'string', pattern: '^Uf_ENF_[A-Za-z0-9]+$', description: 'UET-only field name' },
          caption: { type: 'string' },
          kind: { type: 'string', enum: ['text', 'date', 'dropdown', 'notes'] },
          userDefinedType: { type: 'string' },
          container: { type: 'string', description: 'Existing container/tab component name from the form XML' },
          top: { type: 'number' },
          labelLeft: { type: 'number' },
          labelWidth: { type: 'number' },
          editLeft: { type: 'number' },
          editWidth: { type: 'number' },
        },
        required: ['field', 'caption', 'kind', 'container', 'top', 'labelLeft', 'labelWidth', 'editLeft', 'editWidth'],
      },
    },
    relabels: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          newCaption: { type: 'string' },
        },
        required: ['component', 'newCaption'],
      },
    },
    resizes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          component: { type: 'string' },
          changes: { type: 'object' },
        },
        required: ['component', 'changes'],
      },
    },
    designNotes: { type: 'string', description: 'UET design summary' },
    openItems: { type: 'array', maxItems: 20, items: { type: 'string' } },
  },
  required: ['aliasPrefix', 'idoName', 'tableName', 'fields', 'designNotes'],
};

const toolStep = (
  id: string,
  tool: string,
  params: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
) => ({
  id,
  kind: 'tool' as const,
  tool,
  params,
  ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
});

const flow = {
  name: 'syteline-form-customization',
  title: 'SyteLine Form Customization',
  description:
    'The SyteLine Form AI Agent pipeline as a versioned platform flow: intake → validate → backup → TRN/PRD compare → plan → apply → verify → open PR. ' +
    'The agent never merges; a person reviews and merges the PR.',
  inputs: {
    formName: { type: 'string', required: true, description: 'Form name, e.g. Lots' },
    title: { type: 'string', required: true, description: 'Short change title' },
    requestedBy: { type: 'string', required: false, description: 'Requester display name' },
    instructions: { type: 'string[]', required: true, description: 'Numbered instruction list' },
    formXml: { type: 'string', required: true, description: 'Current TRN form XML (FormSync export)' },
    idoPropertiesCsv: { type: 'string', required: true, description: 'IDO properties CSV' },
    sqlColumnsCsv: { type: 'string', required: true, description: 'SQL columns CSV' },
    attachmentNames: { type: 'string[]', required: false, description: 'Attachment filenames, parallel to attachmentContents' },
    attachmentContents: { type: 'string[]', required: false, description: 'Base64 attachment bytes, parallel to attachmentNames' },
    source: { type: 'string', required: false, description: "'json' (inline, normalized) or 'multipart' (byte-exact)" },
    repo: { type: 'string', required: true, description: 'Target GitHub repo (owner/name) for the review PR' },
    customizationId: { type: 'string', required: true, description: 'Customization id (inbox + branch key)' },
  },
  outputs: {
    prUrl: { type: 'string', description: 'Review PR URL (never merged by automation)' },
    prRepo: { type: 'string', description: 'Repo the PR was opened against' },
  },
  steps: [
    toolStep('intake', 'formagent.intake', {
      formName: '{{inputs.formName}}',
      title: '{{inputs.title}}',
      instructions: '{{inputs.instructions}}',
      formXml: '{{inputs.formXml}}',
      idoPropertiesCsv: '{{inputs.idoPropertiesCsv}}',
      sqlColumnsCsv: '{{inputs.sqlColumnsCsv}}',
      attachmentNames: '{{inputs.attachmentNames}}',
      attachmentContents: '{{inputs.attachmentContents}}',
      source: '{{inputs.source}}',
      repo: '{{inputs.repo}}',
      customizationId: '{{inputs.customizationId}}',
    }),
    toolStep('validate_inputs', 'formagent.validate_inputs', {
      customizationId: '{{inputs.customizationId}}',
      inboxDir: '{{steps.intake.output.inboxDir}}',
      title: '{{inputs.title}}',
      instructions: '{{inputs.instructions}}',
    }),
    toolStep('backup_originals', 'formagent.backup_originals', {
      customizationId: '{{inputs.customizationId}}',
      inboxDir: '{{steps.intake.output.inboxDir}}',
      formName: '{{steps.validate_inputs.output.formName}}',
      title: '{{inputs.title}}',
      repo: '{{inputs.repo}}',
    }),
    toolStep('compare_trn_prd', 'formagent.compare_trn_prd', {
      customizationId: '{{inputs.customizationId}}',
      trnFile: '{{steps.backup_originals.output.trnFile}}',
      prdFile: '{{steps.backup_originals.output.prdFile}}',
    }),
    {
      id: 'plan_changes',
      kind: 'agent' as const,
      prompt: agentPrompt,
      outputSchema: planOutputSchema,
      maxTokens: 4000,
      timeoutMs: 300000,
    },
    toolStep('apply_changes_trn', 'formagent.apply_changes_trn', {
      customizationId: '{{inputs.customizationId}}',
      plan: '{{steps.plan_changes.output}}',
      trnFile: '{{steps.backup_originals.output.trnFile}}',
      projectDir: '{{steps.backup_originals.output.projectDir}}',
      formName: '{{steps.validate_inputs.output.formName}}',
    }),
    toolStep('verify', 'formagent.verify', {
      customizationId: '{{inputs.customizationId}}',
      plan: '{{steps.plan_changes.output}}',
      projectDir: '{{steps.backup_originals.output.projectDir}}',
      formName: '{{steps.validate_inputs.output.formName}}',
      sha256Prefix: '{{steps.backup_originals.output.sha256Prefix}}',
      formXmlFile: '{{steps.apply_changes_trn.output.formXmlFile}}',
      trnFile: '{{steps.backup_originals.output.trnFile}}',
      title: '{{inputs.title}}',
      instructions: '{{inputs.instructions}}',
      requestedBy: '{{inputs.requestedBy}}',
      repo: '{{inputs.repo}}',
    }),
    toolStep('open_pr', 'formagent.open_pr', {
      customizationId: '{{inputs.customizationId}}',
      plan: '{{steps.plan_changes.output}}',
      projectDir: '{{steps.backup_originals.output.projectDir}}',
      formName: '{{steps.validate_inputs.output.formName}}',
      title: '{{inputs.title}}',
      repo: '{{inputs.repo}}',
    }, { timeoutMs: 300000 }),
  ],
  onError: 'stop' as const,
};

const outPath = join(repoRoot, 'flows', 'syteline-form-customization.flow.json');
writeFileSync(outPath, JSON.stringify(flow, null, 2) + '\n', 'utf8');
console.log(`wrote ${outPath} (${agentPrompt.length}-char agent prompt)`);
