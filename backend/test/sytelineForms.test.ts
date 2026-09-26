/**
 * sytelineForms.test.ts — SyteLine form-project automation (ports of
 * Enflite/Form-Project-Templates `scripts/new-project.sh` and
 * `tools/apply_form_changes.py`).
 *
 * Covers:
 *  1. Naming: the Uf_ENF_* / ENF_* standard and its hard guards.
 *  2. Parsing: component index, tabs, IDO qualifier/name from a form export.
 *  3. Export guards: BOM + CRLF byte-for-byte checks.
 *  4. Build: text-level insertion in alphabetical order, purple
 *     highlighting, grid columns, deterministic rebuild (--check semantics).
 *  5. Scaffold: new-project.sh port — substitution, branding copy,
 *     refusal rules.
 *  6. Docs: seven-phase plan structure, original-comparison verdict.
 *  7. Deck config: generated config loads and carries the project content.
 *  8. Tool registration + authorization: the five tools need
 *     'syteline:forms'.
 *  9. STOP guard: form_add_field refuses when TRN/production originals differ.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  FORM_XML_BOM,
  CRLF,
  PURPLE_LABEL,
  PURPLE_DATA,
  assertExportBytes,
  buildFormXml,
  checkDeterministic,
  decodeExport,
  encodeExport,
  formatNumber,
  parseFormXml,
  renderFormXml,
  sha256Hex,
} from '../src/syteline/forms/formXml.js';
import {
  assertUetClassName,
  assertUetFieldName,
  componentNames,
  componentStem,
  formBinding,
  toPascalCase,
  uetClassName,
  uetFieldName,
} from '../src/syteline/forms/naming.js';
import { scaffoldProject } from '../src/syteline/forms/scaffold.js';
import {
  renderImplementationPlan,
  renderOriginalReadme,
  renderReadme,
  renderTroubleshooting,
} from '../src/syteline/forms/projectDocs.js';
import { renderDeckConfig } from '../src/syteline/forms/deck.js';
import { openPr } from '../src/syteline/forms/github.js';
import { sytelineFormToolDefinitions } from '../src/tools/sytelineForms.js';
import { authorizeTool, getTool } from '../src/tools/gateway.js';
import { authFor, TENANT_A, USER_A1 } from './helpers/securityFixtures.js';
import type { Permission } from '../src/authz/permissions.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal form export: CRLF + fds_DataSource + one tab + two components. */
function fixtureExport(): string {
  const lines = [
    `<?xml version="1.0" encoding="utf-8"?>`,
    `<Form Name="TestForm">`,
    `         <Variables>`,
    `            <Variable Name="fds_DataSource">`,
    `               <Value>SL.SLLots</Value>`,
    `            </Variable>`,
    `         </Variables>`,
    `         <Components>`,
    `            <Component Name="Tab1">`,
    `               <DeviceID>-1</DeviceID>`,
    `               <Type>13</Type>`,
    `               <TabOrder>0</TabOrder>`,
    `               <TopPos>0</TopPos>`,
    `               <LeftPos>0</LeftPos>`,
    `               <Height>10</Height>`,
    `               <ListHeight>2</ListHeight>`,
    `               <Width>50</Width>`,
    `               <Caption>s&General</Caption>`,
    `               <MaxCharacters>0</MaxCharacters>`,
    `               <ContainerName />`,
    `               <ContainerSequence>0</ContainerSequence>`,
    `               <Binding>0</Binding>`,
    `            </Component>`,
    `            <Component Name="SourceEdit">`,
    `               <DeviceID>-1</DeviceID>`,
    `               <Type>1</Type>`,
    `               <TabOrder>5</TabOrder>`,
    `               <TopPos>25.6555555555556</TopPos>`,
    `               <LeftPos>34.4285714285714</LeftPos>`,
    `               <Height>1.3</Height>`,
    `               <ListHeight>2</ListHeight>`,
    `               <Width>22</Width>`,
    `               <Caption>C(SourceStatic)</Caption>`,
    `               <MaxCharacters>0</MaxCharacters>`,
    `               <ContainerName>Tab1</ContainerName>`,
    `               <ContainerSequence>20</ContainerSequence>`,
    `               <DataSource>object.lot.Source</DataSource>`,
    `               <Binding>1</Binding>`,
    `            </Component>`,
    `            <Component Name="GridColA">`,
    `               <DeviceID>-1</DeviceID>`,
    `               <Type>15</Type>`,
    `               <TabOrder>6</TabOrder>`,
    `               <TopPos>0</TopPos>`,
    `               <LeftPos>100</LeftPos>`,
    `               <Height>28.8666667938232</Height>`,
    `               <ListHeight>2</ListHeight>`,
    `               <Width>14</Width>`,
    `               <Caption>A</Caption>`,
    `               <MaxCharacters>0</MaxCharacters>`,
    `               <ContainerName>FormCollectionGrid</ContainerName>`,
    `               <ContainerSequence>30</ContainerSequence>`,
    `               <DataSource>object.lot.A</DataSource>`,
    `               <Binding>1</Binding>`,
    `            </Component>`,
    `         </Components>`,
    `</Form>`,
  ];
  return lines.join(CRLF) + CRLF;
}

function newFieldSpec() {
  return {
    field: 'Uf_ENF_Test',
    caption: 'Test',
    kind: 'text' as const,
    stem: componentStem('Uf_ENF_Test'),
    container: 'Tab1',
    top: 25.6555555555556,
    labelLeft: 26,
    labelWidth: 7.5,
    editLeft: 34.4285714285714,
    editWidth: 22,
  };
}

function buildSpec(): {
  formName: string;
  aliasPrefix: string;
  newFields: ReturnType<typeof newFieldSpec>[];
  relabels: Array<{ component: string; newCaption: string }>;
  resizes: Array<{ component: string; changes: Record<string, number | string> }>;
  addGridColumns: boolean;
  highlight: boolean;
} {
  return {
    formName: 'TestForm',
    aliasPrefix: 'lot',
    newFields: [newFieldSpec()],
    relabels: [],
    resizes: [],
    addGridColumns: true,
    highlight: true,
  };
}

// ---------------------------------------------------------------------------
// 1. Naming
// ---------------------------------------------------------------------------

describe('naming (Enflite UET standard)', () => {
  it('derives UET names from labels', () => {
    expect(uetFieldName('Test')).toBe('Uf_ENF_Test');
    expect(uetFieldName('date of manufacture')).toBe('Uf_ENF_DateOfManufacture');
    expect(uetClassName('Lot')).toBe('ENF_Lot');
    expect(toPascalCase('source code')).toBe('SourceCode');
  });

  it('derives component names from the field', () => {
    expect(componentStem('Uf_ENF_Test')).toBe('UfTest');
    expect(componentNames('Uf_ENF_Test')).toEqual({
      static: 'UfTestStatic',
      edit: 'UfTestEdit',
      gridCol: 'UfTestGridCol',
    });
    expect(formBinding('lot', 'Uf_ENF_Test')).toBe('object.lotUf_ENF_Test');
  });

  it('guards reject non-UET names', () => {
    expect(() => assertUetFieldName('Uf_Test')).toThrow();
    expect(() => assertUetFieldName('Test')).toThrow();
    expect(() => assertUetFieldName('Uf_ENF_test')).toThrow();
    expect(() => assertUetFieldName('Uf_ENF_')).toThrow();
    expect(() => assertUetClassName('Lot')).toThrow();
    expect(() => assertUetFieldName('Uf_ENF_Test')).not.toThrow();
    expect(() => assertUetClassName('ENF_Lot')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Parsing
// ---------------------------------------------------------------------------

describe('formXml parsing', () => {
  it('builds a component index with tabs and the IDO', () => {
    const parsed = parseFormXml(fixtureExport());
    expect(parsed.formName).toBe('TestForm');
    expect(parsed.idoQualifier).toBe('SL');
    expect(parsed.idoName).toBe('SLLots');
    expect(parsed.components.get('SourceEdit')?.dataSource).toBe('object.lot.Source');
    expect(parsed.components.get('SourceEdit')?.containerName).toBe('Tab1');
    expect(parsed.tabs).toEqual([{ name: 'Tab1', label: 'General' }]);
    expect(parsed.componentOrder).toEqual(['Tab1', 'SourceEdit', 'GridColA']);
  });
});

// ---------------------------------------------------------------------------
// 3. Export byte guards
// ---------------------------------------------------------------------------

describe('export byte guards', () => {
  it('accepts a byte-for-byte export', () => {
    const bytes = Buffer.concat([FORM_XML_BOM, Buffer.from('a\r\nb\r\n', 'utf8')]);
    expect(() => assertExportBytes(bytes, 'original')).not.toThrow();
  });

  it('refuses exports that lost the BOM', () => {
    expect(() => assertExportBytes(Buffer.from('a\r\n', 'utf8'), 'original')).toThrow(
      /missing UTF-8 BOM/,
    );
  });

  it('refuses LF-only and mixed line endings', () => {
    const bom = FORM_XML_BOM;
    expect(() =>
      assertExportBytes(Buffer.concat([bom, Buffer.from('a\nb\n', 'utf8')]), 'original'),
    ).toThrow(/no CRLF/);
    expect(() =>
      assertExportBytes(Buffer.concat([bom, Buffer.from('a\r\nb\n', 'utf8')]), 'original'),
    ).toThrow(/mixed line endings/);
  });

  it('round-trips BOM and CRLF through decode/encode', () => {
    const bytes = Buffer.concat([FORM_XML_BOM, Buffer.from('<x>\r\n</x>\r\n', 'utf8')]);
    const text = decodeExport(bytes);
    expect(text).not.toContain('\uFEFF');
    expect(text).toContain('\r\n');
    expect(encodeExport(text).equals(bytes)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Build
// ---------------------------------------------------------------------------

describe('formXml build (apply_form_changes port)', () => {
  it('formats coordinates like the template script (13 decimals, trimmed)', () => {
    expect(formatNumber(25.6555555555556)).toBe('25.6555555555556');
    expect(formatNumber(26)).toBe('26');
    expect(formatNumber(25.6555555555556 + 0.3)).toBe('25.9555555555556');
    expect(formatNumber(8.42857142857143)).toBe('8.4285714285714'); // matches Python round(v,13)
  });

  it('inserts components in alphabetical order with purple highlighting', () => {
    const out = buildFormXml(decodeExport(encodeExport(fixtureExport())), buildSpec());
    const order = [...out.matchAll(/^ {12}<Component Name="([^"]+)">/gm)].map((m) => m[1]);
    expect(order).toEqual(['Tab1', 'SourceEdit', 'GridColA', 'UfTestEdit', 'UfTestGridCol', 'UfTestStatic']);

    const edit = out.match(/<Component Name="UfTestEdit">(.*?)<\/Component>/s)![1];
    expect(edit).toContain('<DataSource>object.lotUf_ENF_Test</DataSource>');
    expect(edit).toContain('<Caption>C(UfTestStatic)</Caption>');
    expect(edit).toContain(`<Post301Format>${PURPLE_DATA}</Post301Format>`);

    const label = out.match(/<Component Name="UfTestStatic">(.*?)<\/Component>/s)![1];
    expect(label).toContain(`<Post301Format>JUSTIFY(R) ${PURPLE_LABEL}</Post301Format>`);
    expect(label).toContain('<TopPos>25.9555555555556</TopPos>');

    const col = out.match(/<Component Name="UfTestGridCol">(.*?)<\/Component>/s)![1];
    expect(col).toContain('<ContainerName>FormCollectionGrid</ContainerName>');
    expect(col).toContain('<LeftPos>114</LeftPos>'); // appended after the existing column
    expect(col).toContain('<Type>15</Type>');
  });

  it('is byte-stable: rebuilds deterministically and passes the check', () => {
    const originalBytes = encodeExport(fixtureExport());
    const spec = buildSpec();
    const first = renderFormXml(originalBytes, spec);
    const second = renderFormXml(originalBytes, spec);
    expect(first.equals(second)).toBe(true);
    expect(first.subarray(0, 3).equals(FORM_XML_BOM)).toBe(true);
    expect(first.subarray(3).toString('utf8')).not.toContain('\uFEFF');
    const text = first.subarray(3).toString('utf8');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(checkDeterministic(originalBytes, spec, first)).toBe(true);
    const tampered = Buffer.concat([first.subarray(0, 100), Buffer.from('x'), first.subarray(101)]);
    expect(checkDeterministic(originalBytes, spec, tampered)).toBe(false);
  });

  it('refuses non-UET bindings and unset aliases', () => {
    const bad = buildSpec();
    bad.newFields[0]!.field = 'Source';
    expect(() => buildFormXml(decodeExport(encodeExport(fixtureExport())), bad)).toThrow(/naming standard/);
    const noAlias = buildSpec();
    noAlias.aliasPrefix = '<alias>';
    expect(() => buildFormXml(decodeExport(encodeExport(fixtureExport())), noAlias)).toThrow(/alias/);
  });

  it('refuses duplicate components and unknown relabel targets', () => {
    const out1 = buildFormXml(decodeExport(encodeExport(fixtureExport())), buildSpec());
    // Adding the same field twice collides with the newly added component.
    expect(() => buildFormXml(out1, buildSpec())).toThrow(/already exists/);
    const bad = buildSpec();
    bad.relabels = [{ component: 'Nope', newCaption: 'X' }];
    expect(() => buildFormXml(decodeExport(encodeExport(fixtureExport())), bad)).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// 5. Scaffold
// ---------------------------------------------------------------------------

describe('scaffold (new-project.sh port)', () => {
  const tmp = join(tmpdir(), 'scaffold-test');

  function fakeTemplate(): string {
    const root = join(tmp, 'tpl');
    rmSync(root, { recursive: true, force: true });
    const pt = join(root, 'project-template');
    mkdirSync(join(pt, 'tools'), { recursive: true });
    mkdirSync(join(pt, 'plan'), { recursive: true });
    mkdirSync(join(root, 'branding', 'assets'), { recursive: true });
    mkdirSync(join(root, 'branding', 'icons'), { recursive: true });
    writeFileSync(join(pt, 'AGENTS.md'), '# SOP master copy — stays identical\n');
    writeFileSync(join(pt, 'README.md'), '# {{REPO}}\n\nForm: {{FORM}}. Title: {{TITLE}}. Lower: {{REPO_LOWER}}.\n');
    writeFileSync(join(pt, 'tools', 'apply_form_changes.py'), '# {{FORM}} build\n');
    writeFileSync(join(pt, 'plan', 'deck.config.js'), 'module.exports = { title: "{{TITLE}}" };\n');
    writeFileSync(join(root, 'branding', 'assets', 'enflite-logo.png'), 'logo-bytes');
    writeFileSync(join(root, 'branding', 'icons', 'i1_white.png'), 'icon-bytes');
    writeFileSync(join(root, 'branding', 'icons', 'README.md'), '# icons\n');
    return root;
  }

  beforeEach(() => rmSync(tmp, { recursive: true, force: true }));
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('substitutes placeholders and copies brand assets', () => {
    const dest = join(tmp, 'proj');
    const created = scaffoldProject({
      formName: 'Lots',
      title: 'Create Test Field In Purple',
      repo: 'Enflite/Lots',
      destDir: dest,
      templateDir: fakeTemplate(),
      date: '2026-09-25',
    });
    const readme = readFileSync(join(dest, 'README.md'), 'utf8');
    expect(readme).toContain('# Enflite/Lots');
    expect(readme).toContain('Form: Lots. Title: Create Test Field In Purple. Lower: enflite/lots.');
    expect(readme).not.toContain('{{');
    // AGENTS.md is never substituted.
    expect(readFileSync(join(dest, 'AGENTS.md'), 'utf8')).toContain('stays identical');
    // Brand assets land in plan/.
    expect(existsSync(join(dest, 'plan', 'brand', 'enflite-logo.png'))).toBe(true);
    expect(existsSync(join(dest, 'plan', 'icons', 'i1_white.png'))).toBe(true);
    expect(created.length).toBeGreaterThan(0);
  });

  it('refuses to overwrite an existing project', () => {
    const dest = join(tmp, 'proj');
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'Lots.xml'), '<x/>');
    expect(() =>
      scaffoldProject({ formName: 'Lots', title: 'T', destDir: dest, templateDir: fakeTemplate() }),
    ).toThrow(/already has project files/);
  });

  it('refuses non-xml files in original/', () => {
    const dest = join(tmp, 'proj');
    mkdirSync(join(dest, 'original'), { recursive: true });
    writeFileSync(join(dest, 'original', 'notes.txt'), 'x');
    expect(() =>
      scaffoldProject({ formName: 'Lots', title: 'T', destDir: dest, templateDir: fakeTemplate() }),
    ).toThrow(/other than .xml/);
  });

  it('rejects bad form names', () => {
    expect(() =>
      scaffoldProject({ formName: 'Lots!', title: 'T', destDir: join(tmp, 'p2'), templateDir: fakeTemplate() }),
    ).toThrow(/letters, digits or _/);
  });
});

// ---------------------------------------------------------------------------
// 6. Docs
// ---------------------------------------------------------------------------

function planInput() {
  return {
    formName: 'Lots',
    title: 'Create Test Field In Purple',
    repo: 'Enflite/Lots',
    summary: 'adds a "Test" text field to the Lots form.',
    goal: 'Add a Test field to the General tab of the Lots form.',
    ido: 'SLLots',
    table: 'lot',
    mstTable: 'lot_mst',
    alias: 'lot',
    aliasAssumed: true,
    status: 'Requested.',
    sourceNote: "Jake's written request (2026-09-25).",
    scopeRows: [
      { tab: 'General', onForm: 'Test', field: 'Uf_ENF_Test', type: 'Text', source: 'Added by this project' },
    ],
    layoutNote: 'Test sits to the right of Source.',
    brd: [{ id: 'BRD-1', requirement: 'Add Test field', detail: 'Text field.' }],
    openItems: [{ item: 'Confirm the lot alias', blocks: 'Form binding' }],
    uetFields: [
      {
        name: 'Uf_ENF_Test',
        userDataType: 'DescriptionType*',
        dataType: 'Text',
        precision: '30*',
        description: 'Test field.',
        assumedNote: 'assumed User Data Type; confirm on the UET User Fields form',
      },
    ],
    uetClass: { name: 'ENF_Lot', label: 'Lot', description: 'UET class for Lot custom fields.' },
    bindingExample: 'lotUf_ENF_Test',
    formBuildBullets: ['3 new components.'],
    testChecklist: ['Enter a value; it persists.'],
    releaseLine: '**2026-09-25:** Project started.',
    tabLabel: 'General',
  };
}

describe('projectDocs', () => {
  it('renders the seven phases in order with TRN-first and assumptions', () => {
    const md = renderImplementationPlan(planInput());
    const phases = ['## 1. Scope', '## 2. Design', '## 3. Develop', '## 4. Staging', '## 5. Launch', '## 6. Test', '## 7. Optimize'];
    const idx = phases.map((p) => md.indexOf(p));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(md).toContain('Build and test in **TRN** first');
    expect(md).toContain('**assumed**; confirm in Staging, check A');
    expect(md).toContain('never over the Vendor form');
  });

  it('original README verdicts: identical vs stop', () => {
    const same = renderOriginalReadme({
      formName: 'Lots',
      trnExportedNote: '2026-09-25',
      prdExportedNote: '2026-09-25',
      identical: true,
      shaPrefix: 'c83177c6dc8fed4e',
    });
    expect(same).toContain('no local form changes');
    const diff = renderOriginalReadme({
      formName: 'Lots',
      trnExportedNote: '2026-09-25',
      prdExportedNote: '2026-09-25',
      identical: false,
      shaPrefix: 'deadbeef',
    });
    expect(diff).toContain('**Stop**');
  });

  it('renders the README layout and troubleshooting template', () => {
    const readme = renderReadme({
      repo: 'Enflite/Lots',
      formName: 'Lots',
      tagline: 'SyteLine — Lots form changes.',
      changeBullets: ['Adds a Test field.'],
      releaseLines: ['**2026-09-25:** started.'],
      deckFileName: 'Lots_Implementation_Plan.pptx',
      buildCommandNote: 'npm run build',
    });
    expect(readme).toContain('| Path | What |');
    expect(readme).toContain('## Release');
    expect(renderTroubleshooting('Lots')).toContain('Only write **Confirmed**');
  });
});

// ---------------------------------------------------------------------------
// 7. Deck config
// ---------------------------------------------------------------------------

describe('deck config', () => {
  it('generates a loadable deck.config.js with the project content', () => {
    const dir = join(tmpdir(), 'deck-test');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const cfgPath = join(dir, 'deck.config.js');
    writeFileSync(
      cfgPath,
      renderDeckConfig({
        formName: 'Lots',
        title: 'Create Test Field In Purple',
        subtitle: 'Implementation plan.',
        fileName: 'Lots_Implementation_Plan.pptx',
        brd: [['BRD-1', 'Add Test', 'Text field']],
        scope: { sub: 'Scope sub', flow: ['a', 'b'] },
        design: ['row'],
        develop: ['dev'],
        formsync: ['fs'],
        staging: ['st'],
        launch: ['la'],
        test: ['te'],
        optimize: ['op'],
        rollback: ['rb'],
        phases: [['Scope', ['one']], ['Design', ['two']]],
      }),
      'utf8',
    );
    const cfg = createRequire(import.meta.url)(cfgPath);
    expect(cfg.title).toBe('Lots — Create Test Field In Purple');
    expect(cfg.fileName).toBe('Lots_Implementation_Plan.pptx');
    expect(cfg.phases).toHaveLength(2);
    expect(cfg.brd[0][0]).toBe('BRD-1');
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// 8. Tool registration + authorization
// ---------------------------------------------------------------------------

const FORM_TOOLS = [
  'syteline.form_start_project',
  'syteline.form_add_field',
  'syteline.form_write_docs',
  'syteline.form_build_deck',
  'syteline.form_open_pr',
];

describe('form tool registration and authorization', () => {
  it('registers the five tools with the syteline:forms gate', () => {
    for (const name of FORM_TOOLS) {
      const def = getTool(name);
      expect(def.permission).toBe('syteline:forms');
    }
    const registered = sytelineFormToolDefinitions.map((d) => d.name).sort();
    expect(registered).toEqual([...FORM_TOOLS].sort());
  });

  it('denies callers without syteline:forms (TOOL_FORBIDDEN)', () => {
    const auth = authFor(USER_A1, TENANT_A, {
      permissions: ['chat:create', 'tool:use', 'syteline:read'] as Permission[],
    });
    expect(() =>
      authorizeTool(auth, 'syteline.form_add_field', { projectDir: 'x' }, 'INTERNAL', false),
    ).toThrowError(expect.objectContaining({ code: 'TOOL_FORBIDDEN' }));
  });

  it('authorizes a caller with syteline:forms and validates the schema', () => {
    const auth = authFor(USER_A1, TENANT_A, {
      permissions: ['chat:create', 'tool:use', 'syteline:forms'] as Permission[],
    });
    const { definition, input } = authorizeTool(
      auth,
      'syteline.form_start_project',
      { projectDir: 'Lots', formName: 'Lots', title: 'T' },
      'INTERNAL',
      false,
    );
    expect(definition.name).toBe('syteline.form_start_project');
    expect((input as { formName: string }).formName).toBe('Lots');
    expect(() =>
      authorizeTool(auth, 'syteline.form_add_field', { projectDir: '../escape' }, 'INTERNAL', false),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TOOL_PARAMETERS' }));
  });

  it('grants syteline:forms to Admin, AI Admin, and Developer roles', async () => {
    const { ROLE_PERMISSIONS } = await import('../src/authz/permissions.js');
    expect(ROLE_PERMISSIONS['AI Admin']).toContain('syteline:forms');
    expect(ROLE_PERMISSIONS['Developer']).toContain('syteline:forms');
    expect(ROLE_PERMISSIONS['Admin']).toContain('syteline:forms');
    expect(ROLE_PERMISSIONS['User']).not.toContain('syteline:forms');
  });
});

// ---------------------------------------------------------------------------
// 9. form_add_field tool: STOP guard + deterministic write
// ---------------------------------------------------------------------------

describe('form_add_field tool', () => {
  const projectsRoot = join(process.cwd(), 'form-projects');
  const projectName = 'test-lots-proj';
  const projectDir = join(projectsRoot, projectName);
  const ctx = {
    auth: authFor(USER_A1, TENANT_A, {
      permissions: ['chat:create', 'tool:use', 'syteline:forms'] as Permission[],
    }),
    classification: 'INTERNAL' as const,
  };
  const signal = AbortSignal.timeout(30_000);

  function writeOriginal(name: string, text: string) {
    mkdirSync(join(projectDir, 'original'), { recursive: true });
    writeFileSync(join(projectDir, 'original', name), encodeExport(text));
  }

  beforeEach(() => {
    rmSync(projectDir, { recursive: true, force: true });
    writeOriginal('Lots.trn.original.xml', fixtureExport());
  });
  afterEach(() => rmSync(projectDir, { recursive: true, force: true }));

  function baseInput(extra: Record<string, unknown> = {}) {
    return {
      projectDir: projectName,
      originalFile: 'Lots.trn.original.xml',
      aliasPrefix: 'lot',
      fields: [
        {
          field: 'Uf_ENF_Test',
          caption: 'Test',
          kind: 'text',
          container: 'Tab1',
          top: 25.6555555555556,
          labelLeft: 26,
          labelWidth: 7.5,
          editLeft: 34.4285714285714,
          editWidth: 22,
        },
      ],
      ...extra,
    };
  }

  it('stops when TRN and production originals differ', async () => {
    writeOriginal('Lots.production.original.xml', fixtureExport().replace('SourceEdit', 'SourceEdited'));
    const def = getTool('syteline.form_add_field');
    await expect(
      def.execute(baseInput({ prdOriginalFile: 'Lots.production.original.xml' }), ctx, signal),
    ).rejects.toThrowError(expect.objectContaining({ code: 'FORM_ORIGINALS_DIFFER' }));
    expect(existsSync(join(projectDir, 'Lots.xml'))).toBe(false);
  });

  it('writes the form when the originals match, and checkOnly verifies', async () => {
    const trn = await sha256Hex(encodeExport(fixtureExport()));
    writeFileSync(join(projectDir, 'original', 'Lots.production.original.xml'), encodeExport(fixtureExport()));
    const def = getTool('syteline.form_add_field');
    const result = (await def.execute(
      baseInput({ prdOriginalFile: 'Lots.production.original.xml' }),
      ctx,
      signal,
    )) as { written: string; prdIdentical: boolean; shaPrefix: string; components: string[] };
    expect(result.prdIdentical).toBe(true);
    expect(result.shaPrefix).toBe(trn.slice(0, 16));
    expect(result.components).toEqual(['UfTestStatic', 'UfTestEdit', 'UfTestGridCol']);
    expect(existsSync(result.written)).toBe(true);
    // --check semantics: committed file matches the rebuild.
    const check = (await def.execute(
      { ...baseInput(), checkOnly: true },
      ctx,
      signal,
    )) as { deterministic: boolean };
    expect(check.deterministic).toBe(true);
    // Tamper: checkOnly now fails.
    const tampered = readFileSync(result.written);
    tampered[500] = tampered[500]! ^ 0xff;
    writeFileSync(result.written, tampered);
    await expect(def.execute({ ...baseInput(), checkOnly: true }, ctx, signal)).rejects.toThrowError(
      expect.objectContaining({ code: 'FORM_XML_NOT_DETERMINISTIC' }),
    );
  });

  it('rejects paths escaping the projects root', async () => {
    const def = getTool('syteline.form_add_field');
    await expect(
      def.execute(baseInput({ projectDir: '../outside' }), ctx, signal),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 10. github: never merges, needs credentials to publish
// ---------------------------------------------------------------------------

describe('github helpers', () => {
  it('openPr requires a token instead of failing opaquely', async () => {
    const saved = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    await expect(openPr('Enflite/Lots', 't', 'b', 'main', {})).rejects.toThrow(/GITHUB_TOKEN/);
    if (saved !== undefined) process.env.GITHUB_TOKEN = saved;
  });
});
