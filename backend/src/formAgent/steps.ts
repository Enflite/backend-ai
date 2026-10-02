/**
 * steps.ts — the SyteLine Form AI Agent's pipeline step implementations.
 *
 * Each step is a pure async function with explicit arguments (no shared
 * values bag): the platform flow runner invokes them through the
 * `formagent.*` tools (flowTools.ts), and the route invokes `stageIntake`
 * directly for synchronous request validation. The canonical pipeline
 * definition lives in flows/syteline-form-customization.flow.json.
 *
 * Step implementations reuse the `syteline/forms` machinery through its
 * public exports only (index.ts) — never reimplemented here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { Errors } from '../errors.js';
import {
  assertExportBytes,
  assertUetFieldName,
  buildDeck,
  buildFormXml,
  componentStem,
  decodeExport,
  encodeExport,
  newFieldSchema,
  projectDirOrThrow,
  projectsSubdirOrThrow,
  pushProjectAndOpenPr,
  renderImplementationPlan,
  renderOriginalReadme,
  renderReadme,
  renderTroubleshooting,
  scaffoldProject,
  sha256Hex,
  type DeckInput,
  type ImplementationPlanInput,
  type NewFieldSpec,
  type ReadmeInput,
} from '../syteline/forms/index.js';
import { malwareScanner } from '../documents/malware.js';
import { FORM_CUSTOMIZATION_KNOWLEDGE } from './knowledge.js';
import {
  parseIdoPropertiesCsv,
  parseSqlColumnsCsv,
  toCrlf,
  validateFormXml,
  withBom,
} from './types.js';

// ---------------------------------------------------------------------------
// Step result type
// ---------------------------------------------------------------------------

/**
 * Error thrown for bad step inputs. At intake the route maps it onto HTTP
 * (400 VALIDATION_ERROR / 413 PART_TOO_LARGE); inside a run it surfaces
 * as a failed step.
 */
export class StepInputError extends Error {
  readonly code: string;
  readonly details?: unknown;
  readonly httpStatus: number;
  constructor(code: string, message: string, details?: unknown, httpStatus = 400) {
    super(message);
    this.name = 'StepInputError';
    this.code = code;
    this.details = details;
    this.httpStatus = httpStatus;
  }
}

export type PureStepResult =
  | { status: 'done'; outputs: Record<string, unknown>; detail?: string }
  | { status: 'blocked'; blockedCode: string; blockedDetail: string };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function readManifest(inboxDir: string): {
  formName: string;
  source: string;
  inlineNormalized: boolean;
  attachmentNames: string[];
} {
  return JSON.parse(readFileSync(join(inboxDir, 'manifest.json'), 'utf8'));
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Inbox dir for a customization id (confined under the projects root). */
export function inboxDirFor(customizationId: string): string {
  return projectsSubdirOrThrow('.inbox', customizationId);
}

// ---------------------------------------------------------------------------
// intake — validate the five inputs, stage them into the inbox
// (runs in the route, before any run record exists; failures → HTTP)
// ---------------------------------------------------------------------------

export interface StageIntakeArgs {
  formName: string;
  title: string;
  instructions: string[];
  formXml: Buffer;
  idoCsv: string;
  sqlCsv: string;
  attachments: { filename: string; bytes: Buffer }[];
  /** 'json' = inline content (normalized to CRLF+BOM on staging); 'multipart' = byte-exact upload. */
  source: 'json' | 'multipart';
  repo: string;
  customizationId: string;
}

export async function stageIntake(args: StageIntakeArgs): Promise<{
  inboxDir: string;
  hasPrdOriginal: boolean;
}> {
  const { formName, formXml, idoCsv, sqlCsv, attachments } = args;
  const inline = args.source === 'json';

  const invalid = (part: string, message: string): never => {
    throw new StepInputError('VALIDATION_ERROR', message, { part });
  };

  try {
    validateFormXml(formXml.toString('utf8'), formName);
  } catch (error) {
    invalid('formXml', error instanceof Error ? error.message : 'form XML is invalid');
  }
  try {
    parseIdoPropertiesCsv(idoCsv);
  } catch (error) {
    invalid('idoPropertiesCsv', error instanceof Error ? error.message : 'IDO properties CSV is invalid');
  }
  try {
    parseSqlColumnsCsv(sqlCsv);
  } catch (error) {
    invalid('sqlColumnsCsv', error instanceof Error ? error.message : 'SQL columns CSV is invalid');
  }

  // Byte-exact uploads only: refuse altered exports instead of "fixing"
  // them — the requester re-exports from FormSync.
  const formBytes = inline ? withBom(Buffer.from(toCrlf(formXml.toString('utf8')), 'utf8')) : formXml;
  if (!inline) {
    try {
      assertExportBytes(formBytes, `${formName}.trn.original.xml`);
    } catch {
      invalid(
        'formXml',
        'The form XML upload is not a byte-for-byte FormSync export (UTF-8 with BOM and CRLF required). ' +
          'Export the form from FormSync again without opening it in an editor, then re-submit.',
      );
    }
  }

  const inboxDir = inboxDirFor(args.customizationId);
  mkdirSync(join(inboxDir, 'attachments'), { recursive: true });
  writeFileSync(join(inboxDir, 'form.xml'), formBytes);
  writeFileSync(join(inboxDir, 'ido.csv'), idoCsv, 'utf8');
  writeFileSync(join(inboxDir, 'sql.csv'), sqlCsv, 'utf8');
  const attachmentNames: string[] = [];
  for (const attachment of attachments) {
    const safe = attachment.filename.split('/').pop()!.split('\\').pop()!;
    writeFileSync(join(inboxDir, 'attachments', safe), attachment.bytes);
    attachmentNames.push(safe);
  }
  // The production original arrives as a *.production.original.xml attachment (ADR-021 §6).
  const hasPrdOriginal = attachmentNames.some((n) => /\.production\.original\.xml$/i.test(n));
  writeFileSync(
    join(inboxDir, 'manifest.json'),
    JSON.stringify(
      { formName, source: args.source, inlineNormalized: inline, attachmentNames, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    'utf8',
  );
  return { inboxDir, hasPrdOriginal };
}

// ---------------------------------------------------------------------------
// validate-inputs — malware scan + XML/CSV shapes (failures → blocked)
// ---------------------------------------------------------------------------

export async function validateStagedInputs(inboxDir: string): Promise<PureStepResult> {
  const manifest = readManifest(inboxDir);
  const formName = manifest.formName;
  const parts: [string, Buffer][] = [
    ['formXml', readFileSync(join(inboxDir, 'form.xml'))],
    ['idoPropertiesCsv', readFileSync(join(inboxDir, 'ido.csv'))],
    ['sqlColumnsCsv', readFileSync(join(inboxDir, 'sql.csv'))],
  ];
  for (const name of manifest.attachmentNames) {
    parts.push([`attachments:${name}`, readFileSync(join(inboxDir, 'attachments', name))]);
  }

  // The malware boundary (same as document uploads): INFECTED quarantines
  // the request; anything else proceeds.
  for (const [part, bytes] of parts) {
    const result = await malwareScanner.scan(bytes);
    if (result.verdict === 'INFECTED') {
      return {
        status: 'blocked',
        blockedCode: 'attachment-quarantined',
        blockedDetail: `Part "${part}" tripped the malware boundary.`,
      };
    }
  }

  try {
    validateFormXml(parts[0]![1].toString('utf8'), formName);
  } catch (error) {
    return {
      status: 'blocked',
      blockedCode: 'missing-current-form-xml',
      blockedDetail: error instanceof Error ? error.message : 'The current form XML is invalid.',
    };
  }
  try {
    parseIdoPropertiesCsv(parts[1]![1].toString('utf8'));
    parseSqlColumnsCsv(parts[2]![1].toString('utf8'));
  } catch (error) {
    return {
      status: 'blocked',
      blockedCode: 'invalid-requirements',
      blockedDetail: error instanceof Error ? error.message : 'The CSV inputs are unusable.',
    };
  }
  return { status: 'done', outputs: { formName }, detail: `form=${formName}` };
}

// ---------------------------------------------------------------------------
// Planner context — the excerpts the agent step's prompt is built from
// ---------------------------------------------------------------------------

const PLAN_XML_EXCERPT_CHARS = 8000;
const PLAN_CSV_CHARS = 6000;
const PLAN_ATTACHMENT_CHARS = 2000;

export interface PlanContext {
  formName: string;
  title: string;
  instructionsText: string;
  xmlExcerpt: string;
  idoExcerpt: string;
  sqlExcerpt: string;
  attachmentsText: string;
}

/**
 * Build the planner's view of the validated inputs. Same excerpts the
 * bespoke planner used; now returned as structured data so the platform
 * flow's agent step can template them into its prompt.
 */
export function buildPlanContext(args: {
  inboxDir: string;
  formName: string;
  title: string;
  instructions: string[];
}): PlanContext {
  const { inboxDir, formName, title, instructions } = args;
  const manifest = readManifest(inboxDir);
  const formXmlText = decodeExport(readFileSync(join(inboxDir, 'form.xml')));
  const idoCsv = readFileSync(join(inboxDir, 'ido.csv'), 'utf8');
  const sqlCsv = readFileSync(join(inboxDir, 'sql.csv'), 'utf8');
  const attachmentSections: string[] = [];
  for (const name of manifest.attachmentNames) {
    if (/\.production\.original\.xml$/i.test(name)) continue;
    const content = readFileSync(join(inboxDir, 'attachments', name), 'utf8');
    attachmentSections.push(`--- ${name} ---\n${content.slice(0, PLAN_ATTACHMENT_CHARS)}`);
  }
  return {
    formName,
    title,
    instructionsText: instructions.map((instruction, i) => `${i + 1}. ${instruction}`).join('\n'),
    xmlExcerpt: formXmlText.slice(0, PLAN_XML_EXCERPT_CHARS),
    idoExcerpt: idoCsv.slice(0, PLAN_CSV_CHARS),
    sqlExcerpt: sqlCsv.slice(0, PLAN_CSV_CHARS),
    attachmentsText: attachmentSections.join('\n'),
  };
}

// ---------------------------------------------------------------------------
// backup-originals — scaffold the project, record TRN + production originals
// ---------------------------------------------------------------------------

export interface BackupOriginalsArgs {
  inboxDir: string;
  formName: string;
  title: string;
  repo: string;
  customizationId: string;
}

export async function backupOriginals(args: BackupOriginalsArgs): Promise<PureStepResult> {
  const { inboxDir, formName, title, repo, customizationId } = args;
  const templateDir = config.SYTELINE_FORM_TEMPLATES_DIR;
  if (!templateDir) {
    throw new Error('No Form-Project-Templates checkout configured (SYTELINE_FORM_TEMPLATES_DIR)');
  }

  const projectFolder = `${formName}-${customizationId.slice(0, 8)}`;
  const dir = projectDirOrThrow(projectFolder);
  scaffoldProject({ formName, title, repo, destDir: dir, templateDir });

  // The production original arrives as a *.production.original.xml
  // attachment (ADR-021 §6).
  const manifest = readManifest(inboxDir);
  const match = manifest.attachmentNames.find((n) => /\.production\.original\.xml$/i.test(n));
  if (!match) {
    return {
      status: 'blocked',
      blockedCode: 'missing-production-original',
      blockedDetail:
        'No production FormSync export was supplied, so the SyteLine Form AI Agent cannot complete the backup-first check. ' +
        'Export the same form from FormSync on production and attach it as *.production.original.xml, then create a new request. ' +
        'The agent never builds without both rollback copies.',
    };
  }
  const prdBytes = readFileSync(join(inboxDir, 'attachments', match));

  const trnBytes = readFileSync(join(inboxDir, 'form.xml'));
  try {
    assertExportBytes(trnBytes, `${formName}.trn.original.xml`);
    assertExportBytes(prdBytes, `${formName}.production.original.xml`);
  } catch {
    return {
      status: 'blocked',
      blockedCode: 'missing-production-original',
      blockedDetail:
        'A supplied original is not a byte-for-byte FormSync export (UTF-8 with BOM and CRLF required). ' +
        'Export the form from FormSync again without opening it in an editor and create a new request.',
    };
  }
  mkdirSync(join(dir, 'original'), { recursive: true });
  const trnFile = join(dir, 'original', `${formName}.trn.original.xml`);
  const prdFile = join(dir, 'original', `${formName}.production.original.xml`);
  writeFileSync(trnFile, trnBytes);
  writeFileSync(prdFile, prdBytes);
  mkdirSync(join(dir, 'context', 'attachments'), { recursive: true });
  writeFileSync(join(dir, 'context', 'ido-properties.csv'), readFileSync(join(inboxDir, 'ido.csv')));
  writeFileSync(join(dir, 'context', 'sql-columns.csv'), readFileSync(join(inboxDir, 'sql.csv')));
  for (const name of manifest.attachmentNames) {
    writeFileSync(join(dir, 'context', 'attachments', name), readFileSync(join(inboxDir, 'attachments', name)));
  }
  const sha256Prefix = (await sha256Hex(trnBytes)).slice(0, 16);
  return {
    status: 'done',
    outputs: { projectDir: dir, trnFile, prdFile, sha256Prefix },
    detail: `sha=${sha256Prefix}`,
  };
}

// ---------------------------------------------------------------------------
// compare-trn-prd — drift stops the build
// ---------------------------------------------------------------------------

export async function compareTrnPrd(trnFile: string, prdFile: string): Promise<PureStepResult> {
  const trnBytes = readFileSync(trnFile);
  const prdBytes = readFileSync(prdFile);
  if ((await sha256Hex(trnBytes)) !== (await sha256Hex(prdBytes))) {
    return {
      status: 'blocked',
      blockedCode: 'trn-prd-drift',
      blockedDetail:
        'STOP: the TRN and production originals differ — production has local form changes. ' +
        'Record them under Open items in docs/Implementation-Plan.md before any design work.',
    };
  }
  return { status: 'done', outputs: { driftChecked: true }, detail: 'trn==prd' };
}

// ---------------------------------------------------------------------------
// Customization plan schema (zod) — the agent step's outputSchema is the
// JSON-Schema translation of this, embedded in
// flows/syteline-form-customization.flow.json. A test asserts the two stay
// in sync.
// ---------------------------------------------------------------------------

export const customizationPlanSchema = z
  .object({
    aliasPrefix: z.string().regex(/^[a-z][A-Za-z0-9]*$/),
    idoName: z.string().trim().min(1).max(80),
    tableName: z.string().trim().min(1).max(80),
    fields: z.array(newFieldSchema).max(20).default([]),
    relabels: z
      .array(z.object({ component: z.string().min(1), newCaption: z.string().min(1) }).strict())
      .default([]),
    resizes: z
      .array(
        z
          .object({
            component: z.string().min(1),
            changes: z.record(z.string(), z.union([z.number(), z.string()])),
          })
          .strict(),
      )
      .default([]),
    designNotes: z.string().trim().min(1).max(4000),
    openItems: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
  })
  .strict();

export type CustomizationPlan = z.infer<typeof customizationPlanSchema>;

export const CUSTOMIZATION_PLANNER_SYSTEM_PROMPT =
  `${FORM_CUSTOMIZATION_KNOWLEDGE}\n\n` +
  `PLAN CONTRACT — output ONE JSON object and nothing else: no markdown fences, no commentary.\n` +
  `Schema:\n` +
  `{ "aliasPrefix": "lot", "idoName": "SLLots", "tableName": "lot",\n` +
  `  "fields": [ { "field": "Uf_ENF_Name", "caption": "Human label", "kind": "text|date|dropdown|notes",\n` +
  `    "userDefinedType": "optional", "container": "<existing container/tab component name from the form XML>",\n` +
  `    "top": 0, "labelLeft": 0, "labelWidth": 0, "editLeft": 0, "editWidth": 0 } ],\n` +
  `  "relabels": [ { "component": "<existing component name>", "newCaption": "..." } ],\n` +
  `  "resizes": [ { "component": "...", "changes": { "<element>": value } } ],\n` +
  `  "designNotes": "<UET design summary: fields, class, SQL table link>",\n` +
  `  "openItems": ["<ambiguity or assumption for the requester/TRN tester>"] }\n\n` +
  `Plan rules:\n` +
  `- At most 20 fields. Field names MUST match ^Uf_ENF_[A-Za-z0-9]+$ (UET-only) — anything else is rejected.\n` +
  `- "container" is an existing container/tab component name read from the form XML excerpt — never invent one.\n` +
  `- Layout numbers (top/left/width) use the form's own units; place new fields near the related existing components.\n` +
  `- "relabels"/"resizes" reference existing component names from the XML excerpt only.\n` +
  `- "aliasPrefix" is the table alias the form binds with — an ASSUMPTION until Staging check A; take it from the XML bindings when visible.\n` +
  `- "idoName"/"tableName" come from the IDO properties and SQL columns CSVs.\n` +
  `- "designNotes": one paragraph — which UET fields, the ENF_* class, the SQL table link.\n` +
  `- "openItems": every ambiguity or assumption the requester or the TRN tester must resolve (alias assumed, container uncertain, missing SQL column, ...).`;

/**
 * The dynamic template section of the platform flow's agent step prompt.
 * The full prompt in flows/syteline-form-customization.flow.json is
 * CUSTOMIZATION_PLANNER_SYSTEM_PROMPT + "\n\n" + this template. A test
 * asserts the committed JSON stays in sync with both constants.
 */
export const PLAN_AGENT_PROMPT_TEMPLATE = [
  'Form: {{steps.validate_inputs.output.planContext.formName}}',
  'Title: {{steps.validate_inputs.output.planContext.title}}',
  '',
  'Instructions:',
  '{{steps.validate_inputs.output.planContext.instructionsText}}',
  '',
  'IDO properties CSV:',
  '{{steps.validate_inputs.output.planContext.idoExcerpt}}',
  '',
  'SQL columns CSV:',
  '{{steps.validate_inputs.output.planContext.sqlExcerpt}}',
  '',
  'Form XML excerpt (TRN original):',
  '{{steps.validate_inputs.output.planContext.xmlExcerpt}}',
  '',
  'Attachments:',
  '{{steps.validate_inputs.output.planContext.attachmentsText}}',
  '',
  'Produce the plan JSON now.',
].join('\n');

// ---------------------------------------------------------------------------
// apply-changes-trn — build <Form>.xml from the TRN original
// ---------------------------------------------------------------------------

export interface ApplyChangesArgs {
  plan: CustomizationPlan;
  trnFile: string;
  projectDir: string;
  formName: string;
}

export async function applyChangesTrn(args: ApplyChangesArgs): Promise<PureStepResult> {
  // Belt-and-suspenders: the platform already validated the agent's output
  // against the flow's outputSchema, but the UET contract (field names,
  // shapes) is re-checked here with the canonical zod schema.
  const plan = customizationPlanSchema.safeParse(args.plan);
  if (!plan.success) {
    return {
      status: 'blocked',
      blockedCode: 'invalid-requirements',
      blockedDetail:
        'The generated plan failed re-validation — the agent produced fields outside the UET contract. ' +
        'Refine the instructions and create a new request.',
    };
  }
  const { trnFile, projectDir, formName } = args;
  const trnBytes = readFileSync(trnFile);
  const fields: NewFieldSpec[] = plan.data.fields.map((f) => {
    assertUetFieldName(f.field);
    return { ...f, stem: componentStem(f.field) };
  });
  const rendered = encodeExport(
    buildFormXml(decodeExport(trnBytes), {
      formName,
      aliasPrefix: plan.data.aliasPrefix,
      newFields: fields,
      relabels: plan.data.relabels,
      resizes: plan.data.resizes,
      addGridColumns: true,
      highlight: true,
    }),
  );
  const outPath = join(projectDir, `${formName}.xml`);
  writeFileSync(outPath, rendered);
  const components = fields.flatMap((f) => [
    `${f.stem}Static`,
    `${f.stem}Edit`,
    ...(f.kind === 'notes' ? [] : [`${f.stem}GridCol`]),
  ]);
  return {
    status: 'done',
    outputs: { formXmlFile: outPath, components },
    detail: `components=${components.length}`,
  };
}

// ---------------------------------------------------------------------------
// verify — deterministic rebuild check, docs, deck
// ---------------------------------------------------------------------------

function uetDataType(kind: string): string {
  return kind === 'date' ? 'date' : 'string';
}

export interface VerifyArgs {
  plan: CustomizationPlan;
  projectDir: string;
  formName: string;
  sha256Prefix: string;
  formXmlFile: string;
  trnFile: string;
  title: string;
  instructions: string[];
  requestedBy?: string;
  repo: string;
}

function buildImplementationPlanInput(
  args: VerifyArgs,
  plan: CustomizationPlan,
): ImplementationPlanInput {
  const date = todayIso();
  const { formName, title, repo, instructions, sha256Prefix } = args;
  const displayName = args.requestedBy ?? 'the requester';
  return {
    formName,
    title,
    repo,
    summary: `${title} — ${instructions[0]!.slice(0, 160)}`,
    goal: instructions.join('; '),
    ido: plan.idoName,
    table: plan.tableName,
    mstTable: `${plan.tableName}_mst`,
    alias: plan.aliasPrefix,
    aliasAssumed: true,
    status: 'Draft — built by the SyteLine Form AI Agent; TRN steps not yet run',
    sourceNote: `SyteLine Form AI Agent request by ${displayName} (${date}): ${instructions.length} instruction(s).`,
    scopeRows: [
      ...plan.fields.map((f) => ({ tab: f.container, onForm: 'New', field: f.caption, type: f.kind, source: `UET ${f.field}` })),
      ...plan.relabels.map((r) => ({ tab: '—', onForm: 'Relabel', field: r.newCaption, type: 'label', source: r.component })),
    ],
    layoutNote: plan.designNotes,
    brd: instructions.map((instruction, i) => ({ id: `BRD-${i + 1}`, requirement: instruction.slice(0, 120), detail: instruction })),
    openItems: plan.openItems.map((item) => ({ item, blocks: 'Design' })),
    uetFields: plan.fields.map((f) => ({
      name: f.field,
      userDataType: f.userDefinedType ?? '—',
      dataType: uetDataType(f.kind),
      precision: '',
      description: f.caption,
      assumedNote: '*',
    })),
    uetClass: {
      name: `ENF_${formName}`,
      label: title,
      description: `Custom fields for the ${formName} form (SyteLine Form AI Agent).`,
    },
    bindingExample: plan.fields[0]
      ? `object.${plan.aliasPrefix}${plan.fields[0]!.field}`
      : `object.${plan.aliasPrefix}Uf_ENF_Example`,
    formBuildBullets: [
      `Built from the TRN original (SHA-256 ${sha256Prefix}…)`,
      `${plan.fields.length} new field(s), ${plan.relabels.length} relabel(s), ${plan.resizes.length} resize(s)`,
      'New components bind object.<alias>Uf_ENF_<Name> with purple highlighting',
      'Every new field gets a grid column',
      'TRN and production originals are byte-for-byte identical',
    ],
    testChecklist: [
      `Import ${formName}.xml into TRN through FormSync at Site scope`,
      'Confirm the new fields are on the IDO (Staging check A) and note the real alias prefix',
      'Verify purple highlighting on every new or changed component',
      'Exercise each new field: enter, save, reload, confirm the value round-trips',
      'Confirm the grid shows the new columns',
    ],
    releaseLine: `**${date}:** Project built by the SyteLine Form AI Agent.`,
    tabLabel: plan.fields[0]?.container ?? 'General',
  };
}

function buildReadmeInput(args: VerifyArgs, plan: CustomizationPlan, deckFileName: string): ReadmeInput {
  const { formName, repo } = args;
  const changeBullets = [
    ...plan.fields.map((f) => `New ${f.kind} field "${f.caption}" (${f.field}) on ${f.container}`),
    ...plan.relabels.map((r) => `Relabeled ${r.component} to "${r.newCaption}"`),
    ...plan.resizes.map((r) => `Resized ${r.component}`),
  ];
  return {
    repo,
    formName,
    tagline: `SyteLine — ${formName} form changes, built with UET and FormSync by the SyteLine Form AI Agent.`,
    changeBullets: changeBullets.length > 0 ? changeBullets : ['No form-component changes — docs and project scaffold only'],
    assumptionsNote: 'Table alias and UET design are assumptions until confirmed in Staging check A.',
    releaseLines: [`**${todayIso()}:** Project built by the SyteLine Form AI Agent.`],
    deckFileName,
    buildCommandNote: 'Rebuild the form XML with the project build script (deterministic rebuild check).',
  };
}

const STANDARD_PHASE_BULLETS: [string, string[]][] = [
  ['Scope', ['Confirm the instruction list with the requester', 'Record open items and assumptions']],
  ['Design', ['Design the UET fields (Uf_ENF_*), the ENF_* class, and the SQL table link', 'Fill in the implementation plan']],
  ['Develop', ['Build the form XML from the TRN original', 'Write the project docs']],
  ['Staging', ['UET setup on TRN', 'Confirm the new fields are on the IDO (Staging check A)', 'Import the form through FormSync at Site scope']],
  ['Launch', ['Repeat the UET setup and FormSync import on production after sign-off']],
  ['Test', ['Run the plan test checklist on TRN, then production']],
  ['Optimize', ['Review feedback after go-live; fold follow-ups into the next change']],
];

function buildDeckInput(args: VerifyArgs, plan: CustomizationPlan): DeckInput {
  const { formName, title, instructions } = args;
  return {
    formName,
    title,
    subtitle: 'Built by the SyteLine Form AI Agent',
    fileName: `${formName}_Implementation_Plan.pptx`,
    brd: instructions.map((instruction, i) => [`BRD-${i + 1}`, instruction.slice(0, 80), '']),
    scope: { sub: 'Scope', flow: [['TRN', 'Build + test'], ['Production', 'Launch after sign-off']] },
    design: [
      {
        sub: 'Design',
        label: 'New fields',
        cols: [['Field', 24], ['Label', 24], ['Type', 14], ['Binding', 38]],
        rows: plan.fields.map((f) => [f.field, f.caption, f.kind, `object.${plan.aliasPrefix}${f.field}`]),
        note: 'UET-only; the alias is assumed until Staging check A.',
      },
      ...(plan.relabels.length > 0
        ? [{
            sub: 'Design',
            label: 'Relabels',
            cols: [['Component', 40], ['New caption', 60]] as [string, number][],
            rows: plan.relabels.map((r) => [r.component, r.newCaption]),
          }]
        : []),
    ],
    develop: [
      'Build the form XML from the TRN original (text-level; BOM+CRLF preserved)',
      'Purple highlighting on every new or changed component; grid column per new field',
      'Deterministic rebuild check before shipping',
    ],
    formsync: [
      'Export the current form from FormSync on TRN and production BEFORE anything (rollback copies)',
      'Import the built form through FormSync at Site scope',
    ],
    staging: [
      'UET setup on TRN per the plan Design tables',
      'UET Impact Schema, then Unload IDO Metadata, then sign out and back in',
      'Staging check A: confirm the new fields are on the IDO; note the real alias prefix',
    ],
    launch: ['Repeat the UET setup and FormSync import on production after sign-off'],
    test: ['Run the plan test checklist on TRN, then production'],
    optimize: ['Fold go-live feedback into the next change'],
    rollback: ['Import the original/*.xml rollback copies through FormSync at Site scope'],
    phases: STANDARD_PHASE_BULLETS,
  };
}

export type DeckBuildFn = (deck: DeckInput, projectDir: string) => Promise<string>;
let deckBuildOverride: DeckBuildFn | null = null;

/** Test-only seam: substitute the deck build (npm build in CI). */
export function overrideDeckBuild(fn: DeckBuildFn | null): void {
  deckBuildOverride = fn;
}

export async function verifyBuild(args: VerifyArgs): Promise<PureStepResult> {
  const { plan, projectDir, formName, sha256Prefix, formXmlFile, trnFile } = args;

  // Deterministic rebuild check: rebuild in-memory and compare bytes.
  const trnBytes = readFileSync(trnFile);
  const fields: NewFieldSpec[] = plan.fields.map((f) => {
    assertUetFieldName(f.field);
    return { ...f, stem: componentStem(f.field) };
  });
  const rebuilt = encodeExport(
    buildFormXml(decodeExport(trnBytes), {
      formName,
      aliasPrefix: plan.aliasPrefix,
      newFields: fields,
      relabels: plan.relabels,
      resizes: plan.resizes,
      addGridColumns: true,
      highlight: true,
    }),
  );
  if (!rebuilt.equals(readFileSync(formXmlFile))) {
    return {
      status: 'blocked',
      blockedCode: 'build-check-failed',
      blockedDetail:
        "The build script's deterministic-rebuild check failed: rebuilding <Form>.xml from the TRN original " +
        'did not reproduce the committed file. This indicates the tooling, not the request — file it with the backend team.',
    };
  }

  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  const planInput = buildImplementationPlanInput(args, plan);
  const deckFileName = `${formName}_Implementation_Plan.pptx`;
  const readmeInput = buildReadmeInput(args, plan, deckFileName);
  const write = (rel: string, content: string): void => {
    writeFileSync(join(projectDir, rel), content, 'utf8');
  };
  write('README.md', renderReadme(readmeInput));
  write(join('docs', 'Implementation-Plan.md'), renderImplementationPlan(planInput));
  write(join('docs', 'troubleshooting.md'), renderTroubleshooting(formName));
  write(
    join('original', 'README.md'),
    renderOriginalReadme({
      formName,
      trnExportedNote: `Supplied with the SyteLine Form AI Agent request (${todayIso()})`,
      prdExportedNote: `Supplied with the SyteLine Form AI Agent request (${todayIso()})`,
      identical: true,
      shaPrefix: sha256Prefix,
    }),
  );

  let pptxPath: string;
  try {
    const deckInput = buildDeckInput(args, plan);
    pptxPath = await (deckBuildOverride ?? defaultDeckBuild)(deckInput, projectDir);
  } catch {
    return {
      status: 'blocked',
      blockedCode: 'build-check-failed',
      blockedDetail:
        'The implementation-plan deck could not be built. This indicates the tooling, not the request — file it with the backend team.',
    };
  }
  const docs = ['README.md', 'docs/Implementation-Plan.md', 'docs/troubleshooting.md', 'original/README.md'];
  return {
    status: 'done',
    outputs: { docs, deck: pptxPath, rebuildOk: true },
    detail: 'rebuild=ok',
  };
}

async function defaultDeckBuild(deck: DeckInput, projectDir: string): Promise<string> {
  return buildDeck(deck, { projectDir, skipInstall: false });
}

// ---------------------------------------------------------------------------
// open-pr — push and OPEN the review PR. Never merge.
// ---------------------------------------------------------------------------

export interface OpenPrArgs {
  repo: string;
  projectDir: string;
  branch: string;
  base: string;
  prTitle: string;
  prBody: string;
}

export type OpenPrFn = (args: OpenPrArgs) => Promise<{ prUrl: string }>;
let openPrOverride: OpenPrFn | null = null;

/** Test-only seam: substitute the GitHub push + PR open. */
export function overrideOpenPr(fn: OpenPrFn | null): void {
  openPrOverride = fn;
}

async function defaultOpenPr(args: OpenPrArgs): Promise<{ prUrl: string }> {
  const result = await pushProjectAndOpenPr({
    repo: args.repo,
    projectDir: args.projectDir,
    branch: args.branch,
    base: args.base,
    commitMessage: args.prTitle,
    prTitle: args.prTitle,
    prBody: args.prBody,
  });
  return { prUrl: result.prUrl };
}

export interface OpenReviewPrArgs {
  plan: CustomizationPlan;
  projectDir: string;
  formName: string;
  title: string;
  repo: string;
  customizationId: string;
}

export async function openReviewPr(args: OpenReviewPrArgs): Promise<PureStepResult> {
  const { plan, projectDir, formName, title, repo, customizationId } = args;
  const changeBullets = [
    ...plan.fields.map((f) => `New ${f.kind} field "${f.caption}" (${f.field}) on ${f.container}`),
    ...plan.relabels.map((r) => `Relabeled ${r.component} to "${r.newCaption}"`),
    ...plan.resizes.map((r) => `Resized ${r.component}`),
  ];
  const branch = `form-ai/${formName.toLowerCase()}-${customizationId.slice(0, 8)}`;
  const prTitle = `[SyteLine Form AI Agent] ${title} (${formName})`;
  const prBody = [
    `Built by the SyteLine Form AI Agent from request \`${customizationId.slice(0, 8)}\`.`,
    '',
    '## What changed',
    ...changeBullets.map((b) => `- ${b}`),
    '',
    '## Assumptions',
    '- Table alias and UET design are assumptions until confirmed in Staging check A.',
    ...plan.openItems.map((item) => `- ${item}`),
    '',
    '## Review',
    'A person reviews and merges this PR — it is never merged by automation.',
  ].join('\n');
  const opened = await (openPrOverride ?? defaultOpenPr)({
    repo,
    projectDir,
    branch,
    base: 'main',
    prTitle,
    prBody,
  });
  return {
    status: 'done',
    outputs: { prUrl: opened.prUrl, prRepo: repo },
    detail: `repo=${repo}`,
  };
}

/** Remove a staged inbox (best-effort cleanup after backup-originals). */
export function cleanupInbox(inboxDir: string): void {
  try {
    rmSync(inboxDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
