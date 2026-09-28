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
 * 10. Multi-field insertion ordering (alphabetical, adjacent, per-field binding).
 * 11. Caption-only relabel: only the caption line changes.
 * 12. Field kind mapping: date/dropdown/notes; yes-no refused, not invented.
 * 13. Missing anchor: descriptive error, no partial state, no output file.
 * 14. Duplicate field refused (same field twice, stem collision, rebuild).
 * 15. Highlight removal: stripping purple yields the plain build exactly.
 * 16. Grid column sequencing: ContainerSequence/LeftPos after the last column.
 * 17. Malformed export: parse throws descriptively; no output file.
 * 18. Alias override: binds object.<alias>Uf_ENF_<Name>.
 * 19. Determinism: byte-identical rebuilds; empty-spec rebuild is a fixed point.
 * 20. TabOrder uniqueness across old and new components.
 * 21. Incremental second add leaves the first field byte-identical.
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
  type NewFieldSpec,
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
  newFields: NewFieldSpec[];
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

function alphaFieldSpec() {
  return {
    field: 'Uf_ENF_Alpha',
    caption: 'Alpha',
    kind: 'text' as const,
    stem: componentStem('Uf_ENF_Alpha'),
    container: 'Tab1',
    top: 27.1222222222222,
    labelLeft: 26,
    labelWidth: 7.5,
    editLeft: 34.4285714285714,
    editWidth: 22,
  };
}

function zetaFieldSpec() {
  return {
    field: 'Uf_ENF_Zeta',
    caption: 'Zeta',
    kind: 'text' as const,
    stem: componentStem('Uf_ENF_Zeta'),
    container: 'Tab1',
    top: 28.5888888888889,
    labelLeft: 26,
    labelWidth: 7.5,
    editLeft: 34.4285714285714,
    editWidth: 22,
  };
}

/** Raw body of one component block (between the tags), or throws. */
function componentBody(text: string, name: string): string {
  const m = text.match(new RegExp(`<Component Name="${name}">(.*?)</Component>`, 's'));
  if (!m) throw new Error(`test setup: component ${name} missing from built XML`);
  return m[1]!;
}

/** Component names in document order in built XML. */
function documentOrder(text: string): string[] {
  return [...text.matchAll(/^ {12}<Component Name="([^"]+)">/gm)].map((m) => m[1]!);
}

/** How many `<Component Name="X">` blocks the text holds. */
function componentCount(text: string, name: string): number {
  return text.split(`<Component Name="${name}">`).length - 1;
}

/** Field input shape for the syteline.form_add_field tool. */
function toolFieldInput() {
  return {
    field: 'Uf_ENF_Test',
    caption: 'Test',
    kind: 'text' as const,
    container: 'Tab1',
    top: 25.6555555555556,
    labelLeft: 26,
    labelWidth: 7.5,
    editLeft: 34.4285714285714,
    editWidth: 22,
  };
}

/** Minimal harness for tool-level failure tests (own project dir per block). */
function toolTestProject(name: string) {
  const projectsRoot = join(process.cwd(), 'form-projects');
  const projectDir = join(projectsRoot, name);
  const ctx = {
    auth: authFor(USER_A1, TENANT_A, {
      permissions: ['chat:create', 'tool:use', 'syteline:forms'] as Permission[],
    }),
    classification: 'INTERNAL' as const,
  };
  const signal = AbortSignal.timeout(30_000);
  function writeOriginal(file: string, text: string) {
    mkdirSync(join(projectDir, 'original'), { recursive: true });
    writeFileSync(join(projectDir, 'original', file), encodeExport(text));
  }
  function cleanup() {
    rmSync(projectDir, { recursive: true, force: true });
  }
  return { projectDir, ctx, signal, writeOriginal, cleanup };
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

  it('grants syteline:forms to Admin, AI Admin, Developer, and User roles (default-open)', async () => {
    const { ROLE_PERMISSIONS } = await import('../src/authz/permissions.js');
    expect(ROLE_PERMISSIONS['AI Admin']).toContain('syteline:forms');
    expect(ROLE_PERMISSIONS['Developer']).toContain('syteline:forms');
    expect(ROLE_PERMISSIONS['Admin']).toContain('syteline:forms');
    // Default-open: every user can drive the SyteLine form-project tools.
    // Form-project PRs still require human review (never auto-merged).
    expect(ROLE_PERMISSIONS['User']).toContain('syteline:forms');
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

// ---------------------------------------------------------------------------
// 11. Multi-field insertion ordering
// ---------------------------------------------------------------------------

describe('multi-field insertion ordering', () => {
  it('places each field trio in alphabetical document order, adjacent to its anchor region', () => {
    const spec = buildSpec();
    spec.newFields = [alphaFieldSpec(), zetaFieldSpec()];
    const out = buildFormXml(fixtureExport(), spec);
    const order = documentOrder(out);
    expect(order).toEqual([
      'Tab1',
      'SourceEdit',
      'GridColA',
      'UfAlphaEdit',
      'UfAlphaGridCol',
      'UfAlphaStatic',
      'UfZetaEdit',
      'UfZetaGridCol',
      'UfZetaStatic',
    ]);
    // Each trio lands adjacent to the anchor region (right after the last
    // existing component) in the right relative order.
    const anchorIdx = order.indexOf('GridColA');
    expect(order.indexOf('UfAlphaEdit')).toBe(anchorIdx + 1);
    expect(order.indexOf('UfAlphaStatic')).toBe(anchorIdx + 3);
    expect(order.indexOf('UfZetaEdit')).toBe(anchorIdx + 4);
    expect(order.indexOf('UfZetaStatic')).toBe(anchorIdx + 6);
    // Bindings stay per-field.
    expect(componentBody(out, 'UfAlphaEdit')).toContain(
      '<DataSource>object.lotUf_ENF_Alpha</DataSource>',
    );
    expect(componentBody(out, 'UfZetaEdit')).toContain(
      '<DataSource>object.lotUf_ENF_Zeta</DataSource>',
    );
  });

  it('appends grid columns in field order without overlap', () => {
    const spec = buildSpec();
    spec.newFields = [alphaFieldSpec(), zetaFieldSpec()];
    const out = buildFormXml(fixtureExport(), spec);
    // GridColA: left 100, width 14 -> first new column at 114, second at 128.
    expect(componentBody(out, 'UfAlphaGridCol')).toContain('<LeftPos>114</LeftPos>');
    expect(componentBody(out, 'UfZetaGridCol')).toContain('<LeftPos>128</LeftPos>');
  });
});

// ---------------------------------------------------------------------------
// 12. Caption-only relabel
// ---------------------------------------------------------------------------

describe('caption-only relabel', () => {
  it('changes only the caption line; binding and validators stay byte-identical', () => {
    const spec = buildSpec();
    spec.newFields = [];
    spec.relabels = [{ component: 'SourceEdit', newCaption: 'Origin' }];
    spec.highlight = false;
    const before = componentBody(fixtureExport(), 'SourceEdit').split(CRLF);
    const after = componentBody(buildFormXml(fixtureExport(), spec), 'SourceEdit').split(CRLF);
    expect(after.length).toBe(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['               <Caption>Origin</Caption>']);
    const body = after.join(CRLF);
    expect(body).toContain('<DataSource>object.lot.Source</DataSource>');
    expect(body).toContain('<Binding>1</Binding>');
  });
});

// ---------------------------------------------------------------------------
// 13. Field kind mapping
// ---------------------------------------------------------------------------

describe('field kind mapping', () => {
  function buildOne(field: NewFieldSpec): string {
    const spec = buildSpec();
    spec.newFields = [field];
    return buildFormXml(fixtureExport(), spec);
  }

  it('maps date to Type 26 with the Date property class', () => {
    const out = buildOne({
      ...newFieldSpec(),
      field: 'Uf_ENF_Dob',
      caption: 'DOB',
      kind: 'date' as const,
      stem: componentStem('Uf_ENF_Dob'),
    });
    const edit = componentBody(out, 'UfDobEdit');
    expect(edit).toContain('<Type>26</Type>');
    expect(edit).toContain('<PropertyClassName>Date</PropertyClassName>');
    expect(componentBody(out, 'UfDobGridCol')).toContain('<Type>15</Type>');
  });

  it('maps dropdown to Type 27 with the user-defined-type list source', () => {
    const out = buildOne({
      ...newFieldSpec(),
      field: 'Uf_ENF_Status',
      caption: 'Status',
      kind: 'dropdown' as const,
      stem: componentStem('Uf_ENF_Status'),
      userDefinedType: 'ENF_Status',
    });
    const edit = componentBody(out, 'UfStatusEdit');
    expect(edit).toContain('<Type>27</Type>');
    expect(edit).toContain('<DefaultFrom>UserDefinedType(ENF_Status)</DefaultFrom>');
  });

  it('maps notes to Type 18 with no menu and no grid column', () => {
    const out = buildOne({
      ...newFieldSpec(),
      field: 'Uf_ENF_Remarks',
      caption: 'Remarks',
      kind: 'notes' as const,
      stem: componentStem('Uf_ENF_Remarks'),
    });
    const edit = componentBody(out, 'UfRemarksEdit');
    expect(edit).toContain('<Type>18</Type>');
    expect(edit).not.toContain('<MenuName>');
    expect(out).not.toContain('<Component Name="UfRemarksGridCol">');
  });

  it('refuses yes-no instead of emitting an invented checkbox shape', () => {
    const bad = { ...newFieldSpec(), kind: 'yes-no' } as unknown as NewFieldSpec;
    const spec = buildSpec();
    spec.newFields = [bad];
    expect(() => buildFormXml(fixtureExport(), spec)).toThrow(/unsupported field kind "yes-no"/);
  });
});

// ---------------------------------------------------------------------------
// 14. Missing anchor component
// ---------------------------------------------------------------------------

describe('missing anchor component', () => {
  it('throws a descriptive error and leaves no partial state behind', () => {
    const bad = buildSpec();
    bad.relabels = [{ component: 'NoSuchComp', newCaption: 'X' }];
    expect(() => buildFormXml(fixtureExport(), bad)).toThrow(/NoSuchComp.*not found/);
    // The failed build mutated nothing: a valid build still works and is stable.
    const first = buildFormXml(fixtureExport(), buildSpec());
    const second = buildFormXml(fixtureExport(), buildSpec());
    expect(first).toBe(second);
  });

  it('tool level: a bad relabel rejects and writes no output file', async () => {
    const t = toolTestProject('test-anchor-proj');
    t.writeOriginal('Lots.trn.original.xml', fixtureExport());
    try {
      const def = getTool('syteline.form_add_field');
      await expect(
        def.execute(
          {
            projectDir: 'test-anchor-proj',
            originalFile: 'Lots.trn.original.xml',
            aliasPrefix: 'lot',
            fields: [toolFieldInput()],
            relabels: [{ component: 'NoSuchComp', newCaption: 'X' }],
          },
          t.ctx,
          t.signal,
        ),
      ).rejects.toThrow(/NoSuchComp.*not found/);
      expect(existsSync(join(t.projectDir, 'Lots.trn.original.xml'))).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 15. Duplicate field refused
// ---------------------------------------------------------------------------

describe('duplicate field refused', () => {
  it('throws on the same field twice in one spec', () => {
    const spec = buildSpec();
    spec.newFields = [newFieldSpec(), newFieldSpec()];
    expect(() => buildFormXml(fixtureExport(), spec)).toThrow(
      /duplicate new field "Uf_ENF_Test"/,
    );
  });

  it('throws when two fields would generate the same component names', () => {
    const spec = buildSpec();
    // Uf_Test strips to the same UfTest stem as Uf_ENF_Test.
    spec.newFields = [newFieldSpec(), { ...newFieldSpec(), field: 'Uf_Test' }];
    expect(() => buildFormXml(fixtureExport(), spec)).toThrow(
      /duplicate component stem "UfTest"/,
    );
  });

  it('a built field exists exactly once; rebuilding refuses the collision', () => {
    const out = buildFormXml(fixtureExport(), buildSpec());
    for (const n of ['UfTestStatic', 'UfTestEdit', 'UfTestGridCol']) {
      expect(componentCount(out, n)).toBe(1);
    }
    expect(() => buildFormXml(out, buildSpec())).toThrow(/already exists/);
  });
});

// ---------------------------------------------------------------------------
// 16. Highlight removal
// ---------------------------------------------------------------------------

describe('highlight removal', () => {
  it('rebuilds without highlighting and changes nothing else', () => {
    const spec = buildSpec();
    const hi = buildFormXml(fixtureExport(), spec);
    const lo = buildFormXml(fixtureExport(), { ...spec, highlight: false });
    expect(hi).toContain(PURPLE_LABEL);
    expect(hi).toContain(PURPLE_DATA);
    expect(lo).not.toContain('BACKCOLOR');
    expect(lo).not.toContain('FORECOLOR');
    // Stripping the purple keywords from the highlighted build yields the
    // plain build exactly: highlighting is purely additive.
    const normalize = (t: string) =>
      t
        .split(' ' + PURPLE_LABEL)
        .join('')
        .split(PURPLE_DATA)
        .join('')
        .split('<Post301Format></Post301Format>')
        .join('<Post301Format />');
    expect(normalize(hi)).toBe(lo);
  });
});

// ---------------------------------------------------------------------------
// 17. Grid column sequencing
// ---------------------------------------------------------------------------

describe('grid column sequencing', () => {
  it('sequences new columns after the last existing one with no overlap', () => {
    const parsed = parseFormXml(fixtureExport());
    const gridCols = [...parsed.components.values()].filter(
      (c) => c.containerName === 'FormCollectionGrid',
    );
    const maxRight = Math.max(...gridCols.map((c) => c.leftPos + c.width));
    const maxSeq = Math.max(...gridCols.map((c) => c.containerSequence));

    const spec = buildSpec();
    spec.newFields = [alphaFieldSpec(), zetaFieldSpec()];
    const out = buildFormXml(fixtureExport(), spec);
    const aCol = componentBody(out, 'UfAlphaGridCol');
    const zCol = componentBody(out, 'UfZetaGridCol');
    // Text columns are 14 wide: each starts exactly where the previous ends.
    expect(aCol).toContain(`<ContainerSequence>${maxSeq + 1}</ContainerSequence>`);
    expect(aCol).toContain(`<LeftPos>${maxRight}</LeftPos>`);
    expect(zCol).toContain(`<ContainerSequence>${maxSeq + 2}</ContainerSequence>`);
    expect(zCol).toContain(`<LeftPos>${maxRight + 14}</LeftPos>`);
    expect(aCol).toContain('<ContainerName>FormCollectionGrid</ContainerName>');
  });
});

// ---------------------------------------------------------------------------
// 18. Malformed export
// ---------------------------------------------------------------------------

describe('malformed export', () => {
  it('parseFormXml throws a descriptive error on truncated or corrupt input', () => {
    expect(() => parseFormXml('')).toThrow(/not a SyteLine form export/);
    expect(() => parseFormXml('this is not xml')).toThrow(/not a SyteLine form export/);
    expect(() => parseFormXml('<Form Name="Lots">\r\n<Components>\r\n')).toThrow(/truncated/);
    expect(() => parseFormXml(fixtureExport().replace('</Form>', ''))).toThrow(/truncated/);
  });

  it('tool level: a corrupt original rejects and produces no output file', async () => {
    const t = toolTestProject('test-malformed-proj');
    // Byte-valid (BOM + CRLF) but truncated XML: passes the byte guard, fails the parse.
    t.writeOriginal('Lots.trn.original.xml', '<Form Name="Lots">\r\n<Components>\r\n');
    try {
      const def = getTool('syteline.form_add_field');
      await expect(
        def.execute(
          {
            projectDir: 'test-malformed-proj',
            originalFile: 'Lots.trn.original.xml',
            aliasPrefix: 'lot',
            fields: [toolFieldInput()],
          },
          t.ctx,
          t.signal,
        ),
      ).rejects.toThrow(/truncated|not a SyteLine/);
      expect(existsSync(join(t.projectDir, 'Lots.trn.original.xml'))).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// 19. Alias override
// ---------------------------------------------------------------------------

describe('alias override', () => {
  it('binds to the explicit alias, not the assumed one', () => {
    const spec = buildSpec();
    spec.aliasPrefix = 'wh';
    const out = buildFormXml(fixtureExport(), spec);
    expect(componentBody(out, 'UfTestEdit')).toContain(
      '<DataSource>object.whUf_ENF_Test</DataSource>',
    );
    expect(componentBody(out, 'UfTestGridCol')).toContain(
      '<DataSource>object.whUf_ENF_Test</DataSource>',
    );
    expect(out).not.toContain('object.lotUf_ENF_Test');
  });
});

// ---------------------------------------------------------------------------
// 20. Determinism
// ---------------------------------------------------------------------------

describe('determinism', () => {
  it('two builds from the same inputs are byte-identical and pass the check', () => {
    const originalBytes = encodeExport(fixtureExport());
    const spec = buildSpec();
    const a = renderFormXml(originalBytes, spec);
    const b = renderFormXml(originalBytes, spec);
    expect(a.equals(b)).toBe(true);
    expect(checkDeterministic(originalBytes, spec, a)).toBe(true);
  });

  it('rebuilding built XML with an empty spec is a fixed point', () => {
    const originalBytes = encodeExport(fixtureExport());
    const built = renderFormXml(originalBytes, buildSpec());
    const text = decodeExport(built);
    const empty = { ...buildSpec(), newFields: [], relabels: [], resizes: [] };
    expect(buildFormXml(text, empty)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// 21. TabOrder uniqueness
// ---------------------------------------------------------------------------

describe('TabOrder uniqueness', () => {
  it('new components get TabOrders that collide with nothing', () => {
    const spec = buildSpec();
    spec.newFields = [alphaFieldSpec(), zetaFieldSpec()];
    const out = buildFormXml(fixtureExport(), spec);
    const orders = [...out.matchAll(/<TabOrder>(\d+)<\/TabOrder>/g)].map((m) => Number(m[1]));
    expect(new Set(orders).size).toBe(orders.length);
    // The fixture's max TabOrder is 6; the six new components take 7..12.
    const names = [
      'UfAlphaEdit',
      'UfAlphaGridCol',
      'UfAlphaStatic',
      'UfZetaEdit',
      'UfZetaGridCol',
      'UfZetaStatic',
    ];
    const newOrders = names.map((n) =>
      Number(componentBody(out, n).match(/<TabOrder>(\d+)<\/TabOrder>/)![1]),
    );
    expect([...newOrders].sort((a, b) => a - b)).toEqual([7, 8, 9, 10, 11, 12]);
  });
});

// ---------------------------------------------------------------------------
// 22. Incremental second add
// ---------------------------------------------------------------------------

describe('incremental second add', () => {
  it('adds a second field to built XML without disturbing the first', () => {
    const specA = { ...buildSpec(), newFields: [alphaFieldSpec()] };
    const specB = { ...buildSpec(), newFields: [zetaFieldSpec()] };
    const out1 = buildFormXml(fixtureExport(), specA);
    const alphaNames = ['UfAlphaStatic', 'UfAlphaEdit', 'UfAlphaGridCol'];
    const alphaBlocks = alphaNames.map((n) => componentBody(out1, n));
    const out2 = buildFormXml(out1, specB);
    // The first field's components are byte-identical in the second build.
    alphaNames.forEach((n, i) => {
      expect(componentBody(out2, n)).toBe(alphaBlocks[i]);
    });
    // Both fields exist exactly once.
    for (const n of [...alphaNames, 'UfZetaStatic', 'UfZetaEdit', 'UfZetaGridCol']) {
      expect(componentCount(out2, n)).toBe(1);
    }
    expect(componentBody(out2, 'UfZetaEdit')).toContain(
      '<DataSource>object.lotUf_ENF_Zeta</DataSource>',
    );
  });
});
