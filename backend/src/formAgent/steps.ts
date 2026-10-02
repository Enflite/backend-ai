/**
 * steps.ts — the SyteLine Form AI Agent's flow step handlers and
 * registries.
 *
 * STEP_HANDLERS maps the flow definition's `handlerRef`s to the code
 * that runs each step. PROMPT_BUILDERS / SCHEMAS serve the
 * `agentJudgment` steps (promptRef / schemaRef). PRECONDITION_CHECKS
 * serve the flow's preconditions. The flow definition itself (flow.ts)
 * stays pure data; this module holds the implementations it references.
 *
 * Step implementations reuse the `syteline/forms` machinery through its
 * public exports only (index.ts) — never reimplemented here.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import {
  assertExportBytes,
  assertUetFieldName,
  buildDeck,
  buildFormXml,
  componentStem,
  decodeExport,
  encodeExport,
  githubPrAvailable,
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
import { liveRequesterAuth } from '../syteline/requesterAuth.js';
import { malwareScanner } from '../documents/malware.js';
import { FORM_CUSTOMIZATION_KNOWLEDGE } from './knowledge.js';
import {
  parseIdoPropertiesCsv,
  parseSqlColumnsCsv,
  toCrlf,
  validateFormXml,
  withBom,
} from './types.js';
import {
  StepInputError,
  type FlowRunContext,
  type StepHandler,
  type StepHandlerContext,
  type StepResult,
} from './flowRunner.js';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function blocked(blockedCode: string, blockedDetail: string, detail?: string): StepResult {
  return { status: 'blocked', blockedCode, blockedDetail, ...(detail ? { detail } : {}) };
}

function done(outputs: Record<string, unknown>, detail?: string): StepResult {
  return { status: 'done', outputs, ...(detail ? { detail } : {}) };
}

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

// ---------------------------------------------------------------------------
// intake — validate the five inputs, stage them into the inbox
// (runs in the route, before any run record exists; failures → HTTP)
// ---------------------------------------------------------------------------

async function intake({ ctx }: StepHandlerContext): Promise<StepResult> {
  const v = ctx.values;
  const formName = v['request.formName'] as string;
  const formXml = v['input.formXml'] as Buffer;
  const idoCsv = v['input.idoCsv'] as string;
  const sqlCsv = v['input.sqlCsv'] as string;
  const attachments = (v['input.attachments'] as { filename: string; bytes: Buffer }[]) ?? [];
  const inline = (v['input.source'] as string) === 'json';

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

  const inboxDir = projectsSubdirOrThrow('.inbox', ctx.runId);
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
      { formName, source: inline ? 'json' : 'multipart', inlineNormalized: inline, attachmentNames, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    'utf8',
  );
  return done({ 'inbox.dir': inboxDir, 'inbox.hasPrdOriginal': hasPrdOriginal }, `form=${formName}`);
}

// ---------------------------------------------------------------------------
// validate-inputs — malware scan + XML/CSV shapes (runner; failures → blocked)
// ---------------------------------------------------------------------------

async function validateInputs({ ctx }: StepHandlerContext): Promise<StepResult> {
  const inboxDir = ctx.values['inbox.dir'] as string;
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
      return blocked('attachment-quarantined', `Part "${part}" tripped the malware boundary.`);
    }
  }

  try {
    validateFormXml(parts[0]![1].toString('utf8'), formName);
  } catch (error) {
    return blocked('missing-current-form-xml', error instanceof Error ? error.message : 'The current form XML is invalid.');
  }
  try {
    parseIdoPropertiesCsv(parts[1]![1].toString('utf8'));
    parseSqlColumnsCsv(parts[2]![1].toString('utf8'));
  } catch (error) {
    return blocked('invalid-requirements', error instanceof Error ? error.message : 'The CSV inputs are unusable.');
  }
  return done({ 'validated.formName': formName }, `form=${formName}`);
}

// ---------------------------------------------------------------------------
// backup-originals — scaffold the project, record TRN + production originals
// ---------------------------------------------------------------------------

async function backupOriginals({ ctx }: StepHandlerContext): Promise<StepResult> {
  const inboxDir = ctx.values['inbox.dir'] as string;
  const formName = ctx.values['validated.formName'] as string;
  const title = ctx.values['request.title'] as string;
  const repo = ctx.values['repo'] as string;
  const templateDir = config.SYTELINE_FORM_TEMPLATES_DIR;
  if (!templateDir) {
    throw new Error('No Form-Project-Templates checkout configured (SYTELINE_FORM_TEMPLATES_DIR)');
  }

  const projectFolder = `${formName}-${ctx.runId.slice(0, 8)}`;
  const dir = projectDirOrThrow(projectFolder);
  scaffoldProject({ formName, title, repo, destDir: dir, templateDir });

  // The production original arrives as a *.production.original.xml
  // attachment (ADR-021 §6).
  const manifest = readManifest(inboxDir);
  const match = manifest.attachmentNames.find((n) => /\.production\.original\.xml$/i.test(n));
  if (!match) {
    return blocked(
      'missing-production-original',
      'No production FormSync export was supplied, so the SyteLine Form AI Agent cannot complete the backup-first check. ' +
        'Export the same form from FormSync on production and attach it as *.production.original.xml, then create a new request. ' +
        'The agent never builds without both rollback copies.',
    );
  }
  const prdBytes = readFileSync(join(inboxDir, 'attachments', match));

  const trnBytes = readFileSync(join(inboxDir, 'form.xml'));
  try {
    assertExportBytes(trnBytes, `${formName}.trn.original.xml`);
    assertExportBytes(prdBytes, `${formName}.production.original.xml`);
  } catch {
    return blocked(
      'missing-production-original',
      'A supplied original is not a byte-for-byte FormSync export (UTF-8 with BOM and CRLF required). ' +
        'Export the form from FormSync again without opening it in an editor and create a new request.',
    );
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
  return done(
    { 'project.dir': dir, 'originals.trnFile': trnFile, 'originals.prdFile': prdFile, 'originals.sha256Prefix': sha256Prefix },
    `sha=${sha256Prefix}`,
  );
}

// ---------------------------------------------------------------------------
// compare-trn-prd — drift stops the build
// ---------------------------------------------------------------------------

async function compareTrnPrd({ ctx }: StepHandlerContext): Promise<StepResult> {
  const trnBytes = readFileSync(ctx.values['originals.trnFile'] as string);
  const prdBytes = readFileSync(ctx.values['originals.prdFile'] as string);
  if ((await sha256Hex(trnBytes)) !== (await sha256Hex(prdBytes))) {
    return blocked(
      'trn-prd-drift',
      'STOP: the TRN and production originals differ — production has local form changes. ' +
        'Record them under Open items in docs/Implementation-Plan.md before any design work.',
    );
  }
  return done({ 'drift.checked': true }, 'trn==prd');
}

// ---------------------------------------------------------------------------
// plan-changes — agentJudgment: the SOP-knowing planner
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

const PLAN_XML_EXCERPT_CHARS = 8000;
const PLAN_CSV_CHARS = 6000;
const PLAN_ATTACHMENT_CHARS = 2000;

function buildPlanUserMessage(values: Record<string, unknown>): string {
  const inboxDir = values['inbox.dir'] as string;
  const manifest = readManifest(inboxDir);
  const formName = values['validated.formName'] as string;
  const title = values['request.title'] as string;
  const instructions = values['request.instructions'] as string[];
  const formXmlText = decodeExport(readFileSync(join(inboxDir, 'form.xml')));
  const idoCsv = readFileSync(join(inboxDir, 'ido.csv'), 'utf8');
  const sqlCsv = readFileSync(join(inboxDir, 'sql.csv'), 'utf8');
  const lines = [
    `Form: ${formName}`,
    `Title: ${title}`,
    '',
    'Instructions:',
    ...instructions.map((instruction, i) => `${i + 1}. ${instruction}`),
    '',
    'IDO properties CSV:',
    idoCsv.slice(0, PLAN_CSV_CHARS),
    '',
    'SQL columns CSV:',
    sqlCsv.slice(0, PLAN_CSV_CHARS),
    '',
    'Form XML excerpt (TRN original):',
    formXmlText.slice(0, PLAN_XML_EXCERPT_CHARS),
  ];
  if (manifest.attachmentNames.length > 0) {
    lines.push('', 'Attachments:');
    for (const name of manifest.attachmentNames) {
      if (/\.production\.original\.xml$/i.test(name)) continue;
      const content = readFileSync(join(inboxDir, 'attachments', name), 'utf8');
      lines.push(`--- ${name} ---`, content.slice(0, PLAN_ATTACHMENT_CHARS));
    }
  }
  lines.push('', 'Produce the plan JSON now.');
  return lines.join('\n');
}

async function planChanges({ step, ctx, judge, signal }: StepHandlerContext): Promise<StepResult> {
  const buildPrompt = PROMPT_BUILDERS[step.promptRef ?? ''];
  const schema = SCHEMAS[step.schemaRef ?? ''];
  if (!buildPrompt || !schema) {
    return { status: 'failed', errorCode: 'missing-prompt', detail: step.promptRef ?? step.schemaRef };
  }
  const { systemPrompt, userMessage } = buildPrompt(ctx.values);
  const result = await judge(
    ctx,
    { judgmentRef: step.promptRef!, systemPrompt, userMessage, schema },
    signal,
  );
  if (!result.ok) {
    return blocked(
      'invalid-requirements',
      'The SyteLine Form AI Agent could not turn the instructions into a valid plan. ' +
        'Restate them more concretely (field type, label, tab, position) and create a new request.',
    );
  }
  const plan = result.decision as CustomizationPlan;
  return done({ plan }, `fields=${plan.fields.length}`);
}

// ---------------------------------------------------------------------------
// apply-changes-trn — build <Form>.xml from the TRN original
// ---------------------------------------------------------------------------

async function applyChangesTrn({ ctx }: StepHandlerContext): Promise<StepResult> {
  const plan = ctx.values['plan'] as CustomizationPlan;
  const trnBytes = readFileSync(ctx.values['originals.trnFile'] as string);
  const projectDir = ctx.values['project.dir'] as string;
  const formName = ctx.values['validated.formName'] as string;
  const fields: NewFieldSpec[] = plan.fields.map((f) => {
    assertUetFieldName(f.field);
    return { ...f, stem: componentStem(f.field) };
  });
  const rendered = encodeExport(
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
  const outPath = join(projectDir, `${formName}.xml`);
  writeFileSync(outPath, rendered);
  const components = fields.flatMap((f) => [
    `${f.stem}Static`,
    `${f.stem}Edit`,
    ...(f.kind === 'notes' ? [] : [`${f.stem}GridCol`]),
  ]);
  return done(
    { 'build.formXmlFile': outPath, 'build.components': components },
    `components=${components.length}`,
  );
}

// ---------------------------------------------------------------------------
// verify — deterministic rebuild check, docs, deck
// ---------------------------------------------------------------------------

function uetDataType(kind: string): string {
  return kind === 'date' ? 'date' : 'string';
}

function buildImplementationPlanInput(
  values: Record<string, unknown>,
  plan: CustomizationPlan,
  sha256Prefix: string,
): ImplementationPlanInput {
  const date = todayIso();
  const formName = values['validated.formName'] as string;
  const title = values['request.title'] as string;
  const repo = values['repo'] as string;
  const instructions = values['request.instructions'] as string[];
  const displayName = (values['request.requestedBy'] as string | undefined) ?? 'the requester';
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

function buildReadmeInput(values: Record<string, unknown>, plan: CustomizationPlan, deckFileName: string): ReadmeInput {
  const formName = values['validated.formName'] as string;
  const repo = values['repo'] as string;
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

function buildDeckInput(values: Record<string, unknown>, plan: CustomizationPlan): DeckInput {
  const formName = values['validated.formName'] as string;
  const title = values['request.title'] as string;
  const instructions = values['request.instructions'] as string[];
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

async function verify({ ctx }: StepHandlerContext): Promise<StepResult> {
  const plan = ctx.values['plan'] as CustomizationPlan;
  const projectDir = ctx.values['project.dir'] as string;
  const formName = ctx.values['validated.formName'] as string;
  const sha256Prefix = ctx.values['originals.sha256Prefix'] as string;
  const formXmlFile = ctx.values['build.formXmlFile'] as string;

  // Deterministic rebuild check: rebuild in-memory and compare bytes.
  const trnBytes = readFileSync(ctx.values['originals.trnFile'] as string);
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
    return blocked(
      'build-check-failed',
      "The build script's deterministic-rebuild check failed: rebuilding <Form>.xml from the TRN original " +
        'did not reproduce the committed file. This indicates the tooling, not the request — file it with the backend team.',
    );
  }

  mkdirSync(join(projectDir, 'docs'), { recursive: true });
  const planInput = buildImplementationPlanInput(ctx.values, plan, sha256Prefix);
  const deckFileName = `${formName}_Implementation_Plan.pptx`;
  const readmeInput = buildReadmeInput(ctx.values, plan, deckFileName);
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
    const deckInput = buildDeckInput(ctx.values, plan);
    pptxPath = await (deckBuildOverride ?? defaultDeckBuild)(deckInput, projectDir);
  } catch {
    return blocked(
      'build-check-failed',
      'The implementation-plan deck could not be built. This indicates the tooling, not the request — file it with the backend team.',
    );
  }
  const docs = ['README.md', 'docs/Implementation-Plan.md', 'docs/troubleshooting.md', 'original/README.md'];
  return done(
    { 'artifacts.docs': docs, 'artifacts.deck': pptxPath, 'verify.rebuildOk': true },
    'rebuild=ok',
  );
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

async function openPr({ ctx }: StepHandlerContext): Promise<StepResult> {
  const plan = ctx.values['plan'] as CustomizationPlan;
  const projectDir = ctx.values['project.dir'] as string;
  const formName = ctx.values['validated.formName'] as string;
  const title = ctx.values['request.title'] as string;
  const repo = ctx.values['repo'] as string;
  const changeBullets = [
    ...plan.fields.map((f) => `New ${f.kind} field "${f.caption}" (${f.field}) on ${f.container}`),
    ...plan.relabels.map((r) => `Relabeled ${r.component} to "${r.newCaption}"`),
    ...plan.resizes.map((r) => `Resized ${r.component}`),
  ];
  const branch = `form-ai/${formName.toLowerCase()}-${ctx.runId.slice(0, 8)}`;
  const prTitle = `[SyteLine Form AI Agent] ${title} (${formName})`;
  const prBody = [
    `Built by the SyteLine Form AI Agent from request \`${ctx.runId.slice(0, 8)}\`.`,
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
  return done({ 'pr.url': opened.prUrl, 'pr.repo': repo }, `repo=${repo}`);
}

// ---------------------------------------------------------------------------
// Registries (the flow definition references these by string ref)
// ---------------------------------------------------------------------------

export const STEP_HANDLERS: Record<string, StepHandler> = {
  intake,
  'validate-inputs': validateInputs,
  'backup-originals': backupOriginals,
  'compare-trn-prd': compareTrnPrd,
  'plan-changes': planChanges,
  'apply-changes-trn': applyChangesTrn,
  verify,
  'open-pr': openPr,
};

export const PROMPT_BUILDERS: Record<
  string,
  (values: Record<string, unknown>) => { systemPrompt: string; userMessage: string }
> = {
  'plan-changes': (values) => ({
    systemPrompt: CUSTOMIZATION_PLANNER_SYSTEM_PROMPT,
    userMessage: buildPlanUserMessage(values),
  }),
};

export const SCHEMAS: Record<string, z.ZodType<unknown>> = {
  'customization-plan': customizationPlanSchema,
};

export const PRECONDITION_CHECKS: Record<
  string,
  (ctx: FlowRunContext) => Promise<{ ok: boolean; detail?: string }>
> = {
  'requester-holds-forms-permission': async (ctx) => {
    const auth = await liveRequesterAuth({
      _id: ctx.runId,
      requesterUserId: ctx.actor.userId,
      tenantId: ctx.actor.tenantId,
    }).catch(() => null);
    if (!auth || !auth.permissions.includes('syteline:forms')) return { ok: false };
    return { ok: true };
  },
  'github-available': async () => ({ ok: githubPrAvailable() }),
};

/** Remove a staged inbox (best-effort cleanup after backup-originals). */
export function cleanupInbox(inboxDir: string): void {
  try {
    rmSync(inboxDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
